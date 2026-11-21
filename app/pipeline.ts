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
  /** Stage dub needs the exact written tokens and their Lexicon.check alignment chunks. */
  tokens?: string[];
  chunks?: { s0: number; s1: number; w0: number; w1: number }[];
}

// Keep each growing subtitle short enough to follow on a phone.
const CAPTION_WORDS = 5;

function buildWordCues(tokens: string[], starts: number[], end: number): Cue[] {
  let group: string[] = [];
  return tokens.map((token, i) => {
    const sentenceStart = i === 0 || /[.!?]["’”']?$/.test(tokens[i - 1]);
    if (sentenceStart || group.length >= CAPTION_WORDS) group = [];
    group.push(sentenceStart ? token.charAt(0).toUpperCase() + token.slice(1) : token);
    return { start: starts[i], end: starts[i + 1] ?? end, text: group.join(" ") };
  });
}

/** Reveal each written word at its corresponding position in the spoken word timings. */
export function cuesFor(
  words: Word[],
  tokens: string[],
  chunks: { s0: number; s1: number; w0: number; w1: number }[],
  phrase: Phrase,
  spokenSyllables?: number[],
  writtenSyllables?: number[],
): Cue[] {
  const starts: number[] = [];
  for (const { s0, s1, w0, w1 } of chunks) {
    const spoken = words.slice(s0, s1).map((_, i) => spokenSyllables?.[s0 + i] || 1);
    const written = tokens.slice(w0, w1).map((_, i) => writtenSyllables?.[w0 + i] || 1);
    const spokenTotal = spoken.reduce((a, b) => a + b, 0);
    const writtenTotal = written.reduce((a, b) => a + b, 0);
    let writtenBeat = 0;
    let source = 0;
    let sourceBeat = 0;
    for (const length of written) {
      const beat = writtenBeat * spokenTotal / writtenTotal;
      while (source + 1 < spoken.length && beat >= sourceBeat + spoken[source]) {
        sourceBeat += spoken[source++];
      }
      const word = words[s0 + source];
      const end = Math.min(word.e, phrase.end);
      const fraction = (beat - sourceBeat) / spoken[source];
      starts.push(Math.min(end, word.s) + fraction * Math.max(0, end - word.s));
      writtenBeat += length;
    }
  }
  return buildWordCues(tokens, starts, phrase.end);
}

/** Older saved samples contain phrase timings only. Spread their words over each phrase. */
export function expandSampleCues(cues: Cue[]): Cue[] {
  return cues.flatMap(cue => {
    const tokens = cue.text.trim().split(/\s+/).filter(Boolean);
    const starts = tokens.map((_, i) => cue.start + i * (cue.end - cue.start) / tokens.length);
    return buildWordCues(tokens, starts, cue.end);
  });
}

/** Subtitles for what was actually said, using the same timing rules. */
export function originalCues(phrase: Phrase): Cue[] {
  const tokens = phrase.words.map((w) => w.p);
  const chunks = phrase.words.map((_, i) => ({ s0: i, s1: i + 1, w0: i, w1: i + 1 }));
  return cuesFor(phrase.words, tokens, chunks, phrase);
}

// Give the eye a brief head start on the mouth. Keep stored cues on the media timeline
// so this applies once on each display, including saved samples and caption switches.
const CAPTION_LEAD_SECONDS = 0.09;

/** The subtitle to show at playback time t. */
export function cueAt(cues: Cue[], t: number): string {
  const revealTime = t + CAPTION_LEAD_SECONDS;
  if (!cues.length || revealTime < cues[0].start) return "";
  for (const c of cues) if (revealTime < c.end) return c.text;
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
  const words = lex.describe(said);
  const targetSyllables = words.reduce((sum, w) => sum + (w.syl || 1), 0);
  const base = {
    said: caption(r.phrase.words.map((w) => w.p)),
    words, targetSyllables,
    hints: r.slots.filter(s => s.n === 1).map(s => ({
      said: s.said, options: [...s.exact, ...s.near].filter(word => !word.includes(" ")).slice(0, 4),
    })),
    ...(topic.trim() ? { topic: topic.trim().slice(0, 60) } : {}),
    effort,
  };
  const picks: Alibi[] = [];
  const feedback: { line: string; note: string; problems: WriteLog["problems"]; unknown: string[] }[] = [];
  // Relaxed fallback so a take never ends empty: every line the writer drafted, scored by how
  // badly it breaks the normal rules (lower is better). Used only when nothing passes normally.
  const spares = new Map<string, { alibi: Alibi; score: number }>();
  const toAlibi = (text: string, tokens: string[], chk: ReturnType<Lexicon["check"]>): Alibi => ({
    swaps: [], marks: chk.changed, text, tokens, chunks: chk.chunks,
    cues: cuesFor(r.phrase.words, tokens, chk.chunks, r.phrase, words.map(w => w.syl), lex.describe(tokens).map(w => w.syl)),
  });
  const spare = (text: string, tokens: string[], chk: ReturnType<Lexicon["check"]>, score: number) => {
    if (!chk.chunks.length) return;
    const old = spares.get(text);
    if (!old || score < old.score) spares.set(text, { alibi: toAlibi(text, tokens, chk), score });
  };
  const spokenSyllables = targetSyllables;
  for (let round = 0; round < 2 && picks.length < 2; round++) {
    onStatus(round ? "Trying a different punchline…" : "Writing your alibi…");
    try {
      const data = await post("/api/alibi", JSON.stringify(round ? { ...base, feedback } : base));
      if (data.refused) break;
      const candidates = new Map<string, Alibi>();
      for (const line of (data.lines ?? []) as string[]) {
        const tokens = line.split(/\s+/).filter((t) => clean(t));
        if (!tokens.length || block.blocks(line)) continue;
        const text = caption(tokens);
        const chk = lex.check(said, tokens);
        log.push({ round: round + 1, line: text, ok: chk.ok, problems: chk.problems });
        // Count new words independently of lip alignment: a re-split chunk can contain copied words.
        const remaining = said.map(clean);
        let fresh = 0;
        for (const token of tokens) {
          const index = remaining.indexOf(clean(token));
          if (index < 0) fresh++;
          else remaining.splice(index, 1);
        }
        const writtenSyllables = lex.describe(tokens).reduce((sum, w) => sum + (w.syl || 1), 0);
        // Fits but rejected by the editor: 0. Too much copied: 20. Lip misses: by how many and how far off.
        spare(text, tokens, chk, chk.ok ? (fresh < Math.ceil(said.length / 3) ? 20 : 0)
          : 30 + chk.problems.length * 10 + Math.abs(writtenSyllables - spokenSyllables));
        if (!chk.ok || fresh < Math.ceil(said.length / 3)) {
          feedback.push({ line: text, problems: chk.problems, unknown: chk.unknown,
            note: chk.ok ? "Too much of the original survives. Change the action and the payoff." :
              `Your line has about ${lex.describe(tokens).reduce((sum, w) => sum + (w.syl || 1), 0)} syllables. Aim for ${targetSyllables}. Keep the premise; match a few more visible beats.` });
          continue;
        }
        candidates.set(text, toAlibi(text, tokens, chk));
      }
      if (!candidates.size) continue;
      for (const pick of picks) candidates.set(pick.text, pick);
      onStatus("Picking the punchline…");
      const edited = await post("/api/alibi", JSON.stringify({ said: base.said, topic, candidates: [...candidates.keys()], effort: "low" }));
      const selected = Array.from(new Set<string>(edited.lines ?? [])).flatMap(t => candidates.get(t) ?? []).slice(0, 2);
      for (const line of candidates.keys()) {
        if (!selected.some(a => a.text === line)) feedback.push({ line, note: "Fits the mouth, but needs a clearer premise and a payoff that follows from it.", problems: [], unknown: [] });
      }
      if (selected.length) picks.splice(0, picks.length, ...selected);
    } catch (error) {
      if (!picks.length && !spares.size) throw error;
      break;
    }
  }
  if (picks.length) return picks;
  // Relaxed: nothing passed both the lip check and the editor. Show the closest lines instead.
  if (!spares.size) {
    onStatus("Trying a looser fit…");
    try {
      const data = await post("/api/alibi", JSON.stringify({ ...base, effort: "low" }));
      for (const line of (data.lines ?? []) as string[]) {
        const tokens = line.split(/\s+/).filter((t) => clean(t));
        if (!tokens.length || block.blocks(line)) continue;
        const text = caption(tokens);
        const chk = lex.check(said, tokens);
        log.push({ round: 3, line: text, ok: chk.ok, problems: chk.problems });
        spare(text, tokens, chk, chk.ok ? 0 : 30 + chk.problems.length * 10);
      }
    } catch {
      /* fall through to whatever we have */
    }
  }
  // Lines that fit the lips beat lines that don't; only mix in misses when nothing fits.
  const ranked = [...spares.values()].sort((a, b) => a.score - b.score);
  const fits = ranked.filter((s) => s.score < 30);
  return (fits.length ? fits : ranked).slice(0, 2).map((s) => s.alibi);
}
