# Lip Service

*your mouth has an alibi*

Live: https://lip-service.lip-service.workers.dev

Record a ~10 second answer on your phone. We transcribe it, find words your lips could just as easily have said, and loop the clip on mute so you can flip between what you said and two alibis. Build spec: [SPEC.md](SPEC.md).

## How it works

- `app/` — the browser app (TypeScript, bundled by esbuild into `public/app.js`). Records video plus a parallel audio-only track, picks a short phrase between pauses, looks up lip-compatible words, checks Opus drafts against the mouth movements and asks an editor to pick the jokes, and loops the clip.
- `src/worker.ts` — Cloudflare Worker. Proxies `/api/transcribe` (Deepgram Nova-3, word timings) and `/api/alibi` (Claude Opus 5.5 writer; prompt and settings in `src/prompt.ts`). Rate-limited per IP and globally with Cloudflare Rate Limiting bindings.
- `app/pipeline.ts` — picks the stretch to loop, asks the writer for lines, checks each against the lips (`Lexicon.check`) and times the subtitles.
- `src/dub.ts` + `app/dub.ts` — stage dub (presenter only). `POST /api/dub` needs the presenter key. One Durable Object enforces 5 syntheses/min and 20 per Brisbane day across the app, shares in-flight requests and caches by take, line, voice and settings (cache hits are free). One ElevenLabs `/with-timestamps` call (`eleven_flash_v2_5`) per line; the browser maps character times to the alibi's tokens and places each `Lexicon.check` chunk at its absolute lip time with pitch-preserving WSOLA.
- `scripts/build-index.mjs` — build-time lexicon. Spoken-English frequency list → blocklists (LDNOOBW + dsojevic) → CMUdict → 12 coarse mouth shapes → `public/lex.txt` and `public/block.json`. Exact matches keep the shape sequence and syllable count; one near miss may change a single shape, never closed lips (p/b/m), lip-on-teeth (f/v) or rounded lips (w/oo).

## Commands

```powershell
npm install
npm run index     # rebuild public/lex.txt + public/block.json (downloads sources once)
npm run deploy    # build the app and deploy the Worker
npm run offline   # serve public/ on http://localhost:8080 with no internet
node scripts/try-alibi.mjs testdata/<transcript>.json [--topic pirates] [--effort low]   # try the writer prompt locally
```

Secrets live in `.env` (gitignored) and as Worker secrets: `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`, `PRESENTER_TOKEN`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`.

Checks (stubs only, no paid calls): `npm run check`, `npx tsc --noEmit -p src`, `node scripts/test-caption-timing.mjs`, `node scripts/test-dub.mjs`.

## On stage

1. On the Surface, open the projector tab on the extended display: `/screen` (holding screen with the QR code). Click once for fullscreen.
2. On the Surface's own display, open the presenter tab: `/stage?k=<PRESENTER_TOKEN>`. Never show this URL.
3. Record the volunteer. Pick an alibi privately, press **Show original on screen**, then **Reveal selected alibi**. **Back to original** and **Hold screen** do what they say.
4. Stage dub. During setup, click the projector tab once to unlock sound (the presenter then shows "Projector sound: on"). After a reveal, **Hear it** dubs the alibi on screen, not whatever you browse afterwards. It plays once from the next loop start with captions hidden, then the captioned loop returns. **Stop dub** brings captions back at once. Hold, Back, a new reveal or a new take cancel a pending dub. **Hear it** again replays from cache. Dub errors show only on the presenter.

## The sample (fallback)

At kickoff, record a consented volunteer in presenter mode and press **Save as sample**. It downloads `clip.mp4` (or `.webm`) and `sample.json`. After a dub has played, **Save dub** downloads the same plus the fitted `dub-N.wav` files listed in `sample.json`; with those, **Hear it** needs no network. Put them all in `public/sample/`, commit and deploy. Older caption-only samples still load and reveal silently. Then:

- Public: `/sample` plays it, and the intro shows "Try the sample clip".
- Presenter: `/stage?k=<token>&sample` loads it straight into the stage flow.
- No internet: `npm run offline`, then `http://localhost:8080/stage?k=local&sample` and `http://localhost:8080/screen`.
