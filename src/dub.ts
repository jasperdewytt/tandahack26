// Stage dub: one timestamped ElevenLabs TTS call for a whole approved alibi line.
// Everything runs inside one Durable Object instance ("gate"), so limits, the in-flight
// dedupe and the cache are exact across the whole app. Presenter auth and input bounds are
// checked in the Worker before the request ever reaches the gate.

export const DUB_MODEL = "eleven_flash_v2_5"; // cheapest timestamp-capable tier ($0.04 / 1K chars)
export const DUB_FORMAT = "mp3_44100_128";
export const DUB_SETTINGS = { stability: 0.5, similarity_boost: 0.8, style: 0, use_speaker_boost: true, speed: 1 };
export const DUB_SEED = 4242;
export const PER_MINUTE = 5;
export const PER_DAY = 20;
const MAX_TEXT = 300;
const MAX_TOKENS = 40;

export interface DubInput { take: string; tokens: string[]; text: string }
export interface Alignment { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }
export interface DubResult { audio: string; alignment: Alignment; model: string; voice: string; key: string; cached?: boolean }

/** Bound and normalise a presenter's dub request. Returns null if it isn't acceptable. */
export function parseDub(body: any): DubInput | null {
  if (!body || typeof body !== "object") return null;
  const take = String(body.take ?? "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(take)) return null;
  if (!Array.isArray(body.tokens) || !body.tokens.length || body.tokens.length > MAX_TOKENS) return null;
  const tokens = body.tokens.map((t: unknown) => String(t ?? "").trim().slice(0, 40)).filter(Boolean);
  if (tokens.length !== body.tokens.length) return null;
  const text = dubText(tokens);
  if (text.length > MAX_TEXT || !/[a-z]/i.test(text)) return null;
  return { take, tokens, text };
}

/** The exact text sent to TTS: the tokens joined, first letter capitalised. */
export function dubText(tokens: string[]): string {
  const s = tokens.join(" ").replace(/\s+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Brisbane is UTC+10 all year (no daylight saving). */
export function brisbaneDay(now: number): string {
  return new Date(now + 10 * 3600_000).toISOString().slice(0, 10);
}

export async function cacheKey(input: DubInput, voiceId: string): Promise<string> {
  return sha(JSON.stringify({ take: input.take, text: input.text, voiceId, model: DUB_MODEL, format: DUB_FORMAT, settings: DUB_SETTINGS, seed: DUB_SEED }));
}

/** Minimal key-value storage (Durable Object storage or a Map in tests). */
export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

export type Synth = (input: DubInput) => Promise<{ ok: true; data: { audio_base64: string; alignment: Alignment | null; normalized_alignment?: Alignment | null } } | { ok: false; status: number; detail: string }>;

export type GateReply = { status: number; body: any };

/**
 * The gate: cache hit → free. Same request already running → share it. Otherwise reserve a
 * slot against the per-minute and per-Brisbane-day limits before calling ElevenLabs.
 */
export class DubGate {
  private inflight = new Map<string, Promise<GateReply>>();
  constructor(private store: Store, private synth: Synth, private voiceId: string, private now: () => number = Date.now) {}

  async dub(input: DubInput): Promise<GateReply> {
    const key = await cacheKey(input, this.voiceId);
    const hit = await this.store.get<DubResult>(`dub:${key}`);
    if (hit) return { status: 200, body: { ...hit, cached: true } };
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.fresh(input, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  async usage() {
    const now = this.now();
    const minute = ((await this.store.get<number[]>("minute")) ?? []).filter((t) => now - t < 60_000);
    const day = (await this.store.get<number>(`day:${brisbaneDay(now)}`)) ?? 0;
    return { minute: minute.length, day, perMinute: PER_MINUTE, perDay: PER_DAY };
  }

  private async fresh(input: DubInput, key: string): Promise<GateReply> {
    const now = this.now();
    const minute = ((await this.store.get<number[]>("minute")) ?? []).filter((t) => now - t < 60_000);
    const dayKey = `day:${brisbaneDay(now)}`;
    const day = (await this.store.get<number>(dayKey)) ?? 0;
    if (day >= PER_DAY) return { status: 429, body: { error: "day_limit", message: `Daily dub limit (${PER_DAY}) reached.` } };
    if (minute.length >= PER_MINUTE) return { status: 429, body: { error: "minute_limit", message: `Dub limit (${PER_MINUTE}/min) reached. Wait a minute.` } };
    // Reserve the slot before calling, so a failed or slow call still counts.
    await this.store.put("minute", [...minute, now]);
    await this.store.put(dayKey, day + 1);
    const r = await this.synth(input).catch((e) => ({ ok: false as const, status: 0, detail: String(e).slice(0, 200) }));
    if (!r.ok) return { status: 502, body: { error: "tts", status: r.status, message: `Voice synthesis failed (${r.status || "network"}).`, detail: r.detail } };
    const alignment = r.data.alignment ?? r.data.normalized_alignment;
    if (!r.data.audio_base64 || !alignment?.characters?.length) return { status: 502, body: { error: "tts_shape", message: "Voice synthesis returned no timings." } };
    const result: DubResult = { audio: r.data.audio_base64, alignment, model: DUB_MODEL, voice: (await sha(this.voiceId)).slice(0, 8), key };
    await this.store.put(`dub:${key}`, result);
    return { status: 200, body: result };
  }
}

export function elevenLabs(apiKey: string, voiceId: string): Synth {
  return async (input) => {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=${DUB_FORMAT}`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ text: input.text, model_id: DUB_MODEL, voice_settings: DUB_SETTINGS, seed: DUB_SEED }),
      },
    );
    if (!res.ok) return { ok: false, status: res.status, detail: (await res.text()).slice(0, 300) };
    return { ok: true, data: await res.json() };
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** Auth, method and size checks happen here, before the gate (and ElevenLabs) is touched. */
export async function dubRoute(req: Request, env: { ELEVENLABS_API_KEY?: string; ELEVENLABS_VOICE_ID?: string }, presenter: boolean, gate: () => { dub(i: DubInput): Promise<GateReply>; usage(): Promise<unknown> }): Promise<Response> {
  if (!presenter) return json({ error: "forbidden" }, 403);
  if (req.method === "GET") return json(await gate().usage());
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_VOICE_ID) return json({ error: "not_configured", message: "Dub voice isn't configured." }, 503);
  const len = Number(req.headers.get("content-length") ?? "0");
  if (!len || len > 4096) return json({ error: "too_big" }, 413);
  const text = await req.text();
  if (text.length > 4096) return json({ error: "too_big" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  const input = parseDub(body);
  if (!input) return json({ error: "bad_input", message: "Dub request out of bounds." }, 400);
  const r = await gate().dub(input);
  return json(r.body, r.status);
}

