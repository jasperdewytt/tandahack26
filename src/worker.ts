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
const MODEL = "claude-sonnet-5-5";
// Thinking plus the answer. Raised from 400 after the phone test: without room to plan,
// whole-line rewrites came out as word salad. ~US$0.02-0.03 per call; RL_AI_ALL caps the rate.
const MAX_OUTPUT_TOKENS = 6000;

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
  if (!dg || dg.status === 429 || dg.status >= 500) dg = await send().catch(() => null);
  if (!dg || !dg.ok) {
    const detail = dg ? (await dg.text()).slice(0, 300) : "network";
    console.log("deepgram failed", dg?.status, detail);
    return json(
      { error: "deepgram", status: dg?.status, detail, message: "Transcription didn't go through. Tap Retake to try again." },
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
  phrase: string[];
  slots: { id: string; said: string; exact: string[]; near: string[] }[];
}

const SYSTEM = `You write captions for "Lip Service", a party game. A person was filmed saying a phrase. The clip loops on screen MUTED. We rewrite the caption using only words the speaker's mouth visibly also fits, so viewers believe the person silently said a completely different line, like Bad Lip Reading.

You get the phrase as a words array, and "slots": each slot covers one or two adjacent spoken words ("said") and lists text that makes the same mouth shapes. An option can be one word or two words, so a slot can re-split the sounds ("water bottle" -> "what a bottle"). "exact" options look identical on the lips. "near" options are one mouth shape off: use at most ONE near option per alibi. Slots can overlap; never use two slots that cover the same spoken word.

Write the TWO funniest alibis, in the style of Bad Lip Reading (the YouTube channel): the person confidently says something oddly specific, a bit random and surreal, but every line is still a real sentence with a meaning you could picture.
- Sense comes first. Read each finished caption aloud in your head: it must be a sentence a real person could plausibly say, with a meaning someone could picture (absurd is fine). Every phrase must work grammatically on its own: "my kids" yes, "bye kids" in a list of belongings no; "a pink monk" yes, "buy laptop" no. Random is good; nonsense is not.
- Within that, change as many spoken words as you can, usually four or more, so it reads as a genuinely different line. Re-splits and small words ("my" -> "by", "and" -> "at") help, but only where the grammar still works. Keep a word as spoken rather than force a swap that breaks the sentence.
- Try several candidate lines, score each on "makes sense", "funny" and "how much changed", then pick the two best. Use only options copied exactly from a slot's lists; words you don't cover stay as spoken. Before answering, check every swap's "words" appears verbatim in that slot's list and that no two used slots cover the same spoken word.
- The joke must land from reading the caption alone, in silence: an absurdly specific scenario, a sudden change of implication, or mild innuendo. Keep it mild: nothing hateful, sexually explicit, or cruel about the speaker.
- The two alibis should be different jokes.
- Output only "swaps" for each alibi: every slot you used, by its "id", with the option text in "words".`;

const SCHEMA = {
  type: "object",
  properties: {
    alibis: {
      type: "array",
      items: {
        type: "object",
        properties: {
          swaps: {
            type: "array",
            items: {
              type: "object",
              properties: { id: { type: "string" }, words: { type: "string" } },
              required: ["id", "words"],
              additionalProperties: false,
            },
          },
        },
        required: ["swaps"],
        additionalProperties: false,
      },
    },
  },
  required: ["alibis"],
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
  const phrase = (body.phrase ?? []).slice(0, 16).map((w) => String(w).slice(0, 30));
  const slots = (body.slots ?? []).slice(0, 22).map((s) => ({
    id: String(s.id).slice(0, 6),
    said: String(s.said).slice(0, 40),
    exact: (s.exact ?? []).slice(0, 20).map((w) => String(w).slice(0, 40)),
    near: (s.near ?? []).slice(0, 6).map((w) => String(w).slice(0, 40)),
  }));
  if (!phrase.length || !slots.length) return json({ error: "empty" }, 400);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 60_000 });
  try {
    // Adaptive thinking at high effort (medium sometimes skipped planning): building a coherent line from lip-locked options
    // needs planning. On a safety decline the API retries on its default fallback model.
    const res: any = await (client.beta.messages.create as any)({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [{ role: "user", content: JSON.stringify({ words: phrase, slots }) }],
    });
    if (res.stop_reason === "refusal") return json({ alibis: [], refused: true });
    const text = (res.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* invalid output: return nothing and let the client offer a retake */
    }
    const alibis = Array.isArray(parsed?.alibis)
      ? parsed.alibis.slice(0, 4).map((a: any) => ({
          swaps: (Array.isArray(a.swaps) ? a.swaps : [])
            .slice(0, 12)
            .map((s: any) => ({ id: String(s.id ?? ""), words: String(s.words ?? "").slice(0, 40) })),
        }))
      : [];
    // max_tokens cut-offs return invalid JSON above, so they surface as "no alibi" rather than half a caption.
    return json({ alibis, usage: { in: res.usage?.input_tokens, out: res.usage?.output_tokens } });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: "busy", message: "Lots of people are playing right now. Try again in a minute." }, 429);
    if (e instanceof Anthropic.APIError) { console.log("anthropic failed", e.status, String(e.message).slice(0, 300)); return json({ error: "anthropic", status: e.status, detail: String(e.message).slice(0, 300), message: "The alibi writer didn't answer. Tap Retake to try again." }, 502); }
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
