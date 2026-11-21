// Stage dub, browser side: map TTS character timings back to the alibi's tokens, fit the
// synthesized line onto the speaker's lip timings (pitch-preserving WSOLA, absolute offsets
// from phrase.start), and the presenter-side controller that makes stale audio impossible.
import { clean } from "./lexicon";
import type { Word } from "./phrase";

export interface Alignment { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }
export interface Chunk { s0: number; s1: number; w0: number; w1: number }
export interface Span { s: number; e: number }
/** A piece of TTS audio [src0, src1) placed at media time [dst0, dst1). */
export interface Segment { src0: number; src1: number; dst0: number; dst1: number }

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

/**
 * Chunk-level anchors, refined to single words where the counts match. The first visible lip
 * closure becomes its own anchor; tiny neighbours are merged unless a pause separates them.
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
  if (!closureDone && p.closedSaid) closureDone = true;

  let segs: Segment[] = [];
  for (const [s0, s1, w0, w1] of pairs) {
    const dst0 = Math.max(p.start, p.words[s0].s);
    const dst1 = Math.min(p.playEnd, p.words[s1 - 1].e);
    if (dst1 - dst0 < 0.02) continue;
    const src0 = p.times[w0].s;
    const next = p.times[w1]?.s ?? Infinity;
    const src1 = Math.max(src0 + 0.01, Math.min(p.times[w1 - 1].e + SRC_PAD, next));
    segs.push({ src0, src1, dst0, dst1 });
  }

  // Merge tiny pieces into the neighbour they touch most closely (never across a pause).
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s.dst1 - s.dst0 >= TINY_DST && s.src1 - s.src0 >= TINY_SRC) continue;
      const gapL = i > 0 ? s.dst0 - segs[i - 1].dst1 : Infinity;
      const gapR = i + 1 < segs.length ? segs[i + 1].dst0 - s.dst1 : Infinity;
      const j = gapL <= gapR ? i - 1 : i + 1;
      if (Math.min(gapL, gapR) >= PAUSE) continue;
      const [a, b] = j < i ? [segs[j], s] : [s, segs[j]];
      segs.splice(Math.min(i, j), 2, { src0: a.src0, src1: b.src1, dst0: a.dst0, dst1: b.dst1 });
      changed = true;
      break;
    }
  }
  return segs;
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

/** Stretch x to outLen samples without changing pitch. */
export function stretch(x: Float32Array, outLen: number, sr: number): Float32Array {
  if (outLen <= 0) return new Float32Array(0);
  const N = 2 * Math.round(0.015 * sr); // 30 ms frames
  const H = N / 2;
  if (x.length < 2 * N || outLen < 2 * N) return resample(x, outLen);
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const n = x.length;
  const alpha = (n - N) / Math.max(1, outLen - N);
  const tol = Math.round(0.008 * sr);
  const out = new Float32Array(outLen + N);
  const norm = new Float32Array(outLen + N);
  let prev = 0;
  for (let o = 0; o < outLen; o += H) {
    let pos = 0;
    if (o > 0) {
      const ideal = Math.min(n - N, Math.round(o * alpha));
      const nat = prev + H;
      let best = ideal, bestC = -Infinity;
      const lo = Math.max(0, ideal - tol), hi = Math.min(n - N, ideal + tol);
      for (let c = lo; c <= hi; c += 2) {
        let s = 0;
        for (let i = 0; i < H && nat + i < n; i += 4) s += x[c + i] * x[nat + i];
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

const MIN_RATE = 0.45; // dst/src: at most ~2.2x faster
const MAX_RATE = 2.0; // at most 2x slower
const FADE = 0.012;

/**
 * Place every segment at its absolute offset from `start` (so errors never accumulate).
 * Fades stay inside each segment's own window; anything that can't fit is faded out.
 */
export function render(pcm: Float32Array, sr: number, segs: Segment[], start: number, playEnd: number): Float32Array {
  const out = new Float32Array(Math.max(0, Math.round((playEnd - start) * sr)));
  for (const s of segs) {
    const a = Math.max(0, Math.round(s.src0 * sr)), b = Math.min(pcm.length, Math.round(s.src1 * sr));
    if (b - a < 8) continue;
    const L = Math.round((s.dst1 - s.dst0) * sr);
    const rate = Math.min(MAX_RATE, Math.max(MIN_RATE, L / (b - a)));
    const piece = stretch(pcm.subarray(a, b), Math.round((b - a) * rate), sr);
    const off = Math.round((s.dst0 - start) * sr);
    const len = Math.min(piece.length, L, out.length - off);
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
        if (g === this.gen) this.status(`Dub failed: ${(e as Error).message ?? e}. The silent reveal still works.`);
        return false;
      }
      this.cache.set(target.key, fitted);
    }
    if (g !== this.gen) return false; // cancelled while waiting: never start stale audio
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
export class ScreenDub {
  private ctx: AudioContext | null = null;
  private pending: { key: string; reveal: number; buffer: AudioBuffer } | null = null;
  private src: AudioBufferSourceNode | null = null;
  onState: (state: "queued" | "playing" | "done" | "stopped" | "no-audio", key?: string) => void = () => {};
  onCaptions: (show: boolean) => void = () => {};

  get audioOn() {
    return this.ctx?.state === "running";
  }

  /** Call from a user gesture on the projector tab. */
  enable(): boolean {
    try {
      this.ctx ??= new AudioContext();
      this.ctx.resume().catch(() => {});
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

  /** The loop just wrapped to `start`; begin the queued dub once the seek lands. */
  boundary(video: HTMLVideoElement, start: number) {
    const p = this.pending;
    if (!p || !this.ctx) return;
    this.pending = null;
    const go = () => {
      if (!this.ctx) return;
      const src = this.ctx.createBufferSource();
      src.buffer = p.buffer;
      src.connect(this.ctx.destination);
      const latency = (this.ctx as any).outputLatency || this.ctx.baseLatency || 0;
      const offset = Math.max(0, video.currentTime - start + latency);
      src.onended = () => {
        if (this.src !== src) return;
        this.src = null;
        this.onCaptions(true);
        this.onState("done", p.key);
      };
      this.src = src;
      this.onCaptions(false);
      src.start(0, offset);
      this.onState("playing", p.key);
    };
    if (video.seeking) video.addEventListener("seeked", go, { once: true });
    else go();
  }

  /** Cancel anything pending or playing and bring the captions straight back. */
  stop(report = true) {
    const had = !!(this.pending || this.src);
    this.pending = null;
    if (this.src) {
      const s = this.src;
      this.src = null;
      try { s.stop(); } catch { /* already stopped */ }
    }
    this.onCaptions(true);
    if (report && had) this.onState("stopped");
  }
}
