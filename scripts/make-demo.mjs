// Build the dubbed demo from one recorded take, with the app's own pipeline (phrase picking,
// writer + lip check + editor, ElevenLabs timestamps, fit). Calls Deepgram, Anthropic and
// ElevenLabs directly with the keys in .env (paid, a few cents). Needs ffmpeg on PATH.
//   node scripts/make-demo.mjs testdata/demo/take.mp4 [--redo]
// Step 1 writes <dir>/plan.json (transcript, stretches, alibis). Edit "pick" in it to choose
// alibis, then run again: step 2 dubs each stretch and writes <dir>/dub.wav (full take length).
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const take = args.find((a) => !a.startsWith("--"));
if (!take) throw new Error("usage: node scripts/make-demo.mjs <take.mp4> [--redo]");
const dir = dirname(take);
const planPath = join(dir, "plan.json");
const env = Object.fromEntries(readFileSync(join(root, ".env"), "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));

const out = join(root, "node_modules", ".cache", "make-demo");
mkdirSync(out, { recursive: true });
await build({
  stdin: {
    contents: `export * from "./app/pipeline"; export * from "./app/phrase"; export { fit, wav } from "./app/dub"; export { Lexicon } from "./app/lexicon"; export { Blocklist } from "./app/blocklist"; export * as prompt from "./src/prompt"; export * as sdub from "./src/dub";`,
    resolveDir: root, loader: "ts",
  },
  bundle: true, format: "esm", platform: "node", outfile: join(out, "bundle.mjs"), logLevel: "error",
});
const mod = await import(pathToFileURL(join(out, "bundle.mjs")).href + "?" + Date.now());
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const body = readFileSync(join(root, "public", String(url).replace(/^\//, "")), "utf8");
  return { ok: true, text: async () => body, json: async () => JSON.parse(body) };
};
const [lex, block] = await Promise.all([mod.Lexicon.load(), mod.Blocklist.load()]);
globalThis.fetch = realFetch;

const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", take]).toString());

if (!existsSync(planPath) || args.includes("--redo")) {
  // ---- 1. transcribe ----
  const audio = execFileSync("ffmpeg", ["-v", "error", "-i", take, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", "-"], { maxBuffer: 1 << 28 });
  const dg = await fetch("https://api.deepgram.com/v1/listen?model=nova-3&language=en&punctuate=true&mip_opt_out=true", {
    method: "POST", headers: { authorization: `Token ${env.DEEPGRAM_API_KEY}`, "content-type": "audio/wav" }, body: audio,
  });
  if (!dg.ok) throw new Error("deepgram " + dg.status + " " + (await dg.text()));
  const alt = (await dg.json()).results.channels[0].alternatives[0];
  const words = alt.words.map((w) => ({ w: w.word, p: w.punctuated_word ?? w.word, s: w.start, e: w.end }));
  console.log("SAID:", alt.transcript);

  // ---- 2. cover the take with non-overlapping stretches, best-ranked first ----
  const ranked = mod.rankPhrases(words, lex, block, duration);
  const chosen = [];
  for (const r of ranked) {
    const a = r.phrase.words[0].s, b = r.phrase.words.at(-1).e;
    if (chosen.some((c) => !(b <= c.phrase.words[0].s || a >= c.phrase.words.at(-1).e))) continue;
    chosen.push(r);
  }
  chosen.sort((x, y) => x.phrase.start - y.phrase.start);

  // ---- 3. alibis per stretch ----
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const { SYSTEM, EDITOR, SCHEMA, MODEL, EFFORT, MAX_OUTPUT_TOKENS } = mod.prompt;
  const post = async (_p, body) => {
    const editing = Array.isArray(JSON.parse(body).candidates);
    const res = await client.messages.create({
      model: MODEL, max_tokens: editing ? 1200 : MAX_OUTPUT_TOKENS,
      output_config: { effort: editing ? "low" : EFFORT, format: { type: "json_schema", schema: SCHEMA } },
      system: editing ? EDITOR : SYSTEM, messages: [{ role: "user", content: body }],
    });
    try { return JSON.parse(res.content.filter((b) => b.type === "text").map((b) => b.text).join("")); } catch { return { lines: [] }; }
  };
  const stretches = await Promise.all(chosen.map(async (r) => {
    const log = [];
    const alibis = await mod.writeAlibis(r, lex, block, post, () => {}, log);
    // Also keep every line that fit the lips, so there is more to choose from.
    const extra = [];
    for (const l of log) {
      if (!l.ok || alibis.some((a) => a.text === l.line) || extra.some((a) => a.text === l.line)) continue;
      const tokens = l.line.split(/\s+/).filter(Boolean);
      const chk = lex.check(r.phrase.words.map((w) => w.w), tokens);
      if (chk.ok) extra.push({ text: mod.caption(tokens), tokens, chunks: chk.chunks });
    }
    return {
      phrase: r.phrase, said: mod.caption(r.phrase.words.map((w) => w.p)),
      alibis: [...alibis.map((a) => ({ text: a.text, tokens: a.tokens, chunks: a.chunks })), ...extra],
      pick: 0,
    };
  }));
  writeFileSync(planPath, JSON.stringify({ take, duration, transcript: alt.transcript, words, stretches }, null, 1));
  for (const [i, s] of stretches.entries()) {
    console.log(`\n[${i}] ${s.phrase.start.toFixed(2)}–${s.phrase.end.toFixed(2)} s  SAID: ${s.said}`);
    s.alibis.forEach((a, k) => console.log(`   ${k === s.pick ? "*" : " "}${k}: ${a.text}`));
  }
  console.log(`\nWrote ${planPath}. Set "pick" per stretch (or -1 to leave it undubbed), then run again.`);
  process.exit(0);
}

// ---- 4. dub the picks ----
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const sr = 44100;
const full = new Float32Array(Math.ceil(plan.duration * sr));
const closed = (ws) => ws.map((w) => !!lex.shapesOf([w])?.key.includes("P"));
const cues = [];
for (const [i, s] of plan.stretches.entries()) {
  const a = s.alibis[s.pick];
  if (!a) continue;
  const cachePath = join(dir, `tts-${i}-${s.pick}.json`);
  let data;
  if (existsSync(cachePath)) data = JSON.parse(readFileSync(cachePath, "utf8"));
  else {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(env.ELEVENLABS_VOICE_ID)}/with-timestamps?output_format=${mod.sdub.DUB_FORMAT}`, {
      method: "POST", headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ text: mod.sdub.dubText(a.tokens), model_id: mod.sdub.DUB_MODEL, voice_settings: mod.sdub.DUB_SETTINGS, seed: mod.sdub.DUB_SEED }),
    });
    if (!res.ok) throw new Error("elevenlabs " + res.status + " " + (await res.text()));
    data = await res.json();
    writeFileSync(cachePath, JSON.stringify(data));
  }
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-ac", "1", "-ar", String(sr), "-f", "f32le", "-"], { input: Buffer.from(data.audio_base64, "base64"), maxBuffer: 1 << 28 });
  const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const playEnd = Math.min(s.phrase.end, plan.duration);
  const fitted = mod.fit({
    words: s.phrase.words, tokens: a.tokens, chunks: a.chunks, alignment: data.alignment,
    start: s.phrase.start, playEnd, pcm, sampleRate: sr,
    closedSaid: closed(s.phrase.words.map((w) => w.w)), closedWrote: closed(a.tokens),
  });
  // fitted.pcm starts at phrase.start on the media timeline.
  const off = Math.round(s.phrase.start * sr);
  for (let k = 0; k < fitted.pcm.length && off + k < full.length; k++) full[off + k] += fitted.pcm[k];
  console.log(`[${i}] dubbed: ${a.text}`);
  const tokSyl = lex.describe(a.tokens).map((w) => w.syl);
  const saidSyl = lex.describe(s.phrase.words.map((w) => w.w)).map((w) => w.syl);
  cues.push(...mod.cuesFor(s.phrase.words, a.tokens, a.chunks, s.phrase, saidSyl, tokSyl));
}
writeFileSync(join(dir, "dub.wav"), Buffer.from(await mod.wav(full, sr).arrayBuffer()));
// Original captions for the whole take, using the same rules, phrase by pause-run.
const said = plan.stretches.flatMap((s) => mod.originalCues(s.phrase));
writeFileSync(join(dir, "cues.json"), JSON.stringify({ said, alibi: cues, stretches: plan.stretches.map((s) => [s.phrase.start, s.phrase.end]) }, null, 1));
console.log(`Wrote ${join(dir, "dub.wav")} and cues.json`);
