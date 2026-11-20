// Run the real alibi pipeline on a transcript from the command line, calling Anthropic directly
// with the Worker's prompt (src/prompt.ts), so prompt changes can be tried without deploying.
//   node scripts/try-alibi.mjs testdata/transcript.json [--topic "pirates"] [--runs 2] [--effort high]
// The transcript is the JSON /api/transcribe returns. Needs ANTHROPIC_API_KEY in .env.
import { build } from "esbuild";
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const transcriptPath = args.find((a) => !a.startsWith("--") && a.endsWith(".json"));
if (!transcriptPath) throw new Error("usage: node scripts/try-alibi.mjs <transcript.json> [--topic t] [--runs n]");

// Bundle the TypeScript modules once into a cache folder.
const out = join(root, "node_modules", ".cache", "try-alibi");
mkdirSync(out, { recursive: true });
await build({
  stdin: {
    contents: `export * from "./app/pipeline"; export { Lexicon } from "./app/lexicon"; export { Blocklist } from "./app/blocklist"; export * as prompt from "./src/prompt";`,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: join(out, "bundle.mjs"),
  logLevel: "error",
});
const mod = await import(pathToFileURL(join(out, "bundle.mjs")).href);

// The browser modules fetch their data files; serve them from public/ while loading.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const body = readFileSync(join(root, "public", String(url).replace(/^\//, "")), "utf8");
  return { ok: true, text: async () => body, json: async () => JSON.parse(body) };
};
const [lex, block] = await Promise.all([mod.Lexicon.load(), mod.Blocklist.load()]);
globalThis.fetch = realFetch;

const key = readFileSync(join(root, ".env"), "utf8").match(/^ANTHROPIC_API_KEY=(.*)$/m)[1].trim();
const client = new Anthropic({ apiKey: key });
const { SYSTEM, SCHEMA, MODEL, EFFORT, MAX_OUTPUT_TOKENS } = mod.prompt;
const usage = [];
const post = async (_path, body) => {
  const t = Date.now();
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    output_config: { effort: opt("--effort", EFFORT), format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content: body }],
  });
  usage.push({ ms: Date.now() - t, out: res.usage.output_tokens });
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    return JSON.parse(text);
  } catch {
    console.log("  (writer reply unusable:", res.stop_reason + ")");
    return { lines: [] };
  }
};

const tr = JSON.parse(readFileSync(transcriptPath, "utf8"));
const ranked = mod.rankPhrases(tr.words, lex, block, tr.duration ?? Infinity);
const chosen = ranked[0];
console.log("SAID:", mod.caption(chosen.phrase.words.map((w) => w.p)), `(${(chosen.phrase.end - chosen.phrase.start).toFixed(1)} s)`);
const topic = opt("--topic", "");
for (let run = 0; run < Number(opt("--runs", "1")); run++) {
  const log = [];
  const alibis = await mod.writeAlibis(chosen, lex, block, post, () => {}, log, topic);
  console.log(`\nrun ${run + 1}${topic ? ` (topic: ${topic})` : ""}`);
  for (const l of log) console.log(`  r${l.round} ${l.ok ? "FITS " : "miss "} ${l.line}${l.ok ? "" : "   <- " + l.problems.map((p) => `"${p.said}"≠"${p.wrote}"`).join(", ")}`);
  console.log("  SHOWN:", alibis.map((a) => a.text));
}
console.log("\ncalls:", JSON.stringify(usage));
