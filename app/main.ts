import qrcode from "qrcode-generator";
import { openCamera, Recorder, type Take } from "./capture";
import { LoopPlayer } from "./player";
import { Lexicon } from "./lexicon";
import { Blocklist } from "./blocklist";
import type { Word, Phrase } from "./phrase";
import { rankPhrases, writeAlibis, caption, originalCues, expandSampleCues, cueAt, type Alibi, type Cue } from "./pipeline";
import { channel, type StageMsg } from "./stage";
import { DubController, ScreenDub, fit, wav, type Fitted, type DubTarget } from "./dub";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const app = $("app");
const setView = (v: string) => (app.dataset.view = v);
const status = (t: string) => ($("status").textContent = t);

const RECORD_SECONDS = 12;
const path = location.pathname.replace(/\/+$/, "") || "/";

// ---------- shared state ----------

interface Result {
  takeId: string; // identifies the recording for the dub cache
  duration: number; // playable clip length (Infinity if unknown)
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
    // Optional nudge for what the alibi is about; ignored if it hits the blocklist.
    const rawTopic = $<HTMLInputElement>("topic").value.trim().slice(0, 60);
    const topic = rawTopic && !block.blocks(rawTopic) ? rawTopic : "";
    const alibis = await writeAlibis(chosen, lex, block, post, status, [], topic);
    if (!alibis.length) throw new Retake("No clean alibi", "We couldn't find a funny line that fits your lips. Try again with a different answer.");
    dub?.cancel(); // a new take cancels any pending dub
    result = {
      takeId: newTakeId(), duration: tr.duration ?? Infinity,
      clip: take.video, phrase: chosen.phrase, original: caption(chosen.phrase.words.map((w) => w.p)),
      originalCues: originalCues(chosen.phrase), alibis,
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

const newTakeId = () => (crypto.randomUUID?.() ?? String(Math.random()).slice(2)).replace(/-/g, "").slice(0, 16);

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
// What the projector shows, saved at the moment it was sent. Browsing other alibis (or a new
// take) on the Surface never changes this; "Hear it" always dubs the alibi on screen.
let onScreen: { res: Result; alibi: Alibi | null; n: number } | null = null;
let revealId = 0;
let presenterKey = "";
let projectorAudio = false;
let dub: DubController | null = null;

const dubKey = (res: Result, alibi: Alibi) => `${res.takeId}|${alibi.text}`;

async function initPresenter() {
  const k = new URLSearchParams(location.search).get("k") ?? "";
  const ok = await fetch(`/api/stage?k=${encodeURIComponent(k)}`).then((r) => r.ok).catch(() => false);
  if (!ok) return; // plain crowd mode
  presenter = true;
  presenterKey = k;
  document.title = "Lip Service · presenter";
  send = channel((m) => {
    if (m.t === "hello") resendScreen();
    else if (m.t === "audio") {
      if (projectorAudio !== m.on) {
        projectorAudio = m.on;
        updatePresenter();
      }
    } else if (m.t === "dub-state") {
      dubStatus({
        queued: "Dub queued. It starts at the next loop.",
        playing: "Dub playing on the screen.",
        done: "Dub finished. Screen is back to the captioned loop.",
        stopped: "Dub stopped. Captions are back.",
        "no-audio": "Projector sound is off. Click the screen tab once, then press Hear it again.",
      }[m.state]);
    }
  });
  send({ t: "hold" });
  dub = new DubController(requestDub, (m) => send?.(m), dubStatus);

  $("p-send").addEventListener("click", () => {
    if (!result) return;
    dub!.cancel();
    screenState = "original";
    onScreen = { res: result, alibi: null, n: 0 };
    revealId++;
    resendScreen();
    updatePresenter();
  });
  $("p-reveal").addEventListener("click", () => {
    if (!result || selected === 0) return;
    dub!.cancel();
    const sameClip = onScreen?.res.clip === result.clip;
    screenState = "alibi";
    onScreen = { res: result, alibi: result.alibis[selected - 1], n: selected };
    revealId++;
    if (sameClip) send?.({ t: "caption", cues: onScreen.alibi!.cues, reveal: revealId });
    else resendScreen();
    updatePresenter();
  });
  $("p-back").addEventListener("click", () => {
    if (!onScreen) return;
    dub!.cancel();
    screenState = "original";
    onScreen = { ...onScreen, alibi: null, n: 0 };
    revealId++;
    send?.({ t: "caption", cues: onScreen.res.originalCues, reveal: revealId });
    updatePresenter();
  });
  $("p-hold").addEventListener("click", () => {
    dub!.cancel();
    screenState = "hold";
    onScreen = null;
    revealId++;
    send?.({ t: "hold" });
    updatePresenter();
  });
  $("p-hear").addEventListener("click", () => {
    if (screenState !== "alibi" || !onScreen?.alibi) return;
    const { res, alibi } = onScreen;
    const timed = alibi.tokens?.length && alibi.chunks?.length;
    const target: DubTarget = { key: dubKey(res, alibi), reveal: revealId, take: res.takeId, tokens: timed ? alibi.tokens! : null };
    dub!.hear(target).then(updatePresenter);
  });
  $("p-stop").addEventListener("click", () => dub!.cancel("Dub stopped. Captions are back."));
  $("p-save").addEventListener("click", () => saveSample(false));
  $("p-savedub").addEventListener("click", () => saveSample(true));
}

function dubStatus(text: string) {
  $("p-dub").textContent = text;
}

/** One timestamped TTS call (server-side auth, limits and cache), then fit it to the lips here. */
async function requestDub(target: DubTarget): Promise<Fitted> {
  const res = onScreen?.res;
  const alibi = onScreen?.alibi;
  if (!res || !alibi || dubKey(res, alibi) !== target.key || !alibi.chunks || !alibi.tokens) throw new Error("the screen changed");
  let r: Response;
  try {
    r = await fetch("/api/dub", {
      method: "POST",
      headers: { "content-type": "application/json", "x-presenter-key": presenterKey },
      body: JSON.stringify({ take: target.take, tokens: target.tokens }),
    });
  } catch {
    throw new Error("no connection");
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message ?? `server said ${r.status}`);
  const bytes = Uint8Array.from(atob(data.audio), (c) => c.charCodeAt(0));
  const sampleRate = 44100;
  const decoded = await new OfflineAudioContext(1, 1, sampleRate).decodeAudioData(bytes.buffer);
  const [lex] = await loadData();
  const closed = (ws: string[]) => ws.map((w) => !!lex.shapesOf([w])?.key.includes("P"));
  const playEnd = Math.min(res.phrase.end, Number.isFinite(res.duration) ? res.duration : Infinity);
  const out = fit({
    words: res.phrase.words, tokens: alibi.tokens, chunks: alibi.chunks, alignment: data.alignment,
    start: res.phrase.start, playEnd, pcm: decoded.getChannelData(0), sampleRate,
    closedSaid: closed(res.phrase.words.map((w) => w.w)), closedWrote: closed(alibi.tokens),
  });
  console.log("dub segments", out.segments, data.cached ? "(server cache)" : "(new synthesis)");
  return { key: target.key, pcm: out.pcm, sampleRate };
}

function resendScreen() {
  if (!send) return;
  if (screenState === "hold" || !onScreen) return send({ t: "hold" });
  const { res, alibi } = onScreen;
  send({ t: "show", clip: res.clip, start: res.phrase.start, end: res.phrase.end, cues: alibi ? alibi.cues : res.originalCues, reveal: revealId });
}

function updatePresenter() {
  const st = $("p-state");
  $<HTMLButtonElement>("p-reveal").disabled = screenState === "hold" || selected === 0;
  $<HTMLButtonElement>("p-back").disabled = screenState !== "alibi";
  $<HTMLButtonElement>("p-hear").disabled = screenState !== "alibi";
  $<HTMLButtonElement>("p-savedub").disabled = !result || !result.alibis.some((a) => dub?.cache.has(dubKey(result!, a)));
  $("p-send").textContent = screenState === "hold" ? "Show original on screen" : "Resend original to screen";
  const what =
    screenState === "hold" ? "Screen is holding." :
    screenState === "original" ? "Screen shows the original caption." :
    `Screen shows alibi ${onScreen?.n}.`;
  st.firstChild!.textContent = what + " ";
  $("p-audio").textContent = projectorAudio ? "Projector sound: on." : "Projector sound: off. Click the screen tab once during setup.";
}

function saveSample(withDub: boolean) {
  if (!result) return;
  const res = result;
  const ext = res.clip.type.includes("mp4") ? "mp4" : "webm";
  const dubs: Record<string, string> = {};
  res.alibis.forEach((a, i) => {
    if (dub?.cache.has(dubKey(res, a))) dubs[String(i)] = `dub-${i + 1}.wav`;
  });
  const meta = {
    clip: `clip.${ext}`,
    cueFormat: "word-reveal",
    takeId: res.takeId,
    start: res.phrase.start,
    end: res.phrase.end,
    duration: Number.isFinite(res.duration) ? res.duration : null,
    words: res.phrase.words,
    original: res.original,
    originalCues: res.originalCues,
    alibis: res.alibis,
    dubs,
  };
  download(res.clip, `clip.${ext}`);
  download(new Blob([JSON.stringify(meta, null, 2)], { type: "application/json" }), "sample.json");
  if (withDub) {
    res.alibis.forEach((a, i) => {
      const f = dub?.cache.get(dubKey(res, a));
      if (f) download(wav(f.pcm, f.sampleRate), `dub-${i + 1}.wav`);
    });
  }
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
  let showCaptions = true;
  screenPlayer.onTime = (t) => {
    if (!showCaptions) return;
    const text = cueAt(cues, t);
    if (cap.textContent !== text) cap.textContent = text;
  };
  // Sound is unlocked by one click during setup. Dub problems go to the presenter only.
  const sdub = new ScreenDub();
  let reveal = -1;
  let start = 0;
  sdub.onCaptions = (show) => {
    showCaptions = show;
    cap.hidden = !show;
    if (show) cap.textContent = cueAt(cues, screenPlayer.time);
  };
  sdub.onState = (state, key) => post({ t: "dub-state", state, key });
  screenPlayer.onLoop = () => sdub.boundary(screenPlayer.el, start);
  const post = channel(async (m) => {
    if (m.t === "hold") {
      sdub.stop();
      reveal = -1;
      screenPlayer.stop();
      lastClip = null;
      setView("hold");
    } else if (m.t === "dub") {
      sdub.queue(m, reveal);
    } else if (m.t === "dub-stop") {
      sdub.stop();
    } else if (m.t === "show") {
      sdub.stop(false);
      reveal = m.reveal;
      start = m.start;
      cues = m.cues;
      cap.textContent = cueAt(cues, screenPlayer.time);
      setView("project");
      if (m.clip !== lastClip) {
        lastClip = m.clip;
        await screenPlayer.load(m.clip, m.start, m.end);
      }
    } else if (m.t === "caption") {
      sdub.stop(false);
      reveal = m.reveal;
      cues = m.cues;
      showCaption(cap, cueAt(cues, screenPlayer.time));
    }
  });
  post({ t: "hello" });
  const reportAudio = () => {
    post({ t: "audio", on: sdub.audioOn });
    $("sound-hint").hidden = sdub.audioOn;
  };
  // Fullscreen and sound on first click/keypress (browsers require a gesture).
  const fs = () => {
    document.documentElement.requestFullscreen?.().catch(() => {});
    sdub.enable();
    setTimeout(reportAudio, 300);
  };
  setInterval(reportAudio, 3000);
  addEventListener("click", fs);
  addEventListener("keydown", (e) => e.key === "f" && fs());
}

// ---------- interactive sample ----------

/** Saved fitted dubs go straight into the presenter's cache: Hear it then needs no network. */
async function loadSampleDubs(res: Result, dubs: Record<string, string>) {
  for (const [i, file] of Object.entries(dubs)) {
    const alibi = res.alibis[Number(i)];
    if (!alibi || !/^[\w.-]+\.wav$/.test(file)) continue;
    try {
      const bytes = await fetch(`/sample/${file}`).then((r) => {
        if (!r.ok) throw new Error();
        return r.arrayBuffer();
      });
      const decoded = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(bytes);
      const key = dubKey(res, alibi);
      dub!.cache.set(key, { key, pcm: decoded.getChannelData(0), sampleRate: decoded.sampleRate });
    } catch {
      dubStatus(`Saved dub ${file} didn't load. The silent reveal still works.`);
    }
  }
  if (dub!.cache.size) dubStatus("Saved dub loaded. Hear it plays without the network.");
}

async function loadSample() {
  try {
    const meta = await fetch("/sample/sample.json").then((r) => {
      if (!r.ok) throw new Error();
      return r.json();
    });
    const clip = await fetch(`/sample/${meta.clip}`).then((r) => r.blob());
    // Older caption-only samples have no word timings, take id or dubs; they still play silently.
    const ws: Word[] = Array.isArray(meta.words) && meta.words.length
      ? meta.words
      : (meta.original as string).split(" ").map((p, i) => ({ w: p, p, s: i, e: i }));
    const sampleCues = (text: string, saved?: Cue[]) => {
      if (saved?.length && meta.cueFormat === "word-reveal") return saved;
      return expandSampleCues(saved?.length ? saved : [{ start: meta.start, end: meta.end, text }]);
    };
    result = {
      takeId: typeof meta.takeId === "string" ? meta.takeId : "sample",
      duration: typeof meta.duration === "number" ? meta.duration : Infinity,
      clip,
      phrase: { words: ws, start: meta.start, end: meta.end },
      original: meta.original,
      originalCues: sampleCues(meta.original, meta.originalCues),
      alibis: (meta.alibis as Alibi[]).map((a) => ({ ...a, cues: sampleCues(a.text, a.cues) })),
    };
    $("reveal-hint").textContent = "A sample clip, recorded with permission. Same footage, same speed, no sound.";
    if (presenter && dub && meta.dubs) await loadSampleDubs(result, meta.dubs);
    await reveal();
  } catch {
    fail("Sample not ready", "The sample clip isn't available yet. Record your own instead.");
  }
}
