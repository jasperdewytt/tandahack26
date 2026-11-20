// Choose a 4-6 second phrase that starts and ends at pauses, from Deepgram word timings.

export interface Word { w: string; p: string; s: number; e: number }

export interface Phrase {
  words: Word[];
  start: number; // loop window, seconds
  end: number;
}

const PAUSE = 0.25; // gap that counts as a pause
const MIN_SECONDS = 2.5;
const MAX_SECONDS = 6.5;
const MAX_WORDS = 12;
export const TARGET_SECONDS = 5;

/** Pause-bounded runs of speech. */
function runs(words: Word[]): Word[][] {
  const out: Word[][] = [];
  let cur: Word[] = [];
  words.forEach((w, i) => {
    cur.push(w);
    const next = words[i + 1];
    if (!next || next.s - w.e >= PAUSE || /[.!?,;]$/.test(w.p)) {
      out.push(cur);
      cur = [];
    }
  });
  return out;
}

const dur = (ws: Word[]) => ws[ws.length - 1].e - ws[0].s;

/**
 * Candidate spans: every stretch of consecutive runs (so it starts and ends at a pause)
 * lasting MIN..MAX seconds and at most MAX_WORDS words. If speech never pauses, fall back
 * to word windows near the target length.
 */
export function spans(words: Word[]): Word[][] {
  const rs = runs(words);
  const out: Word[][] = [];
  for (let a = 0; a < rs.length; a++) {
    let acc: Word[] = [];
    for (let b = a; b < rs.length; b++) {
      acc = acc.concat(rs[b]);
      if (acc.length > MAX_WORDS || dur(acc) > MAX_SECONDS) break;
      if (dur(acc) >= MIN_SECONDS && acc.length >= 3) out.push(acc);
    }
  }
  if (!out.length) {
    for (let a = 0; a < words.length; a++) {
      for (let n = 3; n <= MAX_WORDS && a + n <= words.length; n++) {
        const ws = words.slice(a, a + n);
        if (dur(ws) > MAX_SECONDS) break;
        if (dur(ws) >= MIN_SECONDS || a + n === words.length) out.push(ws);
      }
    }
  }
  // Very short answers: use everything that was said.
  if (!out.length && words.length >= 2) out.push(words);
  return out;
}

/** 1 at the target length, falling towards 0 at the edges. */
export function lengthFit(ws: Word[]): number {
  return Math.max(0, 1 - Math.abs(dur(ws) - TARGET_SECONDS) / 3);
}

export function toPhrase(ws: Word[], clipDuration = Infinity): Phrase {
  return {
    words: ws,
    start: Math.max(0, ws[0].s - 0.15),
    end: Math.min(clipDuration, ws[ws.length - 1].e + 0.25),
  };
}
