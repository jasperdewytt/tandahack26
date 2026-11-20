// The alibi pipeline without any DOM: pick the phrase, gather lip hints, then let the writer
// (Opus, via /api/alibi) write lines that the lip checker verifies. Shared by the app and by
// scripts/try-alibi.mjs, which runs it on a test recording from the command line.
import { Lexicon, clean } from "./lexicon";
import { Blocklist } from "./blocklist";
import { spans, toPhrase, lengthFit, type Word, type Phrase } from "./phrase";

/** One subtitle: shown while the speaker's mouth is making these words. */
export interface Cue { start: number; end: number; text: string }

export interface Alibi {
  swaps: { i: number; word: string }[];
  marks: number[]; // word positions in `text` that changed (for highlighting)
  text: string;
  cues: Cue[];
}

const CUE_WORDS = 8; // flush a subtitle after this many written words
const CUE_SECONDS = 3.2; // ...or after this long
const SINGLE_CUE_WORDS = 10; // short lines stay one caption for the whole loop

/**
 * Split a caption into subtitles timed to the speech: each aligned chunk (written words that
 * the lips form while saying words[s0..s1)) inherits those spoken words' timings.
 */
export function cuesFor(
  words: Word[],
  tokens: string[],
  chunks: { s0: number; s1: number; w0: number; w1: number }[],
  phrase: Phrase,
): Cue[] {
  const whole = caption(tokens);
  if (tokens.length <= SINGLE_CUE_WORDS || !chunks.length) return [{ start: phrase.start, end: phrase.end, text: whole }];
  // Build raw groups of written words with their spoken timings.
  const groups: { w0: number; w1: number; start: number; end: number }[] = [];
  let cur: { w0: number; w1: number; start: number; end: number } | null = null;
  for (const c of chunks) {
    if (!cur) cur = { w0: c.w0, w1: c.w1, start: words[c.s0].s, end: words[c.s1 - 1].e };
    cur.w1 = c.w1;
    cur.end = words[c.s1 - 1].e;
    const lastTok = tokens[c.w1 - 1] ?? "";
    const n = cur.w1 - cur.w0;
    // Break at sentence ends, at commas once there's enough to read, or when it gets long.
    // ...but never right after a little word ("a big bag of / socks") unless it's run very long.
    const dangling = /^(a|an|the|of|to|in|on|at|my|your|and|or|but|for|with|is|i)$/i.test(lastTok) && cur.end - cur.start < 4.5;
    if (/[.!?]$/.test(lastTok) || (/[,;:]$/.test(lastTok) && n >= 4) || (!dangling && (n >= CUE_WORDS || cur.end - cur.start >= CUE_SECONDS))) {
      groups.push(cur);
      cur = null;
    }
  }
  if (cur) groups.push(cur);
  // Fold a tiny last subtitle ("Three.") into the one before it.
  if (groups.length > 1 && groups[groups.length - 1].w1 - groups[groups.length - 1].w0 < 3) {
    const tail = groups.pop()!;
    groups[groups.length - 1].w1 = tail.w1;
    groups[groups.length - 1].end = tail.end;
  }
  const cues: Cue[] = groups.map((g) => {
    let text = tokens.slice(g.w0, g.w1).join(" ").replace(/[,;:–—-]+$/, "");
    // Capitalise only where a sentence starts, like real subtitles.
    const startsSentence = g.w0 === 0 || /[.!?]$/.test(tokens[g.w0 - 1] ?? "");
    if (startsSentence) text = text[0].toUpperCase() + text.slice(1);
    return { start: g.start, end: g.end, text };
  });
  // No gaps: each subtitle stays up until the next one starts; the loop edges are covered too.
  cues[0].start = phrase.start;
  for (let i = 0; i < cues.length - 1; i++) cues[i].end = cues[i + 1].start;
  cues[cues.length - 1].end = phrase.end;
  return cues;
}

/** Subtitles for what was actually said, using the same timing rules. */
export function originalCues(phrase: Phrase): Cue[] {
  const tokens = phrase.words.map((w) => w.p);
  const chunks = phrase.words.map((_, i) => ({ s0: i, s1: i + 1, w0: i, w1: i + 1 }));
  return cuesFor(phrase.words, tokens, chunks, phrase);
}

/** The subtitle to show at playback time t. */
export function cueAt(cues: Cue[], t: number): string {
  if (!cues.length) return "";
  for (const c of cues) if (t < c.end) return c.text;
  return cues[cues.length - 1].text;
}

/** A span of 1-2 spoken words and the lip-compatible text that could replace it. */
export interface Slot { id: string; s: number; n: number; said: string; exact: string[]; near: string[] }

export interface Ranked {
  phrase: Phrase;
  slots: Slot[];
  score: number;
}

/** Posts JSON to an API path and returns the parsed reply (throws on failure). */
export type Post = (path: string, body: string) => Promise<any>;

export const caption = (tokens: string[]) => {
  const s = tokens.join(" ").replace(/[,;:–—-]+$/, "");
  return s[0].toUpperCase() + s.slice(1);
};

function slotsFor(span: Word[], lex: Lexicon, block: Blocklist): Slot[] {
  const clean2 = (list: string[]) => list.filter((o) => !block.blocks(o));
  const slots: Slot[] = [];
  span.forEach((w, s) => {
    if (!lex.swappable(w.w)) return;
    const one = lex.options([w.w]);
    const exact = clean2(one.exact);
    // Near misses only where exact options are scarce.
    const near = exact.length < 3 ? clean2(one.near) : [];
    if (exact.length || near.length) slots.push({ id: "", s, n: 1, said: w.w, exact, near });
    // Re-split two adjacent words, unless punctuation sits between them.
    const next = span[s + 1];
    if (next && lex.swappable(next.w) && !/[.,!?;:]$/.test(w.p)) {
      const two = clean2(lex.options([w.w, next.w], 15).exact);
      if (two.length) slots.push({ id: "", s, n: 2, said: `${w.w} ${next.w}`, exact: two, near: [] });
    }
  });
  return slots.slice(0, 40).map((sl, k) => ({ ...sl, id: `s${k}` }));
}

export function rankPhrases(words: Word[], lex: Lexicon, block: Blocklist, duration: number): Ranked[] {
  const seen = new Set<string>();
  const out: Ranked[] = [];
  for (const span of spans(words)) {
    const key = `${span[0].s}-${span.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (block.blocks(span.map((w) => w.p).join(" "))) continue;
    const slots = slotsFor(span, lex, block);
    if (!slots.length) continue;
    // Favour phrases where most words can change, near the 5 s target length.
    const covered = new Set<number>();
    slots.forEach((sl) => sl.exact.length && [...Array(sl.n).keys()].forEach((d) => covered.add(sl.s + d)));
    const coverage = covered.size / span.length;
    const score = coverage * 40 + covered.size * 3 + lengthFit(span) * 25;
    out.push({ phrase: toPhrase(span, duration), slots, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

export interface WriteLog { round: number; line: string; ok: boolean; problems: { said: string; wrote: string }[] }

/**
 * The writer drafts whole lines; each is checked against the lips (Lexicon.check) and the
 * blocklist. Lines that don't fit go back once with exactly which chunks failed, for small fixes.
 */
export async function writeAlibis(
  r: Ranked,
  lex: Lexicon,
  block: Blocklist,
  post: Post,
  onStatus: (s: string) => void = () => {},
  log: WriteLog[] = [],
  topic = "",
  effort: "low" | "medium" = "medium",
): Promise<Alibi[]> {
  const said = r.phrase.words.map((w) => w.w);
  const base = {
    said: caption(r.phrase.words.map((w) => w.p)),
    words: lex.describe(said),
    hints: r.slots.map((s) => ({ said: s.said, options: s.exact.slice(0, 12) })),
    ...(topic.trim() ? { topic: topic.trim().slice(0, 60) } : {}),
    effort,
  };
  const accepted: { text: string; marks: number[]; changed: number; cues: Cue[] }[] = [];
  let feedback: { line: string; problems: { said: string; wrote: string }[]; unknown: string[] }[] | undefined;

  for (let round = 0; round < 2 && accepted.length < 2; round++) {
    onStatus(round === 0 ? "Writing your alibi… this takes about half a minute." : "Nudging the lines to fit your lips…");
    const data = await post("/api/alibi", JSON.stringify(feedback ? { ...base, feedback } : base));
    feedback = [];
    for (const line of (data.lines ?? []) as string[]) {
      const tokens = String(line).split(/\s+/).filter((t) => clean(t));
      if (!tokens.length) continue;
      const text = caption(tokens);
      const chk = lex.check(said, tokens);
      log.push({ round: round + 1, line: text, ok: chk.ok, problems: chk.problems });
      // Must fit the lips, be clean, and actually change something.
      if (chk.ok && chk.changedSaid > 0 && !block.blocks(text) && !accepted.some((x) => x.text === text)) {
        accepted.push({ text, marks: chk.changed, changed: chk.changedSaid, cues: cuesFor(r.phrase.words, tokens, chk.chunks, r.phrase) });
      } else if (!chk.ok) {
        feedback.push({ line: text, problems: chk.problems, unknown: chk.unknown });
      }
    }
  }
  // The writer ranks its lines best first. Show its best, then the line least like it.
  const pick = accepted.slice(0, 1);
  if (accepted.length > 1) {
    const words = (t: string) => new Set(t.toLowerCase().replace(/[^a-z' ]/g, "").split(" "));
    const first = words(accepted[0].text);
    const overlap = (t: string) => [...words(t)].filter((w) => first.has(w)).length / words(t).size;
    pick.push(accepted.slice(1).reduce((best, x) => (overlap(x.text) < overlap(best.text) ? x : best)));
  }
  return pick.map((x) => ({ swaps: [], marks: x.marks, text: x.text, cues: x.cues }));
}
