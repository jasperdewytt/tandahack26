import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { build } from "esbuild";

// Word-onset accuracy of the real fitter + renderer, using the one saved ElevenLabs response
// (testdata/dub-response.json, gitignored; skipped if absent). A short tone burst, each word its
// own frequency, is placed at every ElevenLabs word onset. After fit(), we find each burst in the
// output and compare it with the Deepgram start of the spoken word it should land on.
//   node scripts/test-dub-onsets.mjs [--report]
const FILE = "testdata/dub-response.json";
if (!existsSync(FILE)) {
  console.log(`Onset check skipped: ${FILE} not found.`);
  process.exit(0);
}
const b = await build({ entryPoints: ["app/dub.ts"], bundle: true, format: "esm", write: false, platform: "neutral" });
const app = await import("data:text/javascript;base64," + Buffer.from(b.outputFiles[0].contents).toString("base64"));
const f = JSON.parse(readFileSync(FILE, "utf8"));
const sr = 44100;
const BURST = 0.02;
const freq = (k) => 700 + 150 * k;

const times = app.tokenTimes(f.tokens, f.response.alignment);
const total = times[times.length - 1].e + 0.3;
const pcm = new Float32Array(Math.round(total * sr));
times.forEach((t, k) => {
  const a = Math.round(t.s * sr), n = Math.round(BURST * sr);
  for (let i = 0; i < n && a + i < pcm.length; i++) {
    pcm[a + i] += 0.4 * Math.sin((2 * Math.PI * freq(k) * i) / sr) * Math.sin((Math.PI * i) / n);
  }
});

/** First time the k-th burst's band power reaches 30% of its peak (Goertzel, 8 ms windows, 2 ms hop). */
function onset(x, k) {
  const w = Math.round(0.008 * sr), hop = Math.round(0.002 * sr);
  const coeff = 2 * Math.cos((2 * Math.PI * freq(k)) / sr);
  const pw = [];
  for (let a = 0; a + w <= x.length; a += hop) {
    let s1 = 0, s2 = 0;
    for (let i = 0; i < w; i++) { const s = x[a + i] + coeff * s1 - s2; s2 = s1; s1 = s; }
    pw.push(s1 * s1 + s2 * s2 - coeff * s1 * s2);
  }
  const peak = Math.max(...pw);
  const i = pw.findIndex((p) => p >= 0.3 * peak);
  return (i * hop + w) / sr;
}

// Detector bias, measured on the unprocessed input.
const bias = times.map((t, k) => onset(pcm, k) - t.s);

let segments;
let out;
let failure = null;
try {
  ({ pcm: out, segments } = app.fit({
    words: f.words, tokens: f.tokens, chunks: f.chunks, alignment: f.response.alignment,
    start: f.start, playEnd: Math.min(f.end, f.duration), pcm, sampleRate: sr,
    closedSaid: f.closedSaid, closedWrote: f.closedWrote,
  }));
} catch (e) {
  failure = e;
}
assert(!failure, `fit failed on the saved response: ${failure?.message}`);

// Where each token should land: the start of its spoken word (first token of each chunk; for
// 1:1 chunks every token). Other tokens in many-to-one chunks have no single lip target.
const target = new Map();
for (const c of f.chunks) {
  if (c.s1 - c.s0 === c.w1 - c.w0) for (let k = 0; k < c.w1 - c.w0; k++) target.set(c.w0 + k, c.s0 + k);
  else target.set(c.w0, c.s0);
}
const rows = f.tokens.map((tok, k) => {
  const s = target.get(k);
  const want = s === undefined ? null : Math.max(f.start, f.words[s].s) - f.start;
  const got = onset(out, k) - bias[k];
  return { tok, said: s === undefined ? "" : f.words[s].w, want, got, err: want === null ? null : got - want };
});
const report = process.argv.includes("--report");
if (report) {
  console.log("segments:", segments.map((s) => `${s.dst0.toFixed(2)}-${s.dst1.toFixed(2)}${s.knots?.length ? ` (${s.knots.length} knots)` : ""}`).join("  "));
  for (const r of rows) {
    console.log(`${r.tok.padEnd(14)} ${r.said.padEnd(12)} want ${r.want === null ? "  -  " : r.want.toFixed(3)}  got ${r.got.toFixed(3)}  err ${r.err === null ? "  -" : `${Math.round(r.err * 1000)} ms`}`);
  }
}
const named = ["laptop", "most", "wedding"].map((w) => rows.find((r) => r.tok === w));
console.log("Onsets:", named.map((r) => `${r.tok} ${Math.round(r.err * 1000)} ms`).join(", "));
for (const r of named) assert(Math.abs(r.err) <= 0.06, `${r.tok} lands ${Math.round(r.err * 1000)} ms off`);
const worst = Math.max(...rows.filter((r) => r.err !== null).map((r) => Math.abs(r.err)));
console.log(`Worst aligned-word error: ${Math.round(worst * 1000)} ms. Onset checks passed.`);
