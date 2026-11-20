import qrcode from "qrcode-generator";
import { openCamera, Recorder, type Take } from "./capture";
import { LoopPlayer } from "./player";
import { Lexicon } from "./lexicon";
import { Blocklist } from "./blocklist";
import type { Word, Phrase } from "./phrase";
import { rankPhrases, writeAlibis, caption, originalCues, cueAt, type Alibi, type Cue, type WriteLog } from "./pipeline";
import { channel, type StageMsg } from "./stage";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const app = $("app");
const setView = (v: string) => (app.dataset.view = v);
const status = (t: string) => ($("status").textContent = t);

const RECORD_SECONDS = 12;
const path = location.pathname.replace(/\/+$/, "") || "/";

// ---------- shared state ----------

interface Result {
  clip: Blob;
  phrase: Phrase;
  original: string;
  originalCues: Cue[];
  alibis: Alibi[];
}

let result: Result | null = null;
let lexP: Promise<Lexicon> | null = null;
let blockP: Promise<Blocklist> | null = null;
const loadData = () => {
  lexP ??= Lexicon.load();
  blockP ??= Blocklist.load();
  return Promise.all([lexP, blockP]);
};

const player = new LoopPlayer($<HTMLVideoElement>("player"));

// ---------- routing ----------

let presenter = false;
let send: ((m: StageMsg) => void) | null = null;

if (path === "/screen") initScreen();
else {
  loadData().catch(() => {});
  if (path === "/stage") {
    // /stage?k=…&sample puts the sample clip straight into the presenter flow.
    initPresenter().then(() => {
      if (new URLSearchParams(location.search).has("sample")) loadSample();
    });
  } else if (path === "/sample") loadSample();
  // The SPA fallback answers 200 with HTML for missing files, so check the type too.
  fetch("/sample/sample.json", { method: "HEAD" })
    .then((r) => {
      if (r.ok && (r.headers.get("content-type") ?? "").includes("json")) {
        $("sample-wrap").hidden = false;
        $("fail-sample").hidden = false;
      }
    })
    .catch(() => {});
}

// ---------- intro + recording ----------

const consent = $<HTMLInputElement>("consent");
consent.addEventListener("change", () => ($<HTMLButtonElement>("start").disabled = !consent.checked));
$("start").addEventListener("click", () => record());
$("retake").addEventListener("click", () => setView("intro"));
$("again").addEventListener("click", () => {
  player.stop();
  setView("intro");
});
document.querySelectorAll<HTMLInputElement>(".file-pick").forEach((el) =>
  el.addEventListener("change", () => {
    const f = el.files?.[0];
    el.value = "";
    if (f) process({ video: f, audio: null });
  }),
);

let recorder: Recorder | null = null;

async function record() {
  let stream: MediaStream;
  try {
    stream = await openCamera();
  } catch {
    fail("Camera blocked", "Allow camera and microphone access for this site, then try again. Or upload a short video instead.");
    return;
  }
  const live = $<HTMLVideoElement>("live");
  live.srcObject = stream;
  live.play().catch(() => {});
  setView("record");

  try {
    recorder = new Recorder(stream);
    recorder.start();
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    fail("Can't record here", "This browser can't record video. Upload a short video instead.");
    return;
  }
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

// ---------- pipeline: transcribe -> phrase -> candidates -> Sonnet -> validate ----------

class Retake extends Error {
  constructor(public title: string, msg: string) {
    super(msg);
  }
}

async function process(take: Take) {
  setView("work");
  const preview = $<HTMLVideoElement>("preview");
  if (preview.src) URL.revokeObjectURL(preview.src);
  preview.src = URL.createObjectURL(take.video);
  preview.muted = true;
  preview.play().catch(() => {});

  try {
    const upload = take.audio ?? take.video;
    status(take.audio ? "Listening back…" : "Your phone saved one file, so the whole clip is uploading for transcription…");
    const type = upload.type || "application/octet-stream";
    // One automatic retry: a transcription hiccup should never reach the person.
    const tr = await api("/api/transcribe", upload, type).catch(async () => {
      await new Promise((r) => setTimeout(r, 2000));
      return api("/api/transcribe", upload, type);
    });
    const words: Word[] = tr.words ?? [];
    if (words.length < 2) throw new Retake("We didn't catch that", "Speak up and answer in a full sentence, facing the camera.");

    status("Reading your lips…");
    const [lex, block] = await loadData();
    const ranked = rankPhrases(words, lex, block, tr.duration ?? Infinity);
    if (!ranked.length) throw new Retake("No alibi this time", "Your lips were too honest. Try a longer answer that names a few things.");

    const chosen = ranked[0];
    const post = (path: string, body: string) => api(path, body, "application/json");
    const log: WriteLog[] = [];
    // Optional nudge for what the alibi is about; ignored if it hits the blocklist.
    const rawTopic = $<HTMLInputElement>("topic").value.trim().slice(0, 60);
    const topic = rawTopic && !block.blocks(rawTopic) ? rawTopic : "";
    // Two writers at once: a quick low-effort pass so the reveal comes fast, and a slower
    // medium-effort pass whose (funnier) lines replace the quick ones when they arrive.
    let lastError: unknown = null;
    const settle = (p: Promise<Alibi[]>) => p.catch((e) => ((lastError = e), [] as Alibi[]));
    const fastP = settle(writeAlibis(chosen, lex, block, post, () => {}, [], topic, "low"));
    const bestP = settle(writeAlibis(chosen, lex, block, post, status, log, topic, "medium"));
    let bestDone = false;
    bestP.then(() => (bestDone = true));
    const first = await new Promise<Alibi[]>((resolve) => {
      let pending = 2;
      for (const p of [fastP, bestP]) p.then((a) => (a.length ? resolve(a) : --pending === 0 && resolve([])));
    });
    if (!first.length) {
      if (lastError instanceof ApiError) throw lastError;
      throw new Retake("No clean alibi", "We couldn't find a funny line that fits your lips. Try again with a different answer.");
    }

    const mine: Result = {
      clip: take.video,
      phrase: chosen.phrase,
      original: caption(chosen.phrase.words.map((w) => w.p)),
      originalCues: originalCues(chosen.phrase),
      alibis: first,
    };
    result = mine;
    const upgrading = !bestDone;
    $("upgrade-note").hidden = !upgrading;
    await reveal();
    if (upgrading) {
      bestP.then((better) => {
        console.log("alibi lines", JSON.stringify(log));
        if (result !== mine) return; // they've moved on to another recording
        if (!better.length) {
          $("upgrade-note").hidden = true;
          return;
        }
        mine.alibis = better;
        buildToggle();
        setCaption();
        if (presenter) updatePresenter();
        flashNote("Funnier alibis just arrived.");
      });
    }
  } catch (e) {
    if (e instanceof Retake) fail(e.title, e.message);
    else if (e instanceof ApiError) fail("Something went wrong", e.message);
    else fail("Something went wrong", "Check your connection and try again.");
    console.error(e);
  }
}

class ApiError extends Error {}

async function api(url: string, body: BodyInit, type: string): Promise<any> {
  let r: Response;
  try {
    r = await fetch(url, { method: "POST", headers: { "content-type": type }, body });
  } catch {
    throw new ApiError("No connection. Check your signal and try again.");
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(data.message ?? "The service didn't answer. Try again in a moment.");
  return data;
}

// ---------- reveal + caption toggle ----------

let selected = 0; // 0 = original, 1..n = alibis

async function reveal() {
  if (!result) return;
  const { clip, phrase } = result;
  selected = 0;
  buildToggle();
  setCaption();
  setView("reveal");
  $("presenter").hidden = !presenter;
  if (presenter) updatePresenter();
  await player.load(clip, phrase.start, phrase.end);
}

function captionFor(n: number): string {
  if (!result) return "";
  return n === 0 ? result.original : result.alibis[n - 1].text;
}

function cuesFor(n: number): Cue[] {
  if (!result) return [];
  return n === 0 ? result.originalCues : result.alibis[n - 1].cues;
}

// Subtitles follow the playhead: each one shows while the mouth makes those words.
player.onTime = (t) => {
  const el = $("caption");
  const text = cueAt(cuesFor(selected), t);
  if (el.textContent !== text) el.textContent = text;
};

/** Briefly replace the "writing" note with a message, then hide it. */
function flashNote(text: string) {
  const el = $("upgrade-note");
  el.lastChild!.textContent = text;
  el.classList.add("arrived");
  el.hidden = false;
  setTimeout(() => {
    el.hidden = true;
    el.classList.remove("arrived");
    el.lastChild!.textContent = "Writing funnier ones…";
  }, 4000);
}

function buildToggle() {
  const box = $("toggle");
  box.replaceChildren();
  if (!result) return;
  if (selected > result.alibis.length) selected = 0;
  const opts = [{ label: "What you said", text: result.original, marks: [] as number[] }].concat(
    result.alibis.map((a, n) => ({ label: `Alibi ${n + 1}`, text: a.text, marks: a.marks ?? [] })),
  );
  opts.forEach((o, n) => {
    const b = document.createElement("button");
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(n === selected));
    const label = document.createElement("b");
    label.textContent = o.label;
    b.append(label);
    // Underline the swapped words so the changes are easy to spot.
    const words = o.text.split(" ");
    words.forEach((w, i) => {
      if (i) b.append(" ");
      if (o.marks.includes(i)) {
        const m = document.createElement("mark");
        m.textContent = w;
        b.append(m);
      } else b.append(w);
    });
    b.addEventListener("click", () => {
      selected = n;
      box.querySelectorAll("button").forEach((x, k) => x.setAttribute("aria-checked", String(k === n)));
      setCaption();
      player.play(); // resumes if autoplay was blocked; never seeks
      if (presenter) updatePresenter();
    });
    box.append(b);
  });
}

function setCaption() {
  showCaption($("caption"), cueAt(cuesFor(selected), player.time));
}

/** Swap caption text immediately; the CSS animation is only a brief fade-in. */
function showCaption(el: HTMLElement, text: string) {
  el.textContent = text;
  el.classList.remove("swap");
  void el.offsetWidth; // restart the animation
  el.classList.add("swap");
}

function fail(title: string, msg: string) {
  $("fail-title").textContent = title;
  $("fail-msg").textContent = msg;
  setView("fail");
}

// ---------- presenter ----------

type ScreenState = "hold" | "original" | "alibi";
let screenState: ScreenState = "hold";

async function initPresenter() {
  const k = new URLSearchParams(location.search).get("k") ?? "";
  const ok = await fetch(`/api/stage?k=${encodeURIComponent(k)}`).then((r) => r.ok).catch(() => false);
  if (!ok) return; // plain crowd mode
  presenter = true;
  document.title = "Lip Service · presenter";
  send = channel((m) => {
    if (m.t === "hello") resendScreen();
  });
  send({ t: "hold" });

  $("p-send").addEventListener("click", () => {
    if (!result) return;
    screenState = "original";
    resendScreen();
    updatePresenter();
  });
  $("p-reveal").addEventListener("click", () => {
    if (!result || selected === 0) return;
    screenState = "alibi";
    send?.({ t: "caption", cues: cuesFor(selected) });
    updatePresenter();
  });
  $("p-back").addEventListener("click", () => {
    if (!result) return;
    screenState = "original";
    send?.({ t: "caption", cues: result.originalCues });
    updatePresenter();
  });
  $("p-hold").addEventListener("click", () => {
    screenState = "hold";
    send?.({ t: "hold" });
    updatePresenter();
  });
  $("p-save").addEventListener("click", saveSample);
}

function resendScreen() {
  if (!send) return;
  if (screenState === "hold" || !result) return send({ t: "hold" });
  const cues = screenState === "alibi" && selected > 0 ? cuesFor(selected) : result.originalCues;
  send({ t: "show", clip: result.clip, start: result.phrase.start, end: result.phrase.end, cues });
}

function updatePresenter() {
  const st = $("p-state");
  $<HTMLButtonElement>("p-reveal").disabled = screenState === "hold" || selected === 0;
  $<HTMLButtonElement>("p-back").disabled = screenState !== "alibi";
  $("p-send").textContent = screenState === "hold" ? "Show original on screen" : "Resend original to screen";
  const what =
    screenState === "hold" ? "Screen is holding." :
    screenState === "original" ? "Screen shows the original caption." :
    "Screen shows the alibi.";
  st.firstChild!.textContent = what + " ";
}

function saveSample() {
  if (!result) return;
  const ext = result.clip.type.includes("mp4") ? "mp4" : "webm";
  const meta = {
    clip: `clip.${ext}`,
    start: result.phrase.start,
    end: result.phrase.end,
    original: result.original,
    originalCues: result.originalCues,
    alibis: result.alibis,
  };
  download(result.clip, `clip.${ext}`);
  download(new Blob([JSON.stringify(meta, null, 2)], { type: "application/json" }), "sample.json");
}

function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- projector ----------

function initScreen() {
  document.title = "Lip Service · screen";
  setView("hold");
  const url = location.origin.replace(/^https?:\/\//, "");
  const qr = qrcode(0, "M");
  qr.addData(location.origin + "/");
  qr.make();
  $("qr").innerHTML = qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true });
  $("qr-url").textContent = url;

  const screenPlayer = new LoopPlayer($<HTMLVideoElement>("screen-player"));
  const cap = $("screen-caption");
  let lastClip: Blob | null = null;
  let cues: Cue[] = [];
  screenPlayer.onTime = (t) => {
    const text = cueAt(cues, t);
    if (cap.textContent !== text) cap.textContent = text;
  };
  const post = channel(async (m) => {
    if (m.t === "hold") {
      screenPlayer.stop();
      lastClip = null;
      setView("hold");
    } else if (m.t === "show") {
      cues = m.cues;
      cap.textContent = cueAt(cues, screenPlayer.time);
      setView("project");
      if (m.clip !== lastClip) {
        lastClip = m.clip;
        await screenPlayer.load(m.clip, m.start, m.end);
      }
    } else if (m.t === "caption") {
      cues = m.cues;
      showCaption(cap, cueAt(cues, screenPlayer.time));
    }
  });
  post({ t: "hello" });
  // Fullscreen on first click/keypress (browsers require a gesture).
  const fs = () => document.documentElement.requestFullscreen?.().catch(() => {});
  addEventListener("click", fs);
  addEventListener("keydown", (e) => e.key === "f" && fs());
}

// ---------- interactive sample ----------

async function loadSample() {
  try {
    const meta = await fetch("/sample/sample.json").then((r) => {
      if (!r.ok) throw new Error();
      return r.json();
    });
    const clip = await fetch(`/sample/${meta.clip}`).then((r) => r.blob());
    const ws = (meta.original as string).split(" ").map((p, i) => ({ w: p, p, s: i, e: i }));
    const whole = (text: string): Cue[] => [{ start: meta.start, end: meta.end, text }];
    result = {
      clip,
      phrase: { words: ws, start: meta.start, end: meta.end },
      original: meta.original,
      originalCues: meta.originalCues ?? whole(meta.original),
      alibis: (meta.alibis as Alibi[]).map((a) => ({ ...a, cues: a.cues ?? whole(a.text) })),
    };
    $("reveal-hint").textContent = "A sample clip, recorded with permission. Same footage, same speed, no sound.";
    $("upgrade-note").hidden = true;
    await reveal();
  } catch {
    fail("Sample not ready", "The sample clip isn't available yet. Record your own instead.");
  }
}
