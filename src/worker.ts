// Lip Service Worker: a thin proxy for Deepgram and Anthropic, plus presenter-token check.
// Static assets (the app and the viseme index) are served by Workers Assets.

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
  if (!a.success) return json({ error: "slow_down", message: "Too many tries from you. Wait a minute." }, 429, { "retry-after": "60" });
  if (!b.success) return json({ error: "busy", message: "Everyone is playing at once. Try again in a minute." }, 429, { "retry-after": "60" });
  return null;
}

async function transcribe(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_MEDIA_BYTES) return json({ error: "too_big", message: "Recording too large." }, 413);
  const rl = await limited(req, env.RL_DG_IP, env.RL_DG_ALL);
  if (rl) return rl;

  const type = (req.headers.get("content-type") ?? "application/octet-stream").split(";")[0];
  const url =
    "https://api.deepgram.com/v1/listen?model=nova-3&language=en&smart_format=true&punctuate=true&mip_opt_out=true";
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

interface AlibiReq {
  phrase: string[];
  slots: { i: number; word: string; exact: string[]; near: string[] }[];
}

const SYSTEM = `You write captions for "Lip Service", a party game. A person was filmed saying a short phrase. The clip loops on screen MUTED. We swap exactly one word in the caption for a word that the speaker's mouth visibly also fits, so viewers believe the person silently said the new line.

You get the phrase and, for some word positions ("slots"), a list of lip-compatible replacement words. "exact" words look identical on the lips; "near" words are one mouth shape off, so only use one when it is much funnier.

Pick the TWO funniest single-word swaps. Rules:
- Change exactly one word per swap, using a word copied exactly from that slot's lists.
- The new caption must be a grammatical, natural sentence a person might say.
- The joke must land from reading the caption alone, in silence: an absurdly specific detail, a sudden change of implication, or mild innuendo. Mild only: nothing hateful, sexual-explicit, or cruel about the speaker's looks.
- The two swaps should be different jokes (different slots if possible).

Reply with ONLY JSON, no prose: {"alibis":[{"slot":<slot index i>,"word":"<replacement>"},{"slot":<i>,"word":"<replacement>"}]}`;

async function alibi(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > 16_000) return json({ error: "too_big" }, 413);
  const rl = await limited(req, env.RL_AI_IP, env.RL_AI_ALL);
  if (rl) return rl;

  let body: AlibiReq;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  // Bound the prompt size regardless of what the client sends.
  const phrase = (body.phrase ?? []).slice(0, 14).map((w) => String(w).slice(0, 30));
  const slots = (body.slots ?? []).slice(0, 8).map((s) => ({
    i: Number(s.i),
    word: String(s.word).slice(0, 30),
    exact: (s.exact ?? []).slice(0, 40).map((w) => String(w).slice(0, 30)),
    near: (s.near ?? []).slice(0, 25).map((w) => String(w).slice(0, 30)),
  }));
  if (!phrase.length || !slots.length) return json({ error: "empty" }, 400);

  const user = JSON.stringify({ phrase: phrase.join(" "), words: phrase, slots });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 300);
    return json({ error: "anthropic", status: r.status, detail }, 502);
  }
  const data: any = await r.json();
  const text: string = (data?.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("");
  const m = text.match(/\{[\s\S]*\}/);
  let parsed: any = null;
  try {
    parsed = m ? JSON.parse(m[0]) : null;
  } catch {
    /* fall through */
  }
  const alibis = Array.isArray(parsed?.alibis)
    ? parsed.alibis.slice(0, 4).map((a: any) => ({ slot: Number(a.slot), word: String(a.word ?? "") }))
    : [];
  return json({ alibis });
}

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
