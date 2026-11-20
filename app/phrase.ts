// Choose short phrases between pauses from Deepgram word timings.

export interface Word { w: string; p: string; s: number; e: number }

export interface Phrase {
  words: Word[];
  start: number; // loop window, seconds
  end: number;
}

const PAUSE = 0.28; // gap that counts as a pause
const MIN_WORDS = 2;
const MAX_WORDS = 8;
const MAX_SECONDS = 4.5;

/** All pause-bounded spans, with long runs also windowed from their edges. */
export function spans(words: Word[]): Word[][] {
  const runs: Word[][] = [];
  let cur: Word[] = [];
  words.forEach((w, i) => {
    cur.push(w);
    const next = words[i + 1];
    const endsSentence = /[.!?]$/.test(w.p);
    if (!next || next.s - w.e >= PAUSE || endsSentence) {
      runs.push(cur);
      cur = [];
    }
  });

  const out: Word[][] = [];
  for (const run of runs) {
    if (run.length >= MIN_WORDS && run.length <= MAX_WORDS && dur(run) <= MAX_SECONDS) out.push(run);
    if (run.length > MAX_WORDS || dur(run) > MAX_SECONDS) {
      // Long run: also offer windows that start or end at a natural edge, or at a comma.
      for (let n = 4; n <= Math.min(7, run.length - 1); n++) {
        out.push(run.slice(0, n), run.slice(run.length - n));
      }
      run.forEach((w, i) => {
        if (/,$/.test(w.p) && i + 1 >= MIN_WORDS) out.push(run.slice(Math.max(0, i - 6), i + 1));
      });
    }
  }
  return out.filter((s) => s.length >= MIN_WORDS && dur(s) <= MAX_SECONDS);
}

const dur = (ws: Word[]) => ws[ws.length - 1].e - ws[0].s;

export function toPhrase(ws: Word[], clipDuration = Infinity): Phrase {
  return {
    words: ws,
    start: Math.max(0, ws[0].s - 0.15),
    end: Math.min(clipDuration, ws[ws.length - 1].e + 0.25),
  };
}
