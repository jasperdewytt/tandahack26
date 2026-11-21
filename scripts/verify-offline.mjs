// Offline fallback check: the presenter and projector tabs, run against the offline server in a
// headless Chrome that cannot resolve any host except localhost (so no external network).
// Verifies: original reveal, alibi reveal, the saved dub playing from cache on the projector,
// captions hidden then restored, and a caption-only alibi still revealing silently.
//   node scripts/verify-offline.mjs                       # public/sample (the approved sample)
//   node scripts/verify-offline.mjs testdata/offline-fixture   # synthetic fixture
// Needs Chrome or Edge (set CHROME=path to override).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import qrcode from "qrcode-generator";

const sampleDir = resolve(process.argv[2] ?? "public/sample");
assert(existsSync(join(sampleDir, "sample.json")), `no sample.json in ${sampleDir}`);
const meta = JSON.parse(readFileSync(join(sampleDir, "sample.json"), "utf8"));
for (const f of [meta.clip, ...Object.values(meta.dubs ?? {})]) assert(existsSync(join(sampleDir, f)), `manifest file missing: ${f}`);
const dubbed = Object.keys(meta.dubs ?? {}).map(Number);
const chrome = process.env.CHROME ?? ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome"].find(existsSync);
assert(chrome, "Chrome/Edge not found; set CHROME");
const PORT = 8091, DEVTOOLS = 9341;
const ORIGIN = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ["scripts/offline.mjs"], {
  env: { ...process.env, PORT: String(PORT), SAMPLE_DIR: sampleDir === resolve("public/sample") ? "" : sampleDir }, stdio: "ignore",
});
const profile = mkdtempSync(join(tmpdir(), "lip-offline-"));
const browser = spawn(chrome, [
  "--headless=new", `--remote-debugging-port=${DEVTOOLS}`, `--user-data-dir=${profile}`, "--no-first-run",
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost", // external network disabled
  "about:blank",
], { stdio: "ignore" });
const cleanup = () => { browser.kill(); server.kill(); setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500); };

let ws, id = 0;
const pending = new Map(), listeners = [];
const cdp = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const n = ++id;
  pending.set(n, { res, rej });
  ws.send(JSON.stringify({ id: n, method, params, sessionId }));
});
try {
  let version;
  for (let i = 0; i < 50 && !version; i++) {
    version = await fetch(`http://127.0.0.1:${DEVTOOLS}/json/version`).then((r) => r.json()).catch(() => null);
    if (!version) await sleep(200);
  }
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    } else listeners.forEach((l) => l(m));
  });
  const requests = [];
  listeners.push((m) => { if (m.method === "Network.requestWillBeSent") requests.push(m.params.request.url); });

  async function open(path, script = "") {
    const { targetId } = await cdp("Target.createTarget", { url: "about:blank", newWindow: true }); // own window each, like two displays
    const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
    await cdp("Network.enable", {}, sessionId);
    await cdp("Page.enable", {}, sessionId);
    if (script) await cdp("Page.addScriptToEvaluateOnNewDocument", { source: script }, sessionId);
    await cdp("Page.navigate", { url: ORIGIN + path }, sessionId);
    const ev = async (expr) => {
      const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const click = async (x, y) => {
      for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, sessionId);
    };
    const reload = () => cdp("Page.reload", {}, sessionId);
    return { ev, click, reload };
  }
  const waitFor = async (fn, what, ms = 15000, show) => {
    const t0 = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}${show ? ` (saw: ${JSON.stringify(await show())})` : ""}`);
      await sleep(100);
    }
  };

  // Projector: record every audio source the page starts, and caption visibility at that moment.
  const screen = await open("/screen", `
    window.__audio = [];
    addEventListener("DOMContentLoaded", () => {
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (w, off) {
        const cap = document.getElementById("screen-caption");
        window.__audio.push({ dur: this.buffer.duration, off: off || 0, captionHidden: cap.hidden });
        return start.apply(this, arguments);
      };
    });`);
  await waitFor(() => screen.ev(`document.getElementById("app")?.dataset.view === "hold"`), "projector hold screen");
  await screen.click(200, 200); // the one setup gesture: unlocks sound
  await waitFor(() => screen.ev(`document.getElementById("sound-hint").hidden`), "projector sound on");

  const stage = await open("/stage?k=local&sample");
  const results = [];
  const ok = (what) => { results.push(what); console.log(`  ok  ${what}`); };
  await waitFor(() => stage.ev(`document.getElementById("app").dataset.view === "reveal" && !document.getElementById("presenter").hidden`), "presenter loaded the sample");
  ok("presenter loaded the offline sample");
  ok(`external network disabled: ${await stage.ev(`fetch("https://example.com/").then(() => "reachable", () => "blocked")`)}`);
  assert.equal(await stage.ev(`fetch("https://example.com/").then(() => "reachable", () => "blocked")`), "blocked");

  const screenText = () => screen.ev(`document.getElementById("app").dataset.view + "|" + document.getElementById("screen-caption").textContent`);
  const originalWords = new Set(meta.original.toLowerCase().replace(/[^a-z' ]/g, "").split(" "));
  await stage.ev(`document.getElementById("p-send").click()`);
  await waitFor(async () => {
    const [view, cap] = (await screenText()).split("|");
    return view === "project" && cap && cap.toLowerCase().replace(/[^a-z' ]/g, "").split(" ").every((w) => originalWords.has(w));
  }, "original caption on the projector", 15000, screenText);
  ok("original reveal: projector shows the clip with the original caption");

  for (const [n, a] of meta.alibis.entries()) {
    const words = new Set(a.text.toLowerCase().replace(/[^a-z' ]/g, "").split(" "));
    await stage.ev(`document.querySelectorAll("#toggle button")[${n + 1}].click(); document.getElementById("p-reveal").click()`);
    await waitFor(async () => {
      const cap = (await screenText()).split("|")[1];
      return cap && cap.toLowerCase().replace(/[^a-z' ]/g, "").split(" ").every((w) => words.has(w));
    }, `alibi ${n + 1} caption on the projector`, 15000, screenText);
    ok(`alibi ${n + 1} reveal: projector caption follows "${a.text}"`);
    // Browse a different alibi privately: Hear it must still dub the one on screen.
    await stage.ev(`document.querySelectorAll("#toggle button")[0].click()`);
    const before = (await screen.ev(`window.__audio.length`));
    await stage.ev(`document.getElementById("p-hear").click()`);
    if (dubbed.includes(n)) {
      const wav = readFileSync(join(sampleDir, meta.dubs[n]));
      const expected = wav.readUInt32LE(40) / 2 / wav.readUInt32LE(24);
      const s = await waitFor(() => screen.ev(`window.__audio.length > ${before} && window.__audio[${before}]`), "the saved dub to play", 20000);
      assert(Math.abs(s.dur - expected) < 0.01, `played ${s.dur}s, expected ${expected}s`);
      assert(s.captionHidden, "captions hidden while the dub plays");
      ok(`saved dub ${meta.dubs[n]} played on the projector from cache (${s.dur.toFixed(2)} s, captions hidden)`);
      await waitFor(() => stage.ev(`/finished/.test(document.getElementById("p-dub").textContent)`), "dub to finish", 20000);
      assert.equal(await screen.ev(`document.getElementById("screen-caption").hidden`), false);
      ok("dub finished once; projector back to the captioned loop");
    } else {
      await sleep(400);
      const note = await stage.ev(`document.getElementById("p-dub").textContent`);
      assert(/silent reveal still works|older sample/i.test(note) || /failed/i.test(note), note);
      assert.equal(await screen.ev(`window.__audio.length`), before, "no audio for an undubbed alibi");
      ok(`alibi ${n + 1} has no saved dub: presenter told privately ("${note.slice(0, 60)}…"), projector stays silent`);
    }
  }

  // The talk: title -> clip -> alibi -> dub -> final slide, then rehearsal back to the clip.
  const view = () => screen.ev(`document.getElementById("app").dataset.view`);
  const dubN = dubbed[0];
  const audioPlays = async (what) => {
    const before = await screen.ev(`window.__audio.length`);
    await stage.ev(`document.getElementById("p-hear").click()`);
    await waitFor(() => screen.ev(`window.__audio.length > ${before}`), what, 20000);
  };
  const revealAlibi = async (n) => {
    const words = new Set(meta.alibis[n].text.toLowerCase().replace(/[^a-z' ]/g, "").split(" "));
    await stage.ev(`document.querySelectorAll("#toggle button")[${n + 1}].click(); document.getElementById("p-reveal").click()`);
    await waitFor(async () => {
      const [v, cap] = (await screenText()).split("|");
      return v === "project" && cap && cap.toLowerCase().replace(/[^a-z' ]/g, "").split(" ").every((w) => words.has(w));
    }, `alibi ${n + 1} caption`, 15000, screenText);
  };
  await stage.ev(`document.getElementById("p-title").click()`);
  await waitFor(async () => (await view()) === "title", "title slide", 5000, view);
  assert.equal(await screen.ev(`document.querySelector(".title-slide").innerText.split(/[\\n ]+/).join(" ").trim()`), "Mouth Alibi your mouth has an alibi.");
  ok("title slide on the projector");
  await stage.ev(`document.getElementById("p-send").click()`);
  await waitFor(async () => (await view()) === "project", "clip after the title", 15000, view);
  ok("title -> prepared clip with the original caption");
  if (dubbed.length) {
    await revealAlibi(dubN);
    await audioPlays("dub before the final slide");
    ok(`alibi ${dubN + 1} revealed over the same footage; saved dub playing`);
    await stage.ev(`document.getElementById("p-final").click()`);
    await waitFor(async () => (await view()) === "final", "final slide", 5000, view);
    await waitFor(() => stage.ev(`/stopped/i.test(document.getElementById("p-dub").textContent)`), "dub stopped by the slide", 5000,
      () => stage.ev(`document.getElementById("p-dub").textContent`));
    ok("final slide stops the playing dub");
  } else {
    await stage.ev(`document.getElementById("p-final").click()`);
    await waitFor(async () => (await view()) === "final", "final slide", 5000, view);
  }
  const crowdHost = "mouth-alibi.lip-service.workers.dev"; // localhost rehearsal -> hosted crowd URL from <meta name="crowd-url">
  assert.equal(await screen.ev(`document.querySelector(".final-slide .qr-url").textContent`), crowdHost);
  const want = qrcode(0, "M");
  want.addData(`https://${crowdHost}/`);
  want.make();
  const modules = want.createSvgTag({ cellSize: 8, margin: 0, scalable: true }).match(/ d="([^"]+)"/)[1];
  assert.equal(await screen.ev(`document.querySelector(".final-slide .qr svg path").getAttribute("d")`), modules, "QR encodes the crowd URL");
  assert(!(await screen.ev(`/[?&]k=/.test(document.documentElement.outerHTML)`)), "no presenter key on the projector");
  ok(`final slide: QR and URL point at ${crowdHost}, no presenter key on the projector`);
  await sleep(1500);
  assert.equal(await view(), "final", "final slide stays put");
  await screen.reload();
  await waitFor(async () => (await view()) === "final", "final slide after a projector refresh", 10000, view);
  ok("projector refresh recovers the final slide");
  await screen.click(200, 200); // sound again after the refresh
  await waitFor(() => screen.ev(`document.getElementById("sound-hint").hidden`), "projector sound on after refresh");
  await stage.ev(`document.getElementById("p-send").click()`);
  await waitFor(async () => (await view()) === "project", "back to the clip", 15000, view);
  ok("final slide -> back to the prepared clip without reloading the sample");
  if (dubbed.length) {
    await revealAlibi(dubN);
    await audioPlays("saved dub after returning to the clip");
    ok("saved dub still plays from cache after the slides");
    await screen.reload();
    await waitFor(async () => {
      const cap = (await screenText()).split("|");
      return cap[0] === "project" && cap[1] && meta.alibis[dubN].text.toLowerCase().includes(cap[1].toLowerCase().replace(/[^a-z' ]/g, "").split(" ")[0]);
    }, "alibi clip after a projector refresh", 15000, screenText);
    ok("projector refresh recovers the alibi clip");
  }

  const external = requests.filter((u) => !u.startsWith(ORIGIN) && !u.startsWith("data:") && !u.startsWith("blob:") && u !== "about:blank");
  console.log(`  note  external requests attempted (all unresolvable): ${[...new Set(external.map((u) => new URL(u).host))].join(", ") || "none"}`);
  console.log(`Offline fallback verified (${results.length} checks) with ${sampleDir}${meta.synthetic ? " [SYNTHETIC FIXTURE]" : ""}.`);
} finally {
  cleanup();
}
