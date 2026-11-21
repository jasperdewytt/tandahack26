# Mouth Alibi

Record a 10-second answer on your phone. Mouth Alibi transcribes it, has Claude write funny lines your lips could just as easily have said, and loops the clip on mute so you can flip between what you said and the alibis.

Built in a day at Tanda Hackathon 2026 with Claude Code.

## How it works

Deepgram transcribes the clip with word timings. Claude writes candidate lines, and the browser checks each one against the speaker's mouth shapes using a 12-shape lexicon built from CMUdict, keeping only the lines that fit. A Cloudflare Worker sits in front of the APIs with per-IP and global rate limits. On stage, ElevenLabs dubs the chosen line to fit the lips.

## Run it

```sh
npm install
npm run index    # build the lip-shape lexicon
npm run deploy   # build and deploy the Worker
npm run check
```

Put `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` and `PRESENTER_TOKEN` in `.env` and in the Worker's secrets.
