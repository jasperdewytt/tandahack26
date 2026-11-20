import { openCamera, Recorder, type Take } from "./capture";
import { LoopPlayer } from "./player";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const app = $("app");
const setView = (v: string) => (app.dataset.view = v);
const status = (t: string) => ($("status").textContent = t);

const RECORD_SECONDS = 10;

// ---------- intro ----------

const consent = $<HTMLInputElement>("consent");
consent.addEventListener("change", () => ($<HTMLButtonElement>("start").disabled = !consent.checked));

$("start").addEventListener("click", () => record());
$("retake").addEventListener("click", () => setView("intro"));
$("again").addEventListener("click", () => {
  player.stop();
  setView("intro");
});
$<HTMLInputElement>("file").addEventListener("change", (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) process({ video: f, audio: null });
});

// ---------- recording ----------

let recorder: Recorder | null = null;

async function record() {
  let stream: MediaStream;
  try {
    stream = await openCamera();
  } catch (e) {
    fail("Camera blocked", "Allow camera and microphone access for this site, then try again. Or upload a short video instead.");
    return;
  }
  const live = $<HTMLVideoElement>("live");
  live.srcObject = stream;
  live.play().catch(() => {});
  setView("record");

  recorder = new Recorder(stream);
  recorder.start();
  const t0 = performance.now();
  const bar = $("rec-bar");
  const count = $("rec-count");
  const tick = () => {
    if (!recorder) return;
    const s = (performance.now() - t0) / 1000;
    bar.style.width = `${Math.min(100, (s / RECORD_SECONDS) * 100)}%`;
    count.textContent = String(Math.max(0, Math.ceil(RECORD_SECONDS - s)));
    if (s >= RECORD_SECONDS) stopRecording();
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function stopRecording() {
  const r = recorder;
  recorder = null;
  if (!r) return;
  const take = await r.stop();
  $<HTMLVideoElement>("live").srcObject = null;
  process(take);
}
$("stop").addEventListener("click", stopRecording);

// ---------- processing ----------

const player = new LoopPlayer($<HTMLVideoElement>("player"));

async function process(take: Take) {
  setView("work");
  const preview = $<HTMLVideoElement>("preview");
  preview.src = URL.createObjectURL(take.video);
  preview.muted = true;
  preview.play().catch(() => {});
  status(take.audio ? "Listening back…" : "Your phone saved one file, so the whole clip is uploaded for transcription.");

  // Milestone 1: loop the whole clip muted.
  setView("reveal");
  await player.load(take.video, 0, Infinity);
  $("caption").textContent = "";
}

function fail(title: string, msg: string) {
  $("fail-title").textContent = title;
  $("fail-msg").textContent = msg;
  setView("fail");
}
