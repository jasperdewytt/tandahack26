import assert from "node:assert/strict";
import { build } from "esbuild";

// "Save as sample" and "Save dub" produce self-consistent downloads: every WAV that sample.json
// lists is one of the exported files, for the right alibi. Run with node scripts/test-sample-export.mjs.
const b = await build({ entryPoints: ["app/sample.ts"], bundle: true, format: "esm", write: false, platform: "neutral" });
const { sampleExport } = await import("data:text/javascript;base64," + Buffer.from(b.outputFiles[0].contents).toString("base64"));

const alibi = (text) => ({ swaps: [], marks: [], text, tokens: text.split(" "), chunks: [], cues: [] });
const take = (n) => ({
  takeId: "take42", duration: 4.2, clip: new Blob(["video"], { type: "video/webm;codecs=vp9" }),
  phrase: { words: [{ w: "hi", p: "Hi", s: 0.1, e: 0.4 }], start: 0, end: 0.6 },
  original: "Hi", originalCues: [], alibis: Array.from({ length: n }, (_, i) => alibi(`line ${i + 1}`)),
});
// A distinct fitted dub per alibi: its first sample encodes which alibi it belongs to.
const fitted = (i) => {
  const pcm = new Float32Array(441 * (i + 2));
  pcm[0] = (i + 1) / 10;
  return { key: `k${i}`, pcm, sampleRate: 44100 };
};
/** What the offline loader does with the downloads: resolve each manifest WAV to an exported file. */
async function resolve(files) {
  const byName = new Map(files.map((f) => [f.name, f.blob]));
  const meta = JSON.parse(await byName.get("sample.json").text());
  assert(byName.has(meta.clip), "clip resolves");
  const out = {};
  for (const [i, name] of Object.entries(meta.dubs)) {
    assert(byName.has(name), `${name} is in the export`);
    assert(meta.alibis[Number(i)], `alibi ${i} exists`);
    const buf = new DataView(await byName.get(name).arrayBuffer());
    out[i] = { samples: buf.getUint32(40, true) / 2, first: buf.getInt16(44, true) / 0x7fff };
  }
  return { meta, out };
}

// Three alibis, only the middle one has a cached dub.
{
  const res = take(3);
  const cache = new Map([[1, fitted(1)]]);
  const plain = sampleExport(res, (i) => cache.get(i), false);
  assert.deepEqual(plain.files.map((f) => f.name), ["clip.webm", "sample.json"]);
  assert.deepEqual(plain.meta.dubs, {}, "Save as sample lists no WAVs it didn't export");
  assert.deepEqual((await resolve(plain.files)).out, {});

  const dubbed = sampleExport(res, (i) => cache.get(i), true);
  assert.deepEqual(dubbed.files.map((f) => f.name), ["clip.webm", "sample.json", "dub-2.wav"]);
  const { meta, out } = await resolve(dubbed.files);
  assert.deepEqual(meta.dubs, { 1: "dub-2.wav" });
  assert.equal(out[1].samples, fitted(1).pcm.length);
  assert(Math.abs(out[1].first - 0.2) < 1e-3, "dub-2.wav holds alibi 2's audio");
  assert.equal(meta.takeId, "take42");
  assert.equal(meta.alibis[1].tokens.join(" "), "line 2");
}

// Two of three cached (first and last): each WAV maps to its own alibi.
{
  const res = take(3);
  const cache = new Map([[0, fitted(0)], [2, fitted(2)]]);
  const { files } = sampleExport(res, (i) => cache.get(i), true);
  const { meta, out } = await resolve(files);
  assert.deepEqual(meta.dubs, { 0: "dub-1.wav", 2: "dub-3.wav" });
  assert(Math.abs(out[0].first - 0.1) < 1e-3 && Math.abs(out[2].first - 0.3) < 1e-3);
  assert.equal(out[2].samples, fitted(2).pcm.length);
}

// Nothing cached: Save dub degrades to the plain sample.
{
  const { files, meta } = sampleExport(take(2), () => undefined, true);
  assert.deepEqual(files.map((f) => f.name), ["clip.webm", "sample.json"]);
  assert.deepEqual(meta.dubs, {});
}

// MP4 clips keep their extension and the manifest points at it.
{
  const res = { ...take(1), clip: new Blob(["v"], { type: "video/mp4" }) };
  const { files, meta } = sampleExport(res, () => undefined, false);
  assert.equal(files[0].name, "clip.mp4");
  assert.equal(meta.clip, "clip.mp4");
}
console.log("Sample export checks passed.");
