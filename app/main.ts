import qrcode from "qrcode-generator";
import { openCamera, Recorder, type Take } from "./capture";
import { LoopPlayer } from "./player";
import { Lexicon, clean } from "./lexicon";
import { Blocklist } from "./blocklist";
import { spans, toPhrase, type Word, type Phrase } from "./phrase";
import { channel, type StageMsg } from "./stage";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const app = $("app");
const setView = (v: string) => (app.dataset.view = v);
const status = (t: string) => ($("status").textContent = t);

const RECORD_SECONDS = 10;
const path = location.pathname.replace(/\/+$/, "") || "/";

// ---------- shared state ----------

interface Alibi { i: number; word: string; text: string; near: boolean }
interface Result {
  clip: Blob;
  phrase: Phrase;
  original: string;
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
$<HTMLInputElement>("file").addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = "";
  if (f) process({ video: f, audio: null });
});

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
    const tr = await api("/api/transcribe", upload, upload.type || "application/octet-stream");
    const words: Word[] = tr.words ?? [];
    if (words.length < 2) throw new Retake("We didn't catch that", "Speak up and answer in a full sentence, facing the camera.");

    status("Reading your lips…");
    const [lex, block] = await loadData();
    const ranked = rankPhrases(words, lex, block, tr.duration ?? Infinity);
    if (!ranked.length) throw new Retake("No alibi this time", "Your lips were too honest. Try a longer answer that names a few things.");

    status("Writing your alibi…");
    let alibis: Alibi[] = [];
    let chosen = ranked[0];
    // One Sonnet call normally; a second only if the first phrase yields nothing valid.
    for (const cand of ranked.slice(0, 2)) {
      chosen = cand;
      alibis = await askSonnet(cand, block);
      if (alibis.length) break;
    }
    if (!alibis.length) throw new Retake("No clean alibi", "We couldn't find a funny line that fits your lips. Try again with a different answer.");

    result = {
      clip: take.video,
      phrase: chosen.phrase,
      original: caption(chosen.phrase.words),
      alibis,
    };
    await reveal();
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

interface Ranked {
  phrase: Phrase;
  slots: { i: number; word: string; exact: string[]; near: string[] }[];
  score: number;
}

function rankPhrases(words: Word[], lex: Lexicon, block: Blocklist, duration: number): Ranked[] {
  const seen = new Set<string>();
  const out: Ranked[] = [];
  for (const span of spans(words)) {
    const id = `${span[0].s}-${span.length}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (block.blocks(span.map((w) => w.p).join(" "))) continue;
    const slots = span
      .map((w, i) => ({ i, word: w.w, ...lex.candidates(w.w) }))
      .filter((s) => lex.isContent(s.word) && (s.exact.length || s.near.length))
      .map((s) => ({ ...s, exact: s.exact.filter((c) => !block.blocks(c)), near: s.near.filter((c) => !block.blocks(c)) }));
    if (!slots.length) continue;
    const richness = slots.reduce((n, s) => n + Math.min(s.exact.length, 12) * 2 + Math.min(s.near.length, 6), 0);
    const sizeBonus = span.length >= 3 && span.length <= 6 ? 8 : 0;
    out.push({ phrase: toPhrase(span, duration), slots: slots.slice(0, 6), score: richness + sizeBonus });
  }
  return out.sort((a, b) => b.score - a.score);
}

async function askSonnet(r: Ranked, block: Blocklist): Promise<Alibi[]> {
  const words = r.phrase.words;
  const payload = { phrase: words.map((w) => w.p), slots: r.slots };
  const data = await api("/api/alibi", JSON.stringify(payload), "application/json");
  const out: Alibi[] = [];
  for (const a of data.alibis ?? []) {
    const slot = r.slots.find((s) => s.i === a.slot);
    const word = clean(String(a.word));
    if (!slot || !word) continue;
    const exact = slot.exact.includes(word);
    if (!exact && !slot.near.includes(word)) continue; // not from the lip-checked list
    if (block.blocks(word)) continue;
    const swapped = words.map((w, i) => (i === a.slot ? { ...w, p: swapCase(w.p, word) } : w));
    const text = caption(swapped);
    if (block.blocks(text) || out.some((o) => o.text === text)) continue;
    out.push({ i: a.slot, word, text, near: !exact });
    if (out.length === 2) break;
  }
  return out;
}

/** Replace a punctuated word, keeping its capitalisation and trailing punctuation. */
function swapCase(orig: string, repl: string): string {
  const m = orig.match(/^([^A-Za-z']*)([A-Za-z']+)(.*)$/);
  if (!m) return repl;
  const [, pre, core, post] = m;
  const r = /^[A-Z]/.test(core) ? repl[0].toUpperCase() + repl.slice(1) : repl;
  return pre + r + post;
}

const caption = (ws: Word[]) => {
  const s = ws.map((w) => w.p).join(" ").replace(/[,;:–—-]+$/, "");
  return s[0].toUpperCase() + s.slice(1);
};

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

function buildToggle() {
  const box = $("toggle");
  box.replaceChildren();
  if (!result) return;
  const opts = [{ label: "What you said", text: result.original, mark: -1 }].concat(
    result.alibis.map((a, n) => ({ label: `Alibi ${n + 1}`, text: a.text, mark: a.i })),
  );
  opts.forEach((o, n) => {
    const b = document.createElement("button");
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(n === selected));
    const label = document.createElement("b");
    label.textContent = o.label;
    b.append(label);
    // Underline the swapped word so the change is easy to spot.
    const words = o.text.split(" ");
    words.forEach((w, i) => {
      if (i) b.append(" ");
      if (i === o.mark) {
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
  showCaption($("caption"), captionFor(selected));
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
    send?.({ t: "caption", caption: captionFor(selected) });
    updatePresenter();
  });
  $("p-back").addEventListener("click", () => {
    if (!result) return;
    screenState = "original";
    send?.({ t: "caption", caption: result.original });
    updatePresenter();
  });
  $("p-hold").addEventListener("click", () => {
    screenState = "hold";
    send?.({ t: "hold" });
    updatePresenter();
  });
  $("p-save").addEventListener("click", saveSample);
}

let shownCaption = "";
function resendScreen() {
  if (!send) return;
  if (screenState === "hold" || !result) return send({ t: "hold" });
  shownCaption = screenState === "alibi" && selected > 0 ? captionFor(selected) : result.original;
  send({ t: "show", clip: result.clip, start: result.phrase.start, end: result.phrase.end, caption: shownCaption });
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
  const post = channel(async (m) => {
    if (m.t === "hold") {
      screenPlayer.stop();
      lastClip = null;
      setView("hold");
    } else if (m.t === "show") {
      cap.textContent = m.caption;
      setView("project");
      if (m.clip !== lastClip) {
        lastClip = m.clip;
        await screenPlayer.load(m.clip, m.start, m.end);
      }
    } else if (m.t === "caption") {
      showCaption(cap, m.caption);
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
    result = {
      clip,
      phrase: { words: ws, start: meta.start, end: meta.end },
      original: meta.original,
      alibis: meta.alibis,
    };
    $("reveal-hint").textContent = "A sample clip, recorded with permission. Same footage, same speed, no sound.";
    await reveal();
  } catch {
    fail("Sample not ready", "The sample clip isn't available yet. Record your own instead.");
  }
}
