// Synthetic offline sample (no person, no paid calls) for verifying the offline presenter flow.
// Writes testdata/offline-fixture/ (gitignored): a test-pattern clip, sample.json with two
// alibis (alibi 1 has a fitted dub, alibi 2 is caption-only) and dub-1.wav made by the real fitter
// from tone bursts. Needs ffmpeg on PATH.   node scripts/make-offline-fixture.mjs
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "testdata/offline-fixture";
mkdirSync(OUT, { recursive: true });
const b = await build({ stdin: { contents: `export * from "./app/dub"; export * from "./app/pipeline";`, resolveDir: ".", loader: "ts" }, bundle: true, format: "esm", write: false, platform: "neutral" });
const app = await import("data:text/javascript;base64," + Buffer.from(b.outputFiles[0].contents).toString("base64"));

execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=5",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "15", "-movflags", "+faststart", `${OUT}/clip.mp4`]);

const W = (w, s, e) => ({ w, p: w, s, e });
const words = [W("i", 0.5, 0.7), W("brought", 0.7, 1.1), W("my", 1.1, 1.3), W("laptop", 1.3, 1.9), W("and", 2.3, 2.5), W("a", 2.5, 2.6), W("sandwich", 2.6, 3.4)];
const phrase = { words, start: 0.35, end: 3.65 };
const tokens = ["I", "bought", "my", "lapdog", "and", "a", "sandwich."];
const chunks = tokens.map((_, i) => ({ s0: i, s1: i + 1, w0: i, w1: i + 1 }));
const sr = 44100;
// Synthetic "TTS": a tone burst per word; the alignment gives its character times.
const ttsWords = [[0.05, 0.15], [0.2, 0.45], [0.5, 0.62], [0.68, 1.05], [1.3, 1.42], [1.47, 1.52], [1.57, 2.05]];
const text = tokens.join(" ");
const characters = [...text], starts = [], ends = [];
let ci = 0;
tokens.forEach((t, k) => {
  const [s, e] = ttsWords[k];
  for (let j = 0; j < t.length; j++, ci++) { starts[ci] = s + ((e - s) * j) / t.length; ends[ci] = s + ((e - s) * (j + 1)) / t.length; }
  if (ci < characters.length) { starts[ci] = e; ends[ci] = e; ci++; } // the space
});
const alignment = { characters, character_start_times_seconds: starts, character_end_times_seconds: ends };
const pcm = new Float32Array(Math.round(2.3 * sr));
ttsWords.forEach(([s, e], k) => {
  for (let i = Math.round(s * sr); i < Math.round(e * sr); i++) pcm[i] = 0.3 * Math.sin((2 * Math.PI * (300 + 60 * k) * i) / sr);
});
const fitted = app.fit({ words, tokens, chunks, alignment, start: phrase.start, playEnd: phrase.end, pcm, sampleRate: sr });
writeFileSync(`${OUT}/dub-1.wav`, Buffer.from(await app.wav(fitted.pcm, sr).arrayBuffer()));

const alibi1 = { swaps: [], marks: [1, 3], text: app.caption(tokens), tokens, chunks, cues: app.cuesFor(words, tokens, chunks, phrase) };
const tokens2 = ["I", "bought", "my", "lapdog", "and", "a", "sandbag"];
const alibi2 = { swaps: [], marks: [1, 3, 6], text: app.caption(tokens2), tokens: tokens2, chunks, cues: app.cuesFor(words, tokens2, chunks, phrase) };
const meta = {
  clip: "clip.mp4", cueFormat: "word-reveal", takeId: "synthetic1", start: phrase.start, end: phrase.end, duration: 5,
  words, original: app.caption(words.map((w) => w.p)), originalCues: app.originalCues(phrase),
  alibis: [alibi1, alibi2], dubs: { 0: "dub-1.wav" }, synthetic: true,
};
writeFileSync(`${OUT}/sample.json`, JSON.stringify(meta, null, 1));
console.log(`Synthetic fixture written to ${OUT}/ (dub ${(fitted.pcm.length / sr).toFixed(2)} s, ${fitted.segments.length} segments).`);
