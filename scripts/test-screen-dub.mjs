import assert from "node:assert/strict";
import { build } from "esbuild";

// Projector dub playback (ScreenDub) on a simulated clock: a fake AudioContext and a fake video
// whose time we advance by hand. Every frame is ticked twice, as requestAnimationFrame and
// timeupdate both do in the browser. Run with node scripts/test-screen-dub.mjs.
const b = await build({ entryPoints: ["app/dub.ts"], bundle: true, format: "esm", write: false, platform: "neutral" });
const { ScreenDub } = await import("data:text/javascript;base64," + Buffer.from(b.outputFiles[0].contents).toString("base64"));

const LATENCY = 0.03;
const near = (a, b, eps, what) => assert(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);

function rig({ start = 1.0, seconds = 3.0 } = {}) {
  let ms = 0;
  const log = [];
  const ctx = {
    state: "running", sampleRate: 44100, outputLatency: LATENCY, baseLatency: 0.01, destination: {},
    get currentTime() { return ms / 1000; },
    resume: async () => {}, onstatechange: null,
    createBuffer: (_c, len, sr) => ({ duration: len / sr, copyToChannel() {} }),
    createBufferSource() {
      const node = {
        buffer: null, onended: null, connect() {},
        start: (_w, off = 0) => log.push({ ev: "start", node, off, t: video.currentTime }),
        stop: () => log.push({ ev: "stop", node, t: video.currentTime }),
      };
      return node;
    },
  };
  const video = { currentTime: start, paused: false, seeking: false };
  const states = [];
  const captions = [];
  const d = new ScreenDub(() => ctx, () => ms);
  d.onState = (s) => states.push(s);
  d.onCaptions = (show) => captions.push(show);
  d.enable();
  log.length = 0; // the silent unlock buffer
  const pcm = new Float32Array(Math.round(seconds * 44100));
  d.queue({ t: "dub", key: "k", reveal: 7, pcm, sampleRate: 44100 }, 7);
  // `media` is where the picture really is; video.currentTime is what the page can read.
  let media = start;
  /**
   * One display frame: the clock moves `dt` ms and the picture with it unless `frozen`
   * (a real stall). `stale` repeats the previous currentTime reading for this frame while the
   * picture keeps moving, as coarse browser timestamps do.
   */
  const frame = (dt = 16, { frozen = false, stale = false, dup = true } = {}) => {
    ms += dt;
    if (video.currentTime !== media && Math.abs(video.currentTime - media) > 0.5) media = video.currentTime; // a seek
    if (!frozen && !video.paused && !video.seeking) media += dt / 1000;
    if (!stale) video.currentTime = media;
    d.tick(video);
    if (dup) d.tick(video); // timeupdate in the same frame sees the same currentTime
  };
  const run = (n, opts) => { for (let i = 0; i < n; i++) frame(16, opts); };
  const starts = () => log.filter((e) => e.ev === "start");
  const stops = () => log.filter((e) => e.ev === "stop");
  return { d, video, log, states, captions, frame, run, starts, stops, start, seconds };
}

// 1. Healthy playback: duplicate callbacks, plus coarse currentTime that sometimes repeats
//    for a frame, never interrupt the audio. One source plays the whole pass, once.
{
  const r = rig();
  r.d.boundary(r.video, r.start);
  assert.equal(r.captions.at(-1), false, "captions hidden for the dub");
  r.frame(16, { frozen: true }); // seek just landed: picture not moving yet, nothing plays
  assert.equal(r.starts().length, 0);
  for (let i = 0; i < 200 && r.states.at(-1) !== "done"; i++) r.frame(16, { stale: i % 4 === 3 });
  assert.equal(r.starts().length, 1, "one source for the whole pass");
  near(r.starts()[0].off, r.starts()[0].t - r.start + LATENCY, 1e-9, "starts at the picture's position");
  assert.equal(r.stops().length, 1, "stopped only at the end");
  assert.equal(r.states.filter((s) => s === "done").length, 1);
  assert.equal(r.captions.at(-1), true, "captions restored");
  // Later loops never replay it.
  r.d.boundary(r.video, r.start);
  r.run(50);
  assert.equal(r.starts().length, 1, "plays once per requested reveal");
}

// 2. Sustained stall (video not advancing, not paused): silence after STALL_MS, then resync.
{
  const r = rig();
  r.d.boundary(r.video, r.start);
  r.run(30);
  assert.equal(r.starts().length, 1);
  r.run(5, { frozen: true }); // 80 ms: still within tolerance
  assert.equal(r.stops().length, 0, "short hiccup does not interrupt");
  r.run(10, { frozen: true }); // 240 ms total: frozen
  assert.equal(r.stops().length, 1, "sustained stall silences the audio");
  r.run(3);
  assert.equal(r.starts().length, 2, "resumes when the picture moves");
  const s = r.starts()[1];
  near(s.off, s.t - r.start + LATENCY, 1e-9, "resyncs to the picture after the stall");
}

// 3. Pause, then play.
{
  const r = rig();
  r.d.boundary(r.video, r.start);
  r.run(20);
  r.video.paused = true;
  r.frame();
  assert.equal(r.stops().length, 1, "pause stops at once");
  r.run(10);
  assert.equal(r.starts().length, 1, "nothing while paused");
  r.video.paused = false;
  r.run(2);
  assert.equal(r.starts().length, 2);
  const s = r.starts()[1];
  near(s.off, s.t - r.start + LATENCY, 1e-9, "resumes in sync after pause");
}

// 4. Seek within the pass: silent while seeking, then restarts at the new position.
{
  const r = rig();
  r.d.boundary(r.video, r.start);
  r.run(20);
  r.video.seeking = true;
  r.frame();
  assert.equal(r.stops().length, 1, "seeking stops the audio");
  r.video.currentTime = r.start + 1.5;
  r.frame(); // seek in progress
  r.video.seeking = false;
  r.run(2);
  assert.equal(r.starts().length, 2);
  const s = r.starts()[1];
  near(s.off, s.t - r.start + LATENCY, 1e-9, "restarts at the seek target");
  assert(s.off > 1.5);
}

// 5. Loop wrap while playing ends the pass; captions come back; no second play.
{
  const r = rig({ seconds: 5 });
  r.d.boundary(r.video, r.start);
  r.run(40);
  r.video.currentTime = r.start; // the loop player wraps and calls onLoop in the same step

  r.d.boundary(r.video, r.start);
  assert.equal(r.states.at(-1), "done");
  assert.equal(r.captions.at(-1), true);
  r.run(100);
  assert.equal(r.starts().length, 1, "plays once per requested reveal");
}

// 6. Stop restores captions immediately; a dub for an older reveal is ignored.
{
  const r = rig();
  r.d.boundary(r.video, r.start);
  r.run(20);
  r.d.stop();
  assert.equal(r.captions.at(-1), true);
  assert.equal(r.states.at(-1), "stopped");
  r.d.queue({ t: "dub", key: "old", reveal: 6, pcm: new Float32Array(10), sampleRate: 44100 }, 7);
  r.d.boundary(r.video, r.start);
  r.run(20);
  assert.equal(r.starts().length, 1, "stale reveal never plays");
}
console.log("Projector dub checks passed.");
