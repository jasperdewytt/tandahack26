// Browser-side homophene lookup over the build-time index (public/lex.txt).
// Hard constraints: same syllable count, and the positions of closed lips (P),
// lip-on-teeth (F) and rounded lips (W) never change. Exact first, then one near miss.
//
// Options are found for spans of one or two spoken words, and an option can itself be one
// or two words, so the same run of mouth shapes can be re-split ("water bottle" -> "what a bottle").

export interface Entry { key: string; syl: number; cand: boolean }
export interface SpanOptions { exact: string[]; near: string[] }
export interface LipCheck {
  ok: boolean;
  near: number;
  problems: { said: string; wrote: string }[]; // chunks that don't fit the lips
  changed: number[]; // indices into the written words that differ from what was said
  unknown: string[]; // written words not in the pronunciation dictionary
  changedSaid: number; // how many spoken words were replaced
  chunks: { s0: number; s1: number; w0: number; w1: number }[]; // aligned spans: said[s0,s1) ~ wrote[w0,w1)
}

const PROTECTED = new Set(["P", "F", "W"]);
// Unrounded vowels (a, e, i) are hard to tell apart on a muted face, so they share one shape.
// Rounded vowels (O, U, W) and every consonant shape stay distinct.
// A chunk that doesn't match shape-for-shape still fits if its visible pattern matches (see
// pattern()): the SPEC's hard constraints. There's no limit on how many chunks fit that way.
const MAX_NEAR = Infinity;
const normalise = (key: string) => collapse(key.replace(/[EI]/g, "A"));
const VOWELISH = ["A", "E", "O", "I", "U"];
const CONSONANTISH = ["D", "T", "L", "K", "J", "R"];

// Fillers, interjections and one-letter words are never swapped (they turned into "Owe", "Aw").
const PAIR_RANK = 6000;
const SINGLE_RANK = 20000;
const SKIP = new Set(["um", "uh", "erm", "hmm", "mm", "a", "i", "oh", "ah", "aw", "yeah", "yep", "okay", "ok", "well", "like", "so", "just", "um"]);

export class Lexicon {
  forward = new Map<string, Entry>();
  reverse = new Map<string, string[]>();
  rank = new Map<string, number>();

  static async load(url = "/lex.txt"): Promise<Lexicon> {
    const text = await (await fetch(url)).text();
    const lex = new Lexicon();
    let i = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      const [word, raw, syl, star] = line.split(" ");
      const e = { key: normalise(raw), syl: Number(syl), cand: star !== "*" };
      lex.forward.set(word, e);
      lex.rank.set(word, i++);
      if (e.cand) {
        const k = `${e.key}|${e.syl}`;
        const list = lex.reverse.get(k);
        if (list) list.push(word);
        else lex.reverse.set(k, [word]);
      }
    }
    return lex;
  }

  /** Can this spoken word take part in a swap? */
  swappable(word: string): boolean {
    const w = clean(word);
    return w.length > 0 && !SKIP.has(w) && this.forward.has(w);
  }

  private words(key: string, syl: number): string[] {
    return this.reverse.get(`${key}|${syl}`) ?? [];
  }

  /** Mouth shapes of a run of words, or null if any word isn't in the dictionary. */
  shapesOf(ws: string[]): { key: string; syl: number } | null {
    let key = "";
    let syl = 0;
    for (const w of ws) {
      const e = this.forward.get(clean(w));
      if (!e) return null;
      key += e.key;
      syl += e.syl;
    }
    return { key: collapse(key), syl };
  }

  /**
   * Can `wrote` be read off the lips that said `said`? Lines the two up in chunks of 1-3 words
   * on each side (so sounds can be re-split across word boundaries). A chunk fits when its mouth
   * shapes and syllables match, or (once per line) are one non-protected shape off.
   * Returns the chunks that don't fit, so the writer can be told exactly what to fix.
   */
  check(said: string[], wrote: string[]): LipCheck {
    const S = said.map(clean).filter(Boolean);
    const W = wrote.map(clean).filter(Boolean);
    const n = S.length, m = W.length;
    type Step = { pi: number; pj: number; kind: "same" | "swap" | "near" | "bad" };
    const cost: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(Infinity));
    const back: (Step | null)[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(null));
    cost[0][0] = 0;
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= m; j++) {
        if (cost[i][j] === Infinity) continue;
        for (let a = 1; a <= 3 && i + a <= n; a++) {
          for (let b = 1; b <= 3 && j + b <= m; b++) {
            const s = S.slice(i, i + a), w = W.slice(j, j + b);
            let kind: Step["kind"];
            let c: number;
            if (a === 1 && b === 1 && s[0] === w[0]) { kind = "same"; c = 0; }
            else {
              const ks = this.shapesOf(s), kw = this.shapesOf(w);
              if (ks && kw && ks.syl === kw.syl && ks.key === kw.key) { kind = "swap"; c = 0.01 * (a + b); }
              else if (ks && kw && ks.syl === kw.syl && pattern(ks.key) === pattern(kw.key)) { kind = "near"; c = 0.5 * Math.max(a, b); }
              else { kind = "bad"; c = 100 * Math.max(a, b); } // narrowest possible bad chunks
            }
            if (cost[i][j] + c < cost[i + a][j + b]) {
              cost[i + a][j + b] = cost[i][j] + c;
              back[i + a][j + b] = { pi: i, pj: j, kind };
            }
          }
        }
      }
    }
    const problems: { said: string; wrote: string }[] = [];
    const nearChunks: { said: string; wrote: string }[] = [];
    const changed: number[] = [];
    const chunks: { s0: number; s1: number; w0: number; w1: number }[] = [];
    const unknown = W.filter((w) => !this.forward.has(w));
    let changedSaid = 0;
    if (cost[n][m] === Infinity) {
      return { ok: false, near: 0, problems: [{ said: S.join(" "), wrote: W.join(" ") }], changed: [], unknown, changedSaid: 0, chunks: [] };
    }
    for (let i = n, j = m; i > 0 || j > 0; ) {
      const st = back[i][j]!;
      const chunk = { said: S.slice(st.pi, i).join(" "), wrote: W.slice(st.pj, j).join(" ") };
      chunks.push({ s0: st.pi, s1: i, w0: st.pj, w1: j });
      if (st.kind !== "same") {
        for (let k = st.pj; k < j; k++) changed.push(k);
        changedSaid += i - st.pi;
      }
      if (st.kind === "bad") problems.push(chunk);
      if (st.kind === "near") nearChunks.push(chunk);
      i = st.pi;
      j = st.pj;
    }
    if (nearChunks.length > MAX_NEAR) problems.push(...nearChunks.slice(MAX_NEAR));
    return {
      ok: problems.length === 0,
      near: Math.min(nearChunks.length, MAX_NEAR),
      problems: problems.reverse(),
      changed: changed.sort((x, y) => x - y),
      chunks: chunks.reverse(),
      unknown,
      changedSaid,
    };
  }

  /** Mouth-shape codes per spoken word, for the writer prompt. */
  describe(said: string[]): { w: string; shapes: string; syl: number }[] {
    return said.map((w) => {
      const e = this.forward.get(clean(w));
      return { w, shapes: e ? pattern(e.key).split("").join(" ") : "?", syl: e?.syl ?? 0 };
    });
  }

  /**
   * Lip-compatible replacements for a span of 1-2 spoken words: single words and word pairs
   * whose combined mouth-shape sequence and syllable count match exactly, plus (single words
   * only) near misses one shape off. Most common words first.
   */
  options(span: string[], maxExact = 20, maxNear = 6): SpanOptions {
    const ws = span.map(clean);
    const entries = ws.map((w) => this.forward.get(w));
    if (entries.some((e) => !e)) return { exact: [], near: [] };
    const key = collapse(entries.map((e) => e!.key).join(""));
    const syl = entries.reduce((n, e) => n + e!.syl, 0);
    const original = ws.join(" ");
    const sameAsSpoken = (o: string) => o === original || (ws.length === 1 && sameStem(o, ws[0]));
    const r = (w: string) => this.rank.get(w) ?? 1e9;

    // Single words with the same shapes; rare words (mostly names and oddities) are left out
    // so Sonnet builds lines from words people actually say.
    const singles = this.words(key, syl).filter((w) => !sameAsSpoken(w) && r(w) < SINGLE_RANK);

    // Two-word re-splits. The boundary shape may be shared ("bat" + "top" ~ "battop").
    const pairs: { text: string; score: number }[] = [];
    for (let k = 1; k < key.length; k++) {
      for (const overlap of [0, 1]) {
        const left = key.slice(0, k);
        const right = key.slice(k - overlap);
        if (!right) continue;
        for (let s1 = 1; s1 < syl; s1++) {
          // Re-splits only use common words, so they read as real phrases (no names or fragments).
          const common = (x: string) => r(x) < PAIR_RANK;
          const L = this.words(left, s1).filter(common).slice(0, 8);
          const R = this.words(right, syl - s1).filter(common).slice(0, 8);
          for (const a of L) for (const b of R) {
            const text = `${a} ${b}`;
            if (!sameAsSpoken(text)) pairs.push({ text, score: r(a) + r(b) });
          }
        }
      }
    }
    pairs.sort((a, b) => a.score - b.score);

    // Mix: most common singles first, then pairs; spans of two spoken words lean on pairs.
    const exact: string[] = [];
    const seen = new Set<string>();
    const push = (t: string) => !seen.has(t) && (seen.add(t), exact.push(t));
    const singleQuota = ws.length === 1 ? Math.ceil(maxExact * 0.6) : Math.ceil(maxExact * 0.4);
    singles.slice(0, singleQuota).forEach(push);
    pairs.slice(0, maxExact).forEach((p) => exact.length < maxExact && push(p.text));
    singles.slice(singleQuota).forEach((s) => exact.length < maxExact && push(s));

    // Near misses: single spoken word, one non-protected shape changed.
    const near: string[] = [];
    if (ws.length === 1) {
      const e = entries[0]!;
      for (let i = 0; i < e.key.length; i++) {
        const c = e.key[i];
        if (PROTECTED.has(c)) continue;
        const pool = VOWELISH.includes(c) ? VOWELISH : CONSONANTISH;
        for (const sub of pool) {
          if (sub === c) continue;
          const k = collapse(e.key.slice(0, i) + sub + e.key.slice(i + 1));
          for (const cand of this.words(k, e.syl)) {
            if (!seen.has(cand) && !sameAsSpoken(cand) && r(cand) < SINGLE_RANK) {
              seen.add(cand);
              near.push(cand);
            }
          }
        }
      }
      near.sort((a, b) => r(a) - r(b));
    }
    return { exact, near: near.slice(0, maxNear) };
  }
}

export const clean = (w: string) => w.toLowerCase().replace(/[^a-z']/g, "").replace(/^'+|'+$/g, "");

const collapse = (k: string) => k.replace(/(.)\1+/g, "$1");

// Avoid "swaps" that are just the same word inflected (bag -> bags).
function sameStem(a: string, b: string): boolean {
  const s = (x: string) => x.replace(/('s|s|es|ed|ing|er|ers)$/, "");
  return s(a) === s(b);
}

/** Same length, exactly one shape different, and that shape isn't a protected one. */
function nearKey(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (diff >= 0) return false;
    diff = i;
  }
  if (diff < 0) return false;
  const x = a[diff], y = b[diff];
  if (PROTECTED.has(x) || PROTECTED.has(y)) return false;
  return (VOWELISH.includes(x) && VOWELISH.includes(y)) || (CONSONANTISH.includes(x) && CONSONANTISH.includes(y));
}

/**
 * The visible pattern of a mouth-shape sequence: what the SPEC requires to stay put. Closed lips
 * (P), teeth on lip (F) and rounded lips/vowels (W, O, U -> W) keep their identity; every other
 * consonant becomes "c" and every unrounded vowel "V". Runs of the same symbol merge.
 */
export function pattern(key: string): string {
  return key
    .replace(/[OU]/g, "W")
    .replace(/[DTLKJR]/g, "c")
    .replace(/A/g, "V")
    .replace(/(.)\1+/g, "$1");
}
