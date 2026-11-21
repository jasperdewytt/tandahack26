import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { build } from "esbuild";

// Stage dub checks, all with stubs: no network, no paid calls. Run with node scripts/test-dub.mjs.
// If testdata/dub-response.json exists (the one saved paid response), it is fitted too.
const load = async (entry) => {
  const b = await build({ entryPoints: [entry], bundle: true, format: "esm", write: false, platform: "neutral" });
  return import("data:text/javascript;base64," + Buffer.from(b.outputFiles[0].contents).toString("base64"));
};
const app = await load("app/dub.ts");
const srv = await load("src/dub.ts");
const near = (a, b, eps = 1e-6) => assert(Math.abs(a - b) < eps, `${a} != ${b}`);

// ---------- alignment: punctuation and repeated words ----------
const align = (text, perChar = 0.05) => {
  const chars = [...text];
  return { characters: chars, character_start_times_seconds: chars.map((_, i) => i * perChar), character_end_times_seconds: chars.map((_, i) => (i + 1) * perChar) };
};
{
  const tokens = ["My", "dog,", "my", "DOG!", "it's"];
  const text = srv.dubText(tokens); // "My dog, my DOG! it's"
  const t = app.tokenTimes(tokens, align(text));
  near(t[0].s, 0); near(t[0].e, 0.1);
  near(t[1].s, 0.15); near(t[1].e, 0.3); // "dog" without the comma
  near(t[2].s, 0.4); // second "my", not the first
  near(t[3].s, 0.55); near(t[3].e, 0.7);
  near(t[4].s, 0.8); near(t[4].e, 1.0); // apostrophe ignored on both sides
  // Curly apostrophe in the alignment, straight in the token; a token TTS dropped gets interpolated.
  const t2 = app.tokenTimes(["it's", "zzz", "fine"], align("it’s fine"));
  near(t2[0].s, 0); near(t2[2].s, 0.25);
  assert(t2[1].s >= t2[0].e - 1e-9 && t2[1].e <= t2[2].s + 1e-9);
}

// ---------- plan: absolute anchors, pauses, clamping, merging, first closure ----------
const W = (w, s, e) => ({ w, p: w, s, e });
{
  const words = [W("i", 1.0, 1.1), W("brought", 1.1, 1.5), W("my", 1.5, 1.7), W("lunch", 1.7, 2.1), W("today", 2.6, 3.4)];
  const tokens = ["a", "bright", "pie", "lunch", "to", "pay"];
  const chunks = [{ s0: 0, s1: 2, w0: 0, w1: 2 }, { s0: 2, s1: 3, w0: 2, w1: 3 }, { s0: 3, s1: 4, w0: 3, w1: 4 }, { s0: 4, s1: 5, w0: 4, w1: 6 }];
  const times = tokens.map((_, i) => ({ s: i * 0.3, e: i * 0.3 + 0.25 }));
  const segs = app.planSegments({ words, tokens, chunks, times, start: 0.85, playEnd: 3.2 });
  // Words with no visible pause between them are stretched as one run (fewer cuts, less stutter).
  assert.equal(segs.length, 2);
  near(segs[0].dst0, 1.0); near(segs[0].dst1, 2.1); near(segs[0].src0, 0); near(segs[0].src1, 0.9 + 0.25 + 0.03);
  // The pause before "today" is its own anchor, clamped to the playable clip.
  near(segs[1].dst0, 2.6); near(segs[1].dst1, 3.2);
  assert(segs[1].src1 <= 1.5 + 0.25 + 0.03 + 1e-9);
  // A comma in the line and the final word each start a new segment, even with no gap in the lips.
  const w3 = [W("one", 0, 0.3), W("two", 0.3, 0.6), W("three", 0.6, 0.9), W("four", 0.9, 1.3)];
  const segs3 = app.planSegments({
    words: w3, tokens: ["won,", "too", "tree", "for"], chunks: [0, 1, 2, 3].map((i) => ({ s0: i, s1: i + 1, w0: i, w1: i + 1 })),
    times: [0, 0.4, 0.7, 1.0].map((s) => ({ s, e: s + 0.25 })), start: 0, playEnd: 2,
  });
  assert.deepEqual(segs3.map((x) => x.dst0), [0, 0.3, 0.9]);
  // Pieces never overlap and never start before their lip window.
  for (let i = 1; i < segs.length; i++) assert(segs[i].dst0 >= segs[i - 1].dst1 - 1e-9);
  // First visible lip closure: "today"(no) vs. a chunk where the 2nd spoken / 2nd written word close the lips.
  const w2 = [W("so", 0, 0.2), W("bring", 0.2, 0.5), W("it", 0.5, 0.7)];
  const plan = app.planSegments({
    words: w2, tokens: ["oh", "the", "pin", "it"], chunks: [{ s0: 0, s1: 3, w0: 0, w1: 4 }],
    times: [0, 0.1, 0.2, 0.5].map((s) => ({ s, e: s + 0.1 })), start: 0, playEnd: 1,
    closedSaid: [false, true, false], closedWrote: [false, false, true, false],
  });
  near(plan[1].dst0, 0.2); near(plan[1].src0, 0.2); // "pin" starts exactly when "bring" closes the lips
}

// ---------- stretch keeps pitch; render places by absolute offsets ----------
{
  const sr = 44100;
  const tone = (sec, hz) => Float32Array.from({ length: Math.round(sec * sr) }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / sr));
  const crossings = (x) => { let n = 0; for (let i = 1; i < x.length; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) n++; return n; };
  for (const ratio of [0.6, 1.5]) {
    const x = tone(0.5, 220);
    const y = app.stretch(x, Math.round(x.length * ratio), sr);
    assert.equal(y.length, Math.round(x.length * ratio));
    const hz = crossings(y) / 2 / (y.length / sr);
    assert(Math.abs(hz - 220) < 12, `pitch moved to ${hz} Hz at ratio ${ratio}`);
  }
  const pcm = tone(2, 220);
  const segs = [{ src0: 0, src1: 0.5, dst0: 1.2, dst1: 1.8 }, { src0: 0.6, src1: 1.2, dst0: 3.0, dst1: 3.3 }];
  const out = app.render(pcm, sr, segs, 1.0, 3.25);
  assert.equal(out.length, Math.round(2.25 * sr));
  const rms = (a, b) => { let s = 0; for (let i = Math.round(a * sr); i < Math.round(b * sr); i++) s += out[i] ** 2; return Math.sqrt(s / ((b - a) * sr)); };
  assert(rms(0, 0.19) === 0, "silence before the first anchor");
  assert(rms(0.25, 0.75) > 0.3, "first piece lands at +0.2 s");
  assert(rms(0.81, 1.99) === 0, "pause between pieces preserved");
  assert(rms(2.02, 2.24) > 0.2, "second piece lands at +2.0 s, clamped at the clip end");
  assert(Math.abs(out[Math.round(0.2 * sr)]) < 0.01, "fade-in starts inside the window");
}

// ---------- server: bounds, auth before anything, limits, cache, in-flight dedupe ----------
{
  assert.equal(srv.parseDub({ take: "a b", tokens: ["hi"] }), null);
  assert.equal(srv.parseDub({ take: "t1", tokens: [] }), null);
  assert.equal(srv.parseDub({ take: "t1", tokens: Array(41).fill("x") }), null);
  assert.equal(srv.parseDub({ take: "t1", tokens: ["!!"] }), null);
  assert.equal(srv.parseDub({ take: "t1", tokens: ["my", "dog"] }).text, "My dog");
  assert.equal(srv.brisbaneDay(Date.UTC(2026, 10, 20, 14, 30)), "2026-11-21"); // 00:30 Sat in Brisbane

  const mapStore = () => { const m = new Map(); return { get: async (k) => m.get(k), put: async (k, v) => void m.set(k, v) }; };
  let calls = 0;
  let release;
  let hold = true; // only the dedupe check keeps the first call waiting
  const synth = async () => {
    calls++;
    if (hold) await new Promise((r) => (release = r));
    return { ok: true, data: { audio_base64: "AAAA", alignment: align("Hi") } };
  };
  let now = Date.UTC(2026, 10, 21, 2, 0);
  const gate = new srv.DubGate(mapStore(), synth, "voice-xyz", () => now);
  const input = (n) => ({ take: "take1", tokens: ["line", String(n)], text: `Line ${n}` });
  // Two Hear it presses while the first call is still running: one paid call.
  const a = gate.dub(input("one")), b = gate.dub(input("one"));
  while (!release) await new Promise((r) => setTimeout(r, 1));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  hold = false;
  assert.equal(calls, 1); assert.equal(ra.status, 200); assert.equal(rb.body.key, ra.body.key);
  assert(!JSON.stringify(ra.body).includes("voice-xyz"), "voice id never leaves the server");
  // Replay is a cache hit: zero cost, and not counted against the limits.
  for (let i = 0; i < 10; i++) assert.equal((await gate.dub(input("one"))).body.cached, true);
  assert.equal(calls, 1);
  // 5 per minute.
  const fresh = (n) => gate.dub(input(n));
  for (let i = 2; i <= 5; i++) assert.equal((await fresh(i)).status, 200);
  const over = await gate.dub(input(6));
  assert.equal(over.status, 429); assert.equal(over.body.error, "minute_limit"); assert.equal(calls, 5);
  // 20 per Brisbane day, across minutes; a new Brisbane day resets.
  let n = 100;
  for (let m = 1; calls < 20; m++) { now += 61_000; for (let i = 0; i < 5 && calls < 20; i++) assert.equal((await fresh(n++)).status, 200); }
  now += 61_000;
  const day = await gate.dub(input(n++));
  assert.equal(day.status, 429); assert.equal(day.body.error, "day_limit"); assert.equal(calls, 20);
  now = Date.UTC(2026, 10, 21, 14, 1); // 00:01 Sunday in Brisbane
  assert.equal((await fresh(n++)).status, 200);
  // A different take with the same words is a different cache entry.
  assert.notEqual(await srv.cacheKey(input("one"), "v"), await srv.cacheKey({ ...input("one"), take: "take2" }, "v"));

  // Route: unauthorised, unconfigured, oversized and malformed requests never reach the gate.
  let touched = 0;
  const g = () => { touched++; return { dub: async () => ({ status: 200, body: {} }), usage: async () => ({}) }; };
  const env = { ELEVENLABS_API_KEY: "k", ELEVENLABS_VOICE_ID: "v" };
  const req = (body, extra = {}) => new Request("https://x/api/dub", { method: "POST", body, headers: { "content-type": "application/json", "content-length": String(body.length), ...extra } });
  const ok = JSON.stringify({ take: "t1", tokens: ["hi", "there"] });
  assert.equal((await srv.dubRoute(req(ok), env, false, g)).status, 403);
  assert.equal((await srv.dubRoute(new Request("https://x/api/dub"), env, false, g)).status, 403);
  assert.equal((await srv.dubRoute(req(ok), {}, true, g)).status, 503);
  assert.equal((await srv.dubRoute(req("x".repeat(5000)), env, true, g)).status, 413);
  assert.equal((await srv.dubRoute(req("{nope"), env, true, g)).status, 400);
  assert.equal((await srv.dubRoute(req(JSON.stringify({ take: "t1", tokens: ["x".repeat(10)].concat(Array(40).fill("y")) })), env, true, g)).status, 400);
  assert.equal(touched, 0);
  assert.equal((await srv.dubRoute(req(ok), env, true, g)).status, 200);
  assert.equal(touched, 1);
}

// ---------- presenter controller: stale responses, dedupe, replay, older samples ----------
{
  const sent = [], notes = [];
  let requests = 0, resolve;
  const ctl = new app.DubController(
    async (t) => { requests++; await new Promise((r) => (resolve = r)); return { key: t.key, pcm: new Float32Array(4), sampleRate: 44100 }; },
    (m) => sent.push(m), (s) => notes.push(s),
  );
  const A = { key: "take1|alibi A", reveal: 1, take: "take1", tokens: ["a"] };
  // Hold (or a new take / reveal) while synthesis is running: the late response never plays.
  const p1 = ctl.hear(A);
  ctl.cancel();
  resolve();
  assert.equal(await p1, false);
  assert.deepEqual(sent.map((m) => m.t), ["dub-stop"]);
  // ...but it was cached, so the next Hear it costs nothing.
  assert.equal(await ctl.hear({ ...A, reveal: 2 }), true);
  assert.equal(requests, 1);
  assert.equal(sent.at(-1).t, "dub"); assert.equal(sent.at(-1).reveal, 2); assert.equal(sent.at(-1).key, A.key);
  // Two presses while a new request runs share it.
  const B = { key: "take1|alibi B", reveal: 3, take: "take1", tokens: ["b"] };
  const q1 = ctl.hear(B), q2 = ctl.hear(B);
  await new Promise((r) => setTimeout(r, 1));
  resolve();
  assert.deepEqual(await Promise.all([q1, q2]), [false, true]); // only the latest press plays
  assert.equal(requests, 2);
  assert.equal(sent.filter((m) => m.t === "dub").length, 2);
  // Older caption-only samples have no tokens: no request, silent reveal unaffected.
  assert.equal(await ctl.hear({ key: "old|x", reveal: 4, take: "old", tokens: null }), false);
  assert.equal(requests, 2);
  // Errors stay in the presenter's status line.
  const err = new app.DubController(async () => { throw new Error("limit reached"); }, (m) => sent.push(m), (s) => notes.push(s));
  assert.equal(await err.hear({ key: "k", reveal: 5, take: "t", tokens: ["x"] }), false);
  assert.match(notes.at(-1), /limit reached.*silent reveal still works/);
}

// ---------- the one saved paid response, if present ----------
if (existsSync("testdata/dub-response.json")) {
  const saved = JSON.parse(readFileSync("testdata/dub-response.json", "utf8"));
  const t = app.tokenTimes(saved.tokens, saved.response.alignment);
  assert.equal(t.length, saved.tokens.length);
  for (let i = 1; i < t.length; i++) assert(t[i].s >= t[i - 1].s, "token times run forward");
  assert(t.every((x) => x.e > x.s));
  console.log("Saved paid response maps:", saved.tokens.map((w, i) => `${w}@${t[i].s.toFixed(2)}-${t[i].e.toFixed(2)}`).join(" "));
}
console.log("Dub checks passed.");
