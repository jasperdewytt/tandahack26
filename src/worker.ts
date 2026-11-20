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
const MAX_OUTPUT_TOKENS = 400;

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
  const dg = await fetch(url, {
    method: "POST",
    headers: { authorization: `Token ${env.DEEPGRAM_API_KEY}`, "content-type": type },
    body: req.body,
  });
  if (!dg.ok) {
    const detail = (await dg.text()).slice(0, 300);
    return json({ error: "deepgram", status: dg.status, detail }, 502);
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
  slots: { i: number; word: string; exact: string[]; near: string[] }[];
}

const SYSTEM = `You write captions for "Lip Service", a party game. A person was filmed saying a phrase. The clip loops on screen MUTED. We rewrite the caption using only words the speaker's mouth visibly also fits, so viewers believe the person silently said a completely different line.

You get the phrase as a words array and, for each content word ("slots", where "i" indexes into the words array), lists of lip-compatible replacements. "exact" words look identical on the lips. "near" words are one mouth shape off: use at most ONE near word per alibi. Words that are not slots (the, my, and, I...) stay exactly as they are.

Write the TWO funniest alibis:
- Replace as many slots as you can, each with a word copied exactly from that slot's lists. Keep an original word (leave it out of "swaps") when no option makes sense.
- Most important: the result must be ONE coherent, grammatical sentence that a real person might plausibly say out loud, with a clear meaning. A sensible line with fewer swaps beats a nonsense line with more. Never output word salad like "a pick punk of tongues".
- Each "slot" in swaps is the slot's "i" value (its position in the words array), not its order in the slots list.
- The joke must land from reading the caption alone, in silence: an absurdly specific scenario, a sudden change of implication, or mild innuendo. Keep it mild: nothing hateful, sexually explicit, or cruel about the speaker.
- The two alibis should be different jokes.
- "line" is the full new caption; "swaps" lists every replaced slot.`;

const SCHEMA = {
  type: "object",
  properties: {
    alibis: {
      type: "array",
      items: {
        type: "object",
        properties: {
          line: { type: "string" },
          swaps: {
            type: "array",
            items: {
              type: "object",
              properties: { slot: { type: "integer" }, word: { type: "string" } },
              required: ["slot", "word"],
              additionalProperties: false,
            },
          },
        },
        required: ["line", "swaps"],
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
  if (len > 24_000) return json({ error: "too_big" }, 413);
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
  const slots = (body.slots ?? []).slice(0, 12).map((s) => ({
    i: Number(s.i),
    word: String(s.word).slice(0, 30),
    exact: (s.exact ?? []).slice(0, 20).map((w) => String(w).slice(0, 30)),
    near: (s.near ?? []).slice(0, 8).map((w) => String(w).slice(0, 30)),
  }));
  if (!phrase.length || !slots.length) return json({ error: "empty" }, 400);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 25_000 });
  try {
    // Thinking off ("between_tools") so the 400-token cap goes to the answer; on a
    // safety decline the API retries on its default fallback model inside the same call.
    const res: any = await (client.beta.messages.create as any)({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      thinking: { type: "between_tools" },
      // Medium effort: making every swap fit one coherent sentence is harder than a single swap.
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
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
          line: String(a.line ?? "").slice(0, 200),
          swaps: (Array.isArray(a.swaps) ? a.swaps : [])
            .slice(0, 12)
            .map((s: any) => ({ slot: Number(s.slot), word: String(s.word ?? "").slice(0, 30) })),
        }))
      : [];
    // max_tokens cut-offs return invalid JSON above, so they surface as "no alibi" rather than half a caption.
    return json({ alibis, usage: { in: res.usage?.input_tokens, out: res.usage?.output_tokens } });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: "busy", message: "Lots of people are playing right now. Try again in a minute." }, 429);
    if (e instanceof Anthropic.APIError) return json({ error: "anthropic", status: e.status, detail: String(e.message).slice(0, 300) }, 502);
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
