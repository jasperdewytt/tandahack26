import assert from "node:assert/strict";
import { build } from "esbuild";

// Run with node scripts/test-caption-timing.mjs.
const bundle = await build({ entryPoints: ["app/pipeline.ts"], bundle: true, format: "esm", write: false });
const { cuesFor, cueAt, originalCues } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].contents).toString("base64")
);
const word = (w, s, e) => ({ w, p: w, s, e });

// Measured fixture: the recognizer extended the last word beyond the end of the recording.
const tail = { words: [word("attitude", 3.2, 4.8)], start: 3.05, end: 4.224 };
const split = cuesFor(tail.words, ["at", "the", "zoo"], [{ s0: 0, s1: 1, w0: 0, w1: 3 }], tail);
assert(split.every(c => c.start < c.end && c.end <= tail.end));
assert.equal(cueAt(split, 4.2), "At the zoo");

// A one-syllable first word uses one quarter of a four-syllable source word.
const phrase = { words: [word("importantly", 1, 1.8), word("now", 2.4, 2.7)], start: 0.85, end: 2.8 };
const chunks = [{ s0: 0, s1: 2, w0: 0, w1: 3 }];
const cues = cuesFor(phrase.words, ["a", "wonderful", "day"], chunks, phrase, [4, 1], [1, 3, 1]);
assert.deepEqual(cues.map(c => c.start), [1, 1.2, 2.4]);
assert.equal(cueAt(cues, 2.2), "A wonderful");
assert.equal(cueAt(cues, 2.32), "A wonderful day");
const original = originalCues(phrase);
assert.deepEqual(original.map(c => c.start), [1, 2.4]);
assert.equal(cueAt(original, 2.32), "Importantly now");
assert.equal(cueAt(original, phrase.start), "");
console.log("Caption timing checks passed.");
