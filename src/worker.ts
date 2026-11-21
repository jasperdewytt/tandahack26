// Lip Service Worker: a thin proxy for Deepgram and Anthropic, plus the presenter-token check.
// Static assets (the app, lex.txt, block.json) are served by Workers Assets.
import Anthropic from "@anthropic-ai/sdk";
import { DurableObject } from "cloudflare:workers";
import { SYSTEM, EDITOR, SCHEMA, MODEL, EFFORT, MAX_OUTPUT_TOKENS } from "./prompt";
import { DubGate, elevenLabs, dubRoute, type DubInput, type GateReply } from "./dub";

export interface Env {
  ASSETS: Fetcher;
  DEEPGRAM_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  PRESENTER_TOKEN?: string;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICE_ID?: string;
  DUB: DurableObjectNamespace<DubGateDO>;
  RL_DG_IP: RateLimit;
  RL_DG_ALL: RateLimit;
  RL_AI_IP: RateLimit;
  RL_AI_ALL: RateLimit;
}

const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });

async function limited(req: Request, perIp: RateLimit, global: RateLimit): Promise<Response | null> {
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const [a, b] = await Promise.all([perIp.limit({ key: ip }), global.limit({ key: "all" })]);
  if (!a.success) return json({ error: "slow_down", message: "Too many tries from this device. Wait a minute, then try again." }, 429, { "retry-after": "60" });
  if (!b.success) return json({ error: "busy", message: "Lots of people are playing right now. Try again in a minute." }, 429, { "retry-after": "60" });
  return null;
}

// ---------- Deepgram ----------

async function transcribe(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_MEDIA_BYTES) return json({ error: "too_big", message: "That recording is too large. Keep it to about 10 seconds." }, 413);
  const rl = await limited(req, env.RL_DG_IP, env.RL_DG_ALL);
  if (rl) return rl;

  const type = (req.headers.get("content-type") ?? "application/octet-stream").split(";")[0];
  // No smart_format: numbers stay as words so they can be looked up by pronunciation.
  const url = "https://api.deepgram.com/v1/listen?model=nova-3&language=en&punctuate=true&mip_opt_out=true";
  // Buffer the (small) recording so a transient Deepgram failure can be retried once.
  const media = await req.arrayBuffer();
  const send = () =>
    fetch(url, {
      method: "POST",
      headers: { authorization: `Token ${env.DEEPGRAM_API_KEY}`, "content-type": type },
      body: media,
    });
  let dg = await send().catch(() => null);
  if (!dg || dg.status === 429 || dg.status >= 500) {
    await new Promise((r) => setTimeout(r, 1500)); // back off before the one retry
    dg = await send().catch(() => null);
  }
  if (!dg || !dg.ok) {
    const detail = dg ? (await dg.text()).slice(0, 300) : "network";
    console.log("deepgram failed", dg?.status, detail);
    return json(
      { error: "deepgram", status: dg?.status, detail, message: `Transcription didn't go through (code ${dg?.status ?? "network"}). Tap Retake to try again.` },
      502,
    );
  }
  const data: any = await dg.json();
  const alt = data?.results?.channels?.[0]?.alternatives?.[0];
  const words = (alt?.words ?? []).map((w: any) => ({
    w: w.word,
    p: w.punctuated_word ?? w.word,
    s: w.start,
    e: w.end,
  }));
  return json({ transcript: alt?.transcript ?? "", words, duration: data?.metadata?.duration ?? null });
}

// ---------- Anthropic ----------

interface AlibiReq {
  said: string; // the spoken phrase, as captioned
  topic?: string; // optional nudge for what the alibi should be about
  effort?: "low" | "medium"; // "low" is the fast first pass; anything else uses EFFORT
  words: { w: string; shapes: string; syl: number }[];
  hints: { said: string; options: string[] }[];
  targetSyllables?: number;
  candidates?: string[];
  feedback?: { line: string; note?: string; problems: { said: string; wrote: string }[]; unknown: string[] }[];
}

async function alibi(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > 40_000) return json({ error: "too_big" }, 413);
  const rl = await limited(req, env.RL_AI_IP, env.RL_AI_ALL);
  if (rl) return rl;

  let body: AlibiReq;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  // Bound the prompt regardless of what the client sends.
  const cut = (x: unknown, n: number) => String(x ?? "").slice(0, n);
  const input = {
    said: cut(body.said, 400),
    targetSyllables: Math.min(120, Math.max(0, Number(body.targetSyllables) || 0)),
    ...(body.topic ? { topic: cut(body.topic, 60) } : {}),
    words: (body.words ?? []).slice(0, 40).map((w) => ({ w: cut(w.w, 30), shapes: cut(w.shapes, 40), syl: Number(w.syl) || 0 })),
    hints: (body.hints ?? []).slice(0, 40).map((h) => ({ said: cut(h.said, 40), options: (h.options ?? []).slice(0, 10).map((o) => cut(o, 40)) })),
    ...(body.feedback
      ? {
          feedback: body.feedback.slice(0, 6).map((f) => ({
            line: cut(f.line, 400),
            note: cut(f.note, 160),
            problems: (f.problems ?? []).slice(0, 8).map((p) => ({ said: cut(p.said, 60), wrote: cut(p.wrote, 60) })),
            unknown: (f.unknown ?? []).slice(0, 8).map((u) => cut(u, 30)),
          })),
        }
      : {}),
  };
  const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, 8).map((line) => cut(line, 400)) : null;
  if (!input.said || !(candidates?.length || input.words.length)) return json({ error: "empty" }, 400);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 90_000 });
  try {
    // Thinking is always on for Opus 5.5; medium effort. On a safety decline the API retries
    // on its default fallback model inside the same call.
    const res: any = await (client.beta.messages.create as any)({
      model: MODEL,
      max_tokens: candidates ? 1200 : MAX_OUTPUT_TOKENS,
      output_config: { effort: candidates || body.effort === "low" ? "low" : EFFORT, format: { type: "json_schema", schema: SCHEMA } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: candidates ? EDITOR : SYSTEM,
      messages: [{ role: "user", content: JSON.stringify(candidates ? { said: input.said, topic: input.topic, candidates } : input) }],
    });
    if (res.stop_reason === "refusal") return json({ lines: [], refused: true });
    const text = (res.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* cut off or invalid: return no lines and let the client retry or offer a retake */
    }
    const lines = Array.isArray(parsed?.lines) ? parsed.lines.slice(0, 8).map((l: any) => cut(l, 400)) : [];
    return json({ lines, usage: { in: res.usage?.input_tokens, out: res.usage?.output_tokens } });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: "busy", message: "Lots of people are playing right now. Try again in a minute." }, 429);
    if (e instanceof Anthropic.APIError) {
      console.log("anthropic failed", e.status, String(e.message).slice(0, 300));
      return json({ error: "anthropic", status: e.status, message: "The alibi writer didn't answer. Tap Retake to try again." }, 502);
    }
    throw e;
  }
}

// ---------- presenter ----------

const isPresenter = (k: string, env: Env) => !!env.PRESENTER_TOKEN && k.length >= 8 && k === env.PRESENTER_TOKEN;

function stageAuth(url: URL, env: Env): Response {
  const ok = isPresenter(url.searchParams.get("k") ?? "", env);
  return json({ ok }, ok ? 200 : 403);
}

// ---------- stage dub (presenter only) ----------

/** One instance ("gate") holds the app-wide limits, the in-flight dedupe and the cache. */
export class DubGateDO extends DurableObject<Env> {
  private gate: DubGate | null = null;
  private get g(): DubGate {
    this.gate ??= new DubGate(
      { get: (k) => this.ctx.storage.get(k), put: (k, v) => this.ctx.storage.put(k, v) },
      elevenLabs(this.env.ELEVENLABS_API_KEY!, this.env.ELEVENLABS_VOICE_ID!),
      this.env.ELEVENLABS_VOICE_ID!,
    );
    return this.gate;
  }
  dub(input: DubInput): Promise<GateReply> {
    return this.g.dub(input);
  }
  usage() {
    return this.g.usage();
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      switch (url.pathname) {
        case "/api/transcribe":
          return await transcribe(req, env);
        case "/api/alibi":
          return await alibi(req, env);
        case "/api/dub":
          return await dubRoute(req, env, isPresenter(req.headers.get("x-presenter-key") ?? "", env), () => env.DUB.get(env.DUB.idFromName("gate")) as any);
        case "/api/stage":
          return stageAuth(url, env);
        case "/api/health":
          return json({ ok: true });
      }
      if (url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);
      return env.ASSETS.fetch(req);
    } catch (e) {
      return json({ error: "server", message: String(e).slice(0, 200) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
