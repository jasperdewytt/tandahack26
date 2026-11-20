// Browser-side homophene lookup over the build-time index (public/lex.txt).
// Hard constraints: same syllable count, and the positions of closed lips (P),
// lip-on-teeth (F) and rounded lips (W) never change. Exact first, then one near miss.
//
// Options are found for spans of one or two spoken words, and an option can itself be one
// or two words, so the same run of mouth shapes can be re-split ("water bottle" -> "what a bottle").

export interface Entry { key: string; syl: number; cand: boolean }
export interface SpanOptions { exact: string[]; near: string[] }

const PROTECTED = new Set(["P", "F", "W"]);
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
      const [word, key, syl, star] = line.split(" ");
      const e = { key, syl: Number(syl), cand: star !== "*" };
      lex.forward.set(word, e);
      lex.rank.set(word, i++);
      if (e.cand) {
        const k = `${key}|${e.syl}`;
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
