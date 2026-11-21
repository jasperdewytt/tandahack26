# Mouth Alibi

*your mouth has an alibi*

Live: https://mouth-alibi.lip-service.workers.dev (the old https://lip-service.lip-service.workers.dev deployment is left running for existing links)

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

Checks (stubs and saved responses only, no paid calls):

```powershell
npm run check
npx tsc --noEmit -p src
node scripts/test-caption-timing.mjs
node scripts/test-dub.mjs            # alignment, plan, stretch, fit failures, server limits, presenter controller
node scripts/test-dub-onsets.mjs     # word onsets after fitting (needs gitignored testdata/dub-response.json; skips otherwise)
node scripts/test-screen-dub.mjs     # projector playback on a simulated clock: duplicates, stalls, pause, seek, loop wrap
node scripts/test-sample-export.mjs  # Save as sample / Save dub manifests
node scripts/make-offline-fixture.mjs; node scripts/verify-offline.mjs testdata/offline-fixture   # synthetic offline run (ffmpeg + Chrome)
```

## On stage

1. On the Surface, open the projector tab on the extended display: `/screen` (holding screen with the QR code). Click once for fullscreen.
2. On the Surface's own display, open the presenter tab: `/stage?k=<PRESENTER_TOKEN>`. Never show this URL.
3. The talk: the presenter page has a numbered **Run the talk** list. The button to press next is red, the one on screen now is dark, and the line above it says whether the projector is connected with sound on. In order: **Title slide** → **Show the clip** → **Reveal the alibi** (the one picked on the left, else the first with a saved dub) → **Hear it** → **Final slide** (QR to the crowd flow; leave it up while the room plays). Slides stop any dub and keep the take and its cached dubs, so **Show the clip** goes straight back to it. A refreshed projector page picks up whatever the presenter is showing (click it once again for sound). On localhost the QR uses the hosted URL from `<meta name="crowd-url">` in `public/index.html`.
4. Record the volunteer. Pick an alibi privately, press **Show the clip**, then **Reveal the alibi**. **Back to what they said** and **Hold screen** do what they say.
5. Stage dub. During setup, click the projector tab once to unlock sound (the presenter then shows "Projector sound: on"). After a reveal, **Hear it** dubs the alibi on screen, not whatever you browse afterwards. It plays once from the next loop start with captions hidden, then the captioned loop returns. **Stop dub** brings captions back at once. Hold, Back, a new reveal or a new take cancel a pending dub. **Hear it** again replays from cache. Dub errors show only on the presenter.

## The sample (fallback)

At kickoff, record a consented volunteer in presenter mode and press **Save as sample**. It downloads `clip.mp4` (or `.webm`) and `sample.json`. After a dub has played, **Save dub** downloads the same plus a `dub-N.wav` for every alibi with a fitted dub; its `sample.json` lists exactly those WAVs (Save as sample's lists none). With them, **Hear it** needs no network. Put them all in `public/sample/` (only a recording whose speaker agreed to this use), commit and deploy. Older caption-only samples still load and reveal silently. Check the folder with external network blocked: `npm run build; node scripts/verify-offline.mjs`. Then:

- Public: `/sample` plays it, and the intro shows "Try the sample clip".
- Presenter: `/stage?k=<token>&sample` loads it straight into the stage flow.
- No internet: `npm run offline`, then `http://localhost:8080/stage?k=local&sample` and `http://localhost:8080/screen`.
