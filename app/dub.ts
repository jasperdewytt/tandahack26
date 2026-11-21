// Stage dub, browser side: map TTS character timings back to the alibi's tokens, fit the
// synthesized line onto the speaker's lip timings (pitch-preserving WSOLA, absolute offsets
// from phrase.start), and the presenter-side controller that makes stale audio impossible.
import { clean } from "./lexicon";
import type { Word } from "./phrase";

export interface Alignment { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }
export interface Chunk { s0: number; s1: number; w0: number; w1: number }
export interface Span { s: number; e: number }
/** TTS audio [src0, src1) stretched as one run onto media time [dst0, dst1); knots are the word onsets inside it. */
export interface Segment { src0: number; src1: number; dst0: number; dst1: number; text: string; knots: Knot[] }

// ---------- alignment ----------

/**
 * Times for each token from ElevenLabs character timings. Punctuation is skipped; tokens are
 * matched in order from a moving cursor, so repeated words land on their own occurrence.
 * Tokens that can't be found are interpolated between their neighbours.
 */
export function tokenTimes(tokens: string[], al: Alignment): Span[] {
  // Apostrophes are dropped on both sides so ’ vs ' never matters.
  const letters: { ch: string; s: number; e: number }[] = [];
  al.characters.forEach((c, i) => {
    for (const ch of c.toLowerCase()) {
      if (/[a-z0-9]/.test(ch)) letters.push({ ch, s: al.character_start_times_seconds[i], e: al.character_end_times_seconds[i] });
    }
  });
  const stream = letters.map((l) => l.ch).join("");
  let cursor = 0;
  const found: (Span | null)[] = tokens.map((token) => {
    const t = clean(token).replace(/[^a-z0-9]/g, "");
    if (!t) return null;
    const at = stream.startsWith(t, cursor) ? cursor : stream.indexOf(t, cursor);
    if (at < 0) return null;
    cursor = at + t.length;
    return { s: letters[at].s, e: letters[at + t.length - 1].e };
  });
  const total = letters.length ? letters[letters.length - 1].e : 0;
  return found.map((f, i) => {
    if (f) return f;
    let a = i - 1; while (a >= 0 && !found[a]) a--;
    let b = i + 1; while (b < found.length && !found[b]) b++;
    const from = a >= 0 ? found[a]!.e : 0;
    const to = b < found.length ? found[b]!.s : total;
    const k = b - a; // missing run spans k - 1 tokens
    return { s: from + ((to - from) * (i - a - 1)) / k, e: from + ((to - from) * (i - a)) / k };
  });
}

// ---------- placement plan ----------

const PAUSE = 0.25; // never merge across a visible pause
const TINY_DST = 0.12;
const TINY_SRC = 0.08;
const SRC_PAD = 0.03; // let final consonants ring out, but never into the next word
const ANCHOR_GAP = 0.15; // a gap in the lips this long gets its own anchor
const MAX_SEGMENT = 1.6; // longest run stretched as one piece
const ONSET_TOL = 0.06; // an internal word may land at most this far from its lip time
const EDGE_SLACK = 0.06; // a segment may borrow this much silence on either side to fit
const MAX_WORD_GAP = 0.35; // a split may leave at most this much silence before the next word
export const MIN_RATE = 0.45; // dst/src: at most ~2.2x faster
export const MAX_RATE = 2.2; // at most 2.2x slower

/** A word onset inside a segment: TTS time `src` should be heard at media time `want`. */
export interface Knot { src: number; dst: number; want: number }

/** The words can't be stretched onto the lips intelligibly. Presenter-facing message. */
export class FitError extends Error {}

export interface PlanInput {
  words: Word[]; // spoken words (original timings)
  tokens: string[]; // the exact alibi tokens sent to TTS
  chunks: Chunk[]; // Lexicon.check alignment: said[s0,s1) ~ wrote[w0,w1)
  times: Span[]; // TTS time of each token
  start: number; // phrase.start (loop start)
  playEnd: number; // min(phrase.end, playable clip end)
  closedSaid?: boolean[]; // spoken word shows closed lips (p/b/m)
  closedWrote?: boolean[]; // written token has closed lips
}

const rateOf = (s: Segment) => (s.dst1 - s.dst0) / Math.max(1e-6, s.src1 - s.src0);
const inRange = (s: Segment) => rateOf(s) >= MIN_RATE && rateOf(s) <= MAX_RATE;

/** Join b onto a: b's start becomes an internal knot, so b's first word stays on time. */
function join(a: Segment, b: Segment): Segment {
  return {
    src0: a.src0, dst0: a.dst0, src1: b.src1, dst1: b.dst1, text: `${a.text} ${b.text}`,
    knots: [...a.knots, { src: b.src0, dst: b.dst0, want: b.dst0 }, ...b.knots],
  };
}

/**
 * Place the knots as close to their lip times as the rate limits allow (forward pass that
 * always leaves the rest of the segment reachable). Returns the worst knot error.
 */
export function solveKnots(s: Segment): { worst: number; at: number } {
  let prevSrc = s.src0, prevDst = s.dst0, worst = 0, at = -1;
  s.knots.forEach((k, i) => {
    const ds = Math.max(0, k.src - prevSrc), rest = Math.max(0, s.src1 - k.src);
    const lo = Math.max(prevDst + MIN_RATE * ds, s.dst1 - MAX_RATE * rest);
    const hi = Math.min(prevDst + MAX_RATE * ds, s.dst1 - MIN_RATE * rest);
    k.dst = lo <= hi ? Math.min(hi, Math.max(lo, k.want)) : (lo + hi) / 2;
    const err = Math.abs(k.dst - k.want);
    if (err > worst) { worst = err; at = i; }
    prevSrc = k.src;
    prevDst = k.dst;
  });
  return { worst, at };
}

/** Cut a segment at knot i: both halves keep their own knots and meet at the exact lip time. */
function splitAt(s: Segment, i: number): [Segment, Segment] {
  const k = s.knots[i];
  return [
    { src0: s.src0, dst0: s.dst0, src1: k.src, dst1: k.want, text: s.text, knots: s.knots.slice(0, i) },
    { src0: k.src, dst0: k.want, src1: s.src1, dst1: s.dst1, text: s.text, knots: s.knots.slice(i + 1) },
  ];
}

/**
 * Anchors at chunk level, refined to single words where the counts match. Pieces between
 * anchors (visible pauses, punctuation, the first lip closure, the final word) are joined into
 * smooth runs whose internal word onsets are kept as knots; a run is split where a word would
 * still land more than ONSET_TOL off. Segments that can't be fitted within the stretch limits
 * borrow a little silence or join a neighbour; if that still fails, FitError.
 */
export function planSegments(p: PlanInput): Segment[] {
  const pairs: [number, number, number, number][] = [];
  let closureDone = false;
  for (const c of p.chunks) {
    if (c.s1 > p.words.length || c.w1 > p.times.length || c.s1 <= c.s0 || c.w1 <= c.w0) continue;
    if (c.s1 - c.s0 === c.w1 - c.w0) {
      for (let k = 0; k < c.s1 - c.s0; k++) pairs.push([c.s0 + k, c.s0 + k + 1, c.w0 + k, c.w0 + k + 1]);
      continue;
    }
    let split = false;
    if (!closureDone && p.closedSaid && p.closedWrote) {
      let i = c.s0; while (i < c.s1 && !p.closedSaid[i]) i++;
      let j = c.w0; while (j < c.w1 && !p.closedWrote[j]) j++;
      if (i < c.s1 && j < c.w1 && (i > c.s0) === (j > c.w0) && i > c.s0) {
        pairs.push([c.s0, i, c.w0, j], [i, c.s1, j, c.w1]);
        split = true;
      }
    }
    if (!split) pairs.push([c.s0, c.s1, c.w0, c.w1]);
    if (p.closedSaid?.slice(c.s0, c.s1).some(Boolean)) closureDone = true;
  }

  // Word-level pieces, each marked if it must start a new segment.
  const pieces: (Segment & { anchor: boolean })[] = [];
  let firstClosure = true;
  pairs.forEach(([s0, s1, w0, w1], k) => {
    const dst0 = Math.max(p.start, p.words[s0].s);
    const dst1 = Math.min(p.playEnd, p.words[s1 - 1].e);
    if (dst1 - dst0 < 0.02) return;
    const src0 = p.times[w0].s;
    const next = p.times[w1]?.s ?? Infinity;
    const src1 = Math.max(src0 + 0.01, Math.min(p.times[w1 - 1].e + SRC_PAD, next));
    const prev = pieces[pieces.length - 1];
    const closure = !!(p.closedSaid?.[s0] && p.closedWrote?.[w0]);
    const anchor =
      !prev ||
      dst0 - prev.dst1 >= ANCHOR_GAP || // a visible pause in the lips
      /[,.;:!?—–-]["”’']?$/.test(p.tokens[w0 - 1] ?? "") || // a pause in the line
      (closure && firstClosure) || // the first visible lip closure
      (k === pairs.length - 1 && dst1 - dst0 >= TINY_DST); // the final (stressed) word
    if (closure) firstClosure = false;
    pieces.push({ src0, src1, dst0, dst1, anchor, text: p.tokens.slice(w0, w1).join(" "), knots: [] });
  });

  // Join the pieces between anchors so each phrase is stretched as one smooth run.
  const segs: Segment[] = [];
  for (const { anchor, ...q } of pieces) {
    const last = segs[segs.length - 1];
    if (!anchor && last && q.dst1 - last.dst0 <= MAX_SEGMENT) segs[segs.length - 1] = join(last, q);
    else segs.push(q);
  }

  // Merge tiny pieces into the neighbour they touch most closely (never across a pause).
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s.dst1 - s.dst0 >= TINY_DST && s.src1 - s.src0 >= TINY_SRC) continue;
      const gapL = i > 0 ? s.dst0 - segs[i - 1].dst1 : Infinity;
      const gapR = i + 1 < segs.length ? segs[i + 1].dst0 - s.dst1 : Infinity;
      if (Math.min(gapL, gapR) >= PAUSE) continue;
      const j = gapL <= gapR ? i - 1 : i + 1;
      segs.splice(Math.min(i, j), 2, j < i ? join(segs[j], s) : join(s, segs[j]));
      changed = true;
      break;
    }
  }

  // Out-of-range segments: borrow a little neighbouring silence, then try joining a neighbour.
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (inRange(s)) continue;
    if (rateOf(s) < MIN_RATE) {
      const roomL = Math.max(0, Math.min(EDGE_SLACK, s.dst0 - (i > 0 ? segs[i - 1].dst1 : p.start)));
      const roomR = Math.max(0, Math.min(EDGE_SLACK, (i + 1 < segs.length ? segs[i + 1].dst0 : p.playEnd) - s.dst1));
      const need = MIN_RATE * (s.src1 - s.src0) - (s.dst1 - s.dst0);
      if (need <= roomL + roomR) {
        const r = Math.min(roomR, need);
        s.dst1 += r;
        s.dst0 -= need - r;
        continue;
      }
    }
    const tryJoin = (j: number) => {
      if (j < 0 || j >= segs.length) return false;
      const [a, b] = j < i ? [segs[j], s] : [s, segs[j]];
      if (b.dst0 - a.dst1 >= PAUSE) return false;
      const m = join(a, b);
      if (!inRange(m)) return false;
      segs.splice(Math.min(i, j), 2, m);
      return true;
    };
    if (tryJoin(i - 1) || tryJoin(i + 1)) i = Math.max(-1, i - 2);
  }
  for (const s of segs) {
    if (inRange(s)) continue;
    const r = rateOf(s);
    throw new FitError(
      r > MAX_RATE
        ? `The voice says "${s.text}" too quickly for these lips (it would need ${r.toFixed(1)}x slowing). Captions stay on screen.`
        : `The voice takes too long over "${s.text}" for these lips (it would need ${(1 / r).toFixed(1)}x speeding up). Captions stay on screen.`,
    );
  }

  // Keep internal words on time: split a run where a word would still land too far off,
  // as long as both halves stay within the stretch limits.
  const out: Segment[] = [];
  const queue = [...segs];
  while (queue.length) {
    const s = queue.shift()!;
    const { worst, at } = solveKnots(s);
    if (worst > ONSET_TOL) {
      const [a, b] = splitAt(s, at);
      // The words before the knot are too short to fill the lips' time even at the slowest
      // usable rate: say them at that rate and leave a short pause before the next word.
      if (rateOf(a) > MAX_RATE) {
        const end = a.dst0 + MAX_RATE * (a.src1 - a.src0);
        if (a.dst1 - end <= MAX_WORD_GAP) a.dst1 = end;
      }
      if (inRange(a) && inRange(b)) {
        queue.unshift(a, b);
        continue;
      }
    }
    out.push(s);
  }
  return out;
}

// ---------- pitch-preserving time stretch (WSOLA) ----------

function resample(x: Float32Array, outLen: number): Float32Array {
  const out = new Float32Array(outLen);
  const k = x.length > 1 ? (x.length - 1) / Math.max(1, outLen - 1) : 0;
  for (let i = 0; i < outLen; i++) {
    const p = i * k, a = Math.floor(p), f = p - a;
    out[i] = (x[a] ?? 0) * (1 - f) + (x[a + 1] ?? x[a] ?? 0) * f;
  }
  return out;
}

/**
 * Stretch x to outLen samples without changing pitch. `map` (optional) lists [output sample,
 * input sample] points the time map must pass through, so words inside a run stay on time.
 */
export function stretch(x: Float32Array, outLen: number, sr: number, map: [number, number][] = []): Float32Array {
  if (outLen <= 0) return new Float32Array(0);
  const N = 2 * Math.round(0.015 * sr); // 30 ms frames
  const H = N / 2;
  if (x.length < 2 * N || outLen < 2 * N) return resample(x, outLen);
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const n = x.length;
  const alpha = (n - N) / Math.max(1, outLen - N);
  const pts: [number, number][] = [[0, 0], ...map, [outLen, n]];
  const at = (o: number) => {
    if (!map.length) return o * alpha;
    let j = 1;
    while (j < pts.length - 1 && pts[j][0] <= o) j++;
    const [o0, i0] = pts[j - 1], [o1, i1] = pts[j];
    return i0 + ((i1 - i0) * (o - o0)) / Math.max(1, o1 - o0);
  };
  const tol = Math.round(0.008 * sr);
  const out = new Float32Array(outLen + N);
  const norm = new Float32Array(outLen + N);
  let prev = 0;
  for (let o = 0; o < outLen; o += H) {
    let pos = 0;
    if (o > 0) {
      const ideal = Math.max(0, Math.min(n - N, Math.round(at(o))));
      const nat = prev + H;
      let best = ideal, bestC = -Infinity;
      const lo = Math.max(0, ideal - tol), hi = Math.min(n - N, ideal + tol);
      // Normalised cross-correlation against the natural continuation of the previous frame.
      for (let c = lo; c <= hi; c++) {
        let s = 0, e = 1e-9;
        for (let i = 0; i < H && nat + i < n; i += 2) {
          s += x[c + i] * x[nat + i];
          e += x[c + i] * x[c + i];
        }
        s /= Math.sqrt(e);
        if (s > bestC) { bestC = s; best = c; }
      }
      pos = best;
    }
    for (let i = 0; i < N; i++) {
      out[o + i] += x[pos + i] * win[i];
      norm[o + i] += win[i];
    }
    prev = pos;
  }
  for (let i = 0; i < outLen; i++) if (norm[i] > 0.1) out[i] /= norm[i];
  return out.subarray(0, outLen);
}

// ---------- render ----------

const FADE = 0.008;

/**
 * Place every segment at its absolute offset from `start` (so errors never accumulate), with
 * its word knots on time. Fades stay inside each segment's own window. planSegments has already
 * rejected anything outside the stretch limits, so nothing is truncated or padded here.
 */
export function render(pcm: Float32Array, sr: number, segs: Segment[], start: number, playEnd: number): Float32Array {
  const out = new Float32Array(Math.max(0, Math.round((playEnd - start) * sr)));
  for (const s of segs) {
    const a = Math.max(0, Math.round(s.src0 * sr)), b = Math.min(pcm.length, Math.round(s.src1 * sr));
    if (b - a < 8) continue;
    const L = Math.round((s.dst1 - s.dst0) * sr);
    const map = s.knots.map((k): [number, number] => [Math.round((k.dst - s.dst0) * sr), Math.round(k.src * sr) - a]);
    const piece = stretch(pcm.subarray(a, b), L, sr, map);
    const off = Math.max(0, Math.round((s.dst0 - start) * sr));
    const len = Math.min(piece.length, out.length - off);
    if (len <= 0) continue;
    const fade = Math.min(Math.round(FADE * sr), Math.floor(len / 4));
    for (let i = 0; i < len; i++) {
      let g = 1;
      if (i < fade) g = i / fade;
      else if (i >= len - fade) g = (len - 1 - i) / fade;
      out[off + i] += piece[i] * g;
    }
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0.98) for (let i = 0; i < out.length; i++) out[i] *= 0.98 / peak;
  return out;
}

export interface FitInput extends Omit<PlanInput, "times"> { alignment: Alignment; pcm: Float32Array; sampleRate: number }

/** Throws FitError when the line can't be fitted intelligibly; never returns a partial render. */
export function fit(f: FitInput): { pcm: Float32Array; segments: Segment[] } {
  const times = tokenTimes(f.tokens, f.alignment);
  const segments = planSegments({ ...f, times });
  return { pcm: render(f.pcm, f.sampleRate, segments, f.start, f.playEnd), segments };
}

// ---------- WAV (for Save dub) ----------

export function wav(pcm: Float32Array, sr: number): Blob {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, pcm.length * 2, true);
  pcm.forEach((x, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x)) * 0x7fff, true));
  return new Blob([buf], { type: "audio/wav" });
}

// ---------- presenter controller ----------

export interface Fitted { key: string; pcm: Float32Array; sampleRate: number }
export interface DubTarget { key: string; reveal: number; take: string; tokens: string[] | null }
export type DubMsg =
  | { t: "dub"; key: string; reveal: number; pcm: Float32Array; sampleRate: number }
  | { t: "dub-stop" };

/**
 * Hear it → cached fitted audio, or one shared request → fit → send to the projector.
 * Every cancel (Stop, Hold, new take, new reveal) bumps the generation; a response that
 * arrives for an older generation is kept in the cache but never played.
 */
export class DubController {
  private gen = 0;
  readonly cache = new Map<string, Fitted>();
  private inflight = new Map<string, Promise<Fitted>>();

  constructor(
    private request: (target: DubTarget) => Promise<Fitted>,
    private send: (m: DubMsg) => void,
    private status: (s: string) => void,
  ) {}

  async hear(target: DubTarget): Promise<boolean> {
    const g = ++this.gen;
    let fitted = this.cache.get(target.key);
    if (!fitted) {
      if (!target.tokens) {
        this.status("No dub timings for this alibi (older sample). The silent reveal still works.");
        return false;
      }
      this.status("Synthesizing the dub…");
      let p = this.inflight.get(target.key);
      if (!p) {
        p = this.request(target).finally(() => this.inflight.delete(target.key));
        this.inflight.set(target.key, p);
      }
      try {
        fitted = await p;
      } catch (e) {
        // Unusable fits are never cached or sent; the reason stays on the presenter's screen.
        if (g === this.gen) {
          this.status(e instanceof FitError ? e.message
            : `Dub failed: ${String((e as Error)?.message ?? e).replace(/[.\s]+$/, "")}. The silent reveal still works.`);
        }
        return false;
      }
      this.cache.set(target.key, fitted);
    }
    if (g !== this.gen) {
      // Cancelled while waiting: never start stale audio. Keep it cached for a free replay.
      this.status("Dub arrived after the screen changed, so it didn't play. Hear it replays it from cache.");
      return false;
    }
    this.send({ t: "dub", key: fitted.key, reveal: target.reveal, pcm: fitted.pcm, sampleRate: fitted.sampleRate });
    this.status("Dub ready. It plays on the screen at the next loop.");
    return true;
  }

  cancel(note?: string) {
    this.gen++;
    this.send({ t: "dub-stop" });
    if (note) this.status(note);
  }
}

// ---------- projector playback ----------

/**
 * Projector side. Audio is unlocked once by a click during setup. A queued dub starts at the
 * next loop boundary, plays once in sync with the video, then the captioned loop resumes.
 */
/** The bits of a <video> the projector dub reads (a plain object in tests). */
export interface VideoClock { currentTime: number; paused: boolean; seeking: boolean }

const STALL_MS = 150; // no picture progress for this long = frozen
const RESYNC = 0.15; // audio/picture drift that triggers a restart at the picture's position

export class ScreenDub {
  private ctx: AudioContext | null = null;
  private pending: { key: string; reveal: number; buffer: AudioBuffer } | null = null;
  private active: { key: string; buffer: AudioBuffer; start: number; node: AudioBufferSourceNode | null; t0: number; prev: number; advancedAt: number } | null = null;

  /** Real browser defaults; tests pass a fake AudioContext and clock. */
  constructor(
    private createContext: () => AudioContext = () => new AudioContext(),
    private now: () => number = () => performance.now(),
  ) {}
  onState: (state: "queued" | "playing" | "done" | "stopped" | "no-audio", key?: string) => void = () => {};
  onCaptions: (show: boolean) => void = () => {};
  onAudio: () => void = () => {};

  get audioOn() {
    return this.ctx?.state === "running";
  }

  /** Call from a user gesture on the projector tab. */
  enable(): boolean {
    try {
      if (!this.ctx) {
        this.ctx = this.createContext();
        this.ctx.onstatechange = () => this.onAudio();
      }
      this.ctx.resume().then(() => this.onAudio(), () => {});
      const b = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      const s = this.ctx.createBufferSource();
      s.buffer = b;
      s.connect(this.ctx.destination);
      s.start();
    } catch {
      return false;
    }
    return true;
  }

  queue(m: Extract<DubMsg, { t: "dub" }>, reveal: number) {
    if (m.reveal !== reveal) return; // a different reveal is on screen now
    this.stop(false);
    if (!this.ctx || this.ctx.state !== "running") return this.onState("no-audio", m.key);
    const buffer = this.ctx.createBuffer(1, m.pcm.length, m.sampleRate);
    buffer.copyToChannel(m.pcm as Float32Array<ArrayBuffer>, 0);
    this.pending = { key: m.key, reveal: m.reveal, buffer };
    this.onState("queued", m.key);
  }

  /**
   * The loop just wrapped to `start`. The queued dub becomes active, but its audio only starts
   * once the video is visibly moving again (seeks on recorded clips can freeze for a moment).
   * If the loop wraps while a dub is active, that pass is over.
   */
  boundary(video: VideoClock, start: number) {
    if (this.active) this.finish("done");
    const p = this.pending;
    if (!p || !this.ctx) return;
    this.pending = null;
    this.active = { key: p.key, buffer: p.buffer, start, node: null, t0: 0, prev: video.currentTime, advancedAt: -Infinity };
    this.onCaptions(false);
    this.onState("playing", p.key);
    this.tick(video);
  }

  /**
   * Called from every animation frame and timeupdate, so two calls can see the same video time
   * during healthy playback; that alone never interrupts the audio. Audio follows the picture:
   * it stops when the video is paused, seeking, or has made no progress for STALL_MS, starts
   * only once the picture is moving, and restarts at the picture's position after drifting by
   * more than RESYNC.
   */
  tick(video: VideoClock) {
    const a = this.active;
    if (!a || !this.ctx) return;
    const t = video.currentTime, now = this.now();
    if (t > a.prev) a.advancedAt = now;
    a.prev = t;
    const moving = !video.paused && !video.seeking && now - a.advancedAt <= STALL_MS;
    const v = t - a.start;
    if (!moving || v < 0) {
      if (a.node) this.silence(a);
      return;
    }
    if (v >= a.buffer.duration - 0.03) return this.finish("done");
    const latency = (this.ctx as any).outputLatency || this.ctx.baseLatency || 0;
    const drift = a.node ? this.ctx.currentTime - a.t0 - (v + latency) : Infinity;
    if (Math.abs(drift) > RESYNC) this.playFrom(a, v + latency);
  }

  private playFrom(a: NonNullable<ScreenDub["active"]>, pos: number) {
    if (!this.ctx) return;
    if (a.node) this.silence(a);
    const node = this.ctx.createBufferSource();
    node.buffer = a.buffer;
    node.connect(this.ctx.destination);
    node.onended = () => {
      if (this.active === a && a.node === node) this.finish("done");
    };
    a.node = node;
    a.t0 = this.ctx.currentTime - pos;
    node.start(0, Math.max(0, pos));
  }

  private silence(a: NonNullable<ScreenDub["active"]>) {
    const n = a.node;
    a.node = null;
    if (n) {
      n.onended = null;
      try { n.stop(); } catch { /* already stopped */ }
    }
  }

  private finish(state: "done" | "stopped") {
    const a = this.active;
    this.active = null;
    if (a) this.silence(a);
    this.onCaptions(true);
    if (a) this.onState(state, a.key);
  }

  /** Cancel anything pending or playing and bring the captions straight back. */
  stop(report = true) {
    const had = !!(this.pending || this.active);
    this.pending = null;
    const a = this.active;
    this.active = null;
    if (a) this.silence(a);
    this.onCaptions(true);
    if (report && had) this.onState("stopped");
  }
}
