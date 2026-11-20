// Lip Service Worker: a thin proxy for Deepgram and Anthropic, plus the presenter-token check.
// Static assets (the app, lex.txt, block.json) are served by Workers Assets.
import Anthropic from "@anthropic-ai/sdk";

export interface Env {
  ASSETS: Fetcher;
  DEEPGRAM_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  PRESENTER_TOKEN?: string;
  RL_DG_IP: RateLimit;
  RL_DG_ALL: RateLimit;
  RL_AI_IP: RateLimit;
  RL_AI_ALL: RateLimit;
}

const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
// Opus 5.5 at medium effort writes whole lines; the browser checks them against the lips and
// sends back what doesn't fit for one round of small fixes. Thinking is always on for this model.
const MODEL = "claude-opus-5-5";
const MAX_OUTPUT_TOKENS = 8000;

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
  words: { w: string; shapes: string; syl: number }[];
  hints: { said: string; options: string[] }[];
  feedback?: { line: string; problems: { said: string; wrote: string }[]; unknown: string[] }[];
}

const SYSTEM = `You write captions for "Lip Service", a party game. A person was filmed saying a phrase. The clip loops on screen MUTED, and we caption it with a different line their mouth could just as well be saying, in the style of Bad Lip Reading (the YouTube channel).

Mouth-shape codes: P lips closed (p b m), F teeth on lip (f v), D tongue between teeth (th), T (t d n s z), L (l), K hidden (k g ng h y), J lips pushed out (sh zh ch j), R (r er), W tight round lips (w oo), O round open (o aw oy), U (ow as in now), A open (a u), I (eye), E spread (ee e i).

You get the spoken words, each with its shape codes and syllable count. A line FITS when it can be split, in order, into chunks that line up with the spoken words, where each chunk has exactly the same shape codes (repeated codes in a row count once) and the same number of syllables as the spoken words it covers. Chunks may re-split the sounds across word boundaries ("laptop" -> "lab top", "water bottle" -> "what a bottle"). One chunk per line may be off by a single non-P/F/W shape. "hints" lists some known fits for single spoken words and pairs; you may use them or find your own.

Write lines that:
- FIT the lips (the browser checks every line strictly; lines that don't fit are thrown away).
- Are a real, grammatical sentence a person could plausibly say, with a meaning you can picture. Oddly specific and a bit random is the goal; word salad is not.
- Change as many of the spoken words as possible while staying meaningful.
- Are funny from reading the caption alone, in silence. Mild only: nothing hateful, sexually explicit, or cruel about the speaker.
- Keep fillers like "oh", "um", "yeah" as spoken.

If "feedback" is present, it holds your earlier lines with the chunks that did NOT fit the lips (what was said, what you wrote) and any words missing from our dictionary. Fix each line with the smallest change: replace only the failing chunks with words that have exactly the needed shapes and syllables, keep everything that already fit, and keep the sentence making sense.

Return exactly 4 different lines in "lines".`;

const SCHEMA = {
  type: "object",
  properties: { lines: { type: "array", items: { type: "string" } } },
  required: ["lines"],
  additionalProperties: false,
};

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
    said: cut(body.said, 200),
    words: (body.words ?? []).slice(0, 16).map((w) => ({ w: cut(w.w, 30), shapes: cut(w.shapes, 40), syl: Number(w.syl) || 0 })),
    hints: (body.hints ?? []).slice(0, 24).map((h) => ({ said: cut(h.said, 40), options: (h.options ?? []).slice(0, 10).map((o) => cut(o, 40)) })),
    ...(body.feedback
      ? {
          feedback: body.feedback.slice(0, 4).map((f) => ({
            line: cut(f.line, 200),
            problems: (f.problems ?? []).slice(0, 8).map((p) => ({ said: cut(p.said, 60), wrote: cut(p.wrote, 60) })),
            unknown: (f.unknown ?? []).slice(0, 8).map((u) => cut(u, 30)),
          })),
        }
      : {}),
  };
  if (!input.said || !input.words.length) return json({ error: "empty" }, 400);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 90_000 });
  try {
    // Thinking is always on for Opus 5.5; medium effort. On a safety decline the API retries
    // on its default fallback model inside the same call.
    const res: any = await (client.beta.messages.create as any)({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [{ role: "user", content: JSON.stringify(input) }],
    });
    if (res.stop_reason === "refusal") return json({ lines: [], refused: true });
    const text = (res.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* cut off or invalid: return no lines and let the client retry or offer a retake */
    }
    const lines = Array.isArray(parsed?.lines) ? parsed.lines.slice(0, 6).map((l: any) => cut(l, 200)) : [];
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

function stageAuth(url: URL, env: Env): Response {
  const k = url.searchParams.get("k") ?? "";
  const ok = !!env.PRESENTER_TOKEN && k.length >= 8 && k === env.PRESENTER_TOKEN;
  return json({ ok }, ok ? 200 : 403);
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
