# Lip Service

*your mouth has an alibi*

Live: https://lip-service.lip-service.workers.dev

Record a ~10 second answer on your phone. We transcribe it, find words your lips could just as easily have said, and loop the clip on mute so you can flip between what you said and two alibis. Build spec: [SPEC.md](SPEC.md).

## How it works

- `app/` — the browser app (TypeScript, bundled by esbuild into `public/app.js`). Records video plus a parallel audio-only track, picks a short phrase between pauses, looks up lip-compatible words, validates Sonnet's picks, and loops the clip.
- `src/worker.ts` — Cloudflare Worker. Proxies `/api/transcribe` (Deepgram Nova-3, word timings) and `/api/alibi` (Claude Sonnet, 400 output tokens, JSON schema). Rate-limited per IP and globally with Cloudflare Rate Limiting bindings.
- `scripts/build-index.mjs` — build-time lexicon. Spoken-English frequency list → blocklists (LDNOOBW + dsojevic) → CMUdict → 12 coarse mouth shapes → `public/lex.txt` and `public/block.json`. Exact matches keep the shape sequence and syllable count; one near miss may change a single shape, never closed lips (p/b/m), lip-on-teeth (f/v) or rounded lips (w/oo).

## Commands

```powershell
npm install
npm run index     # rebuild public/lex.txt + public/block.json (downloads sources once)
npm run deploy    # build the app and deploy the Worker
npm run offline   # serve public/ on http://localhost:8080 with no internet
```

Secrets live in `.env` (gitignored) and as Worker secrets: `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`, `PRESENTER_TOKEN`.

## On stage

1. On the Surface, open the projector tab on the extended display: `/screen` (holding screen with the QR code). Click once for fullscreen.
2. On the Surface's own display, open the presenter tab: `/stage?k=<PRESENTER_TOKEN>`. Never show this URL.
3. Record the volunteer. Pick an alibi privately, press **Show original on screen**, then **Reveal selected alibi**. **Back to original** and **Hold screen** do what they say.

## The sample (fallback)

At kickoff, record a consented volunteer in presenter mode and press **Save as sample**. It downloads `clip.mp4` (or `.webm`) and `sample.json`. Put both in `public/sample/`, commit and deploy. Then:

- Public: `/sample` plays it, and the intro shows "Try the sample clip".
- Presenter: `/stage?k=<token>&sample` loads it straight into the stage flow.
- No internet: `npm run offline`, then `http://localhost:8080/stage?k=local&sample` and `http://localhost:8080/screen`.
