# Lip Service

*Your mouth has an alibi.*

**Phase 1 ships a silent illusion.** Scan the QR, record an answer and toggle two captions over identical footage. Target under a minute from scan to reveal. The crowd experience stays captions-only. The 11am audience test decides whether to build a stage dub. One-word-to-two-word splits (“carpet” → “car pit”) are stretch only.

## Phase 1 · recording to caption reveal

1. **Capture.** Ask “What did you bring with you today?” With consent, record ~10 seconds on the phone or the Surface’s own camera. Record video and a parallel audio-only track. Upload the audio as recorded. If dual recording fails, explain the video upload and send the single WebM/MP4 blob instead.
2. **Transcribe.** A thin Cloudflare Worker proxies the recording to Deepgram Nova-3’s pre-recorded API. Use word start/end times to select a short phrase between pauses. Serve the TypeScript app and index as static assets. The Worker proxies only Deepgram and Anthropic in Phase 1. Stream media through it and keep decoding and dictionary work in the browser to fit the Free plan’s 10 ms CPU budget. [Deepgram word timings](https://developers.deepgram.com/docs/pre-recorded-audio) · [Worker limits](https://developers.cloudflare.com/workers/platform/limits/)
3. **Find homophenes.** At build time, filter ~30,000 common words for slurs, hate terms and explicit sexual language. Map CMUdict pronunciations through Azure’s 22 visemes into ~12 coarse mouth shapes. Ship the reverse index by shape sequence and syllable count. In the browser, try exact matches for all content words, then allow one near-miss substitution. Preserve syllable count and the positions of closed lips (p/b/m), lip-on-teeth (f/v) and rounded lips (oo/w).
4. **Pick the joke.** Send Sonnet the phrase and a bounded candidate list per slot in one call. Ask for the two funniest grammatical single-word swaps **to read in silence**. The caption change alone must land the joke. Mild innuendo is fine. Validate each slot and word against its list. Apply the same blocklist to the transcript, Sonnet output and reconstructed captions before display. Offer a retake if neither exact nor near-miss candidates work.
5. **Reveal privately, then on stage.** Loop the phrase muted at normal speed. Switching captions leaves the playhead untouched. On the extended Surface display, open two same-origin tabs of the same app, synced via BroadcastChannel. A secret token in the presenter URL grants presenter access. Keep it off the projector URL and public QR. The projector holds until the presenter approves the original, then receives only the selected caption on reveal. Options stay on the Surface.

Keep keys in ignored local `.env` and Worker secrets. Rate-limit sessions, cap Sonnet at 400 output tokens and set separate ceilings for Deepgram and the shared US$150 Anthropic pool. If credits, capture or connectivity fail, offer the consented interactive sample on the public site and keep an offline copy on the Surface.

## Phase 2: stage dub (only if captions test well)

At 8am, with separate consent, clone the teammate once in ElevenLabs from a clean 1–2 minute reference. Store the voice ID in server config. This is advance preparation only. After a go decision, the presenter can request one timestamped TTS call for the whole alibi sentence during silent replay. No runtime cloning or clone queue is needed. On the Surface, cut the replacement word using its first and last character timestamps. Use SoundTouchJS to fit it to the Deepgram word window while preserving pitch, match surrounding loudness and crossfade ~20 ms at both edges. Hide captions for playback. The McGurk effect can help a near miss land. If synthesis or timing fails, use the rehearsed offline dub or finish in silence. [Timestamped TTS](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps)

## Brisbane run sheet · 20–21 November

| Time | Deliverable |
|---|---|
| Fri 11pm / midnight | Deploy HTTPS. Test dual recording and replay on iOS Safari and Android Chrome, then single-blob capture. Sleep. |
| Sat 8am / 9am / 10am | At kickoff, record the consented sample and prepare the optional stage voice. Wire Nova-3 / ship browser lookup / connect Sonnet, validate captions and deploy the toggle and sample. |
| **11am · deploy and decide** | With Wi-Fi off, record a fresh answer and toggle both captions on the hosted loop. Immediately test ten fresh answers from several speakers. For each, show a viewer the muted clip with the matched caption and a similarly funny decoy in randomized order. Ask which fits, then whether the matched caption lands as a joke. Count misses and failed takes. **Proposed go threshold: at least 8/10 answers pass both checks.** Otherwise keep the demo captions-only. |
| Noon / 1pm / 2pm | **Go:** wire stage TTS / splice and cache the fallback / test whether a listener can identify the voice and repeat the line. **No-go:** review misses / tune matching or humour / retest fresh clips and rehearse the silent reveal. Lunch 12:30. |
| 3pm / 4pm | Freeze features and finish two slides (stage reveal, crowd QR) / rehearse both tabs on the extended display. Verify options stay private, the offline sample plays and the QR works over mobile data. |
| 4:30pm / 5pm | Post the hosted link in **#showcase** / two-minute pitch, then two minutes for the room to play. |

**Pitch · citations to verify.** Taylor, Theobald & Matthews, *A Mouth Full of Words: Visually Consistent Acoustic Redubbing* (Disney Research, ICASSP 2015), is the closest prior work. *Bad Lip Reading* shows the joke works. Wav2Lip changes the footage. We keep every frame and find words the mouth already said. “AI writes the jokes; phonetics decides which ones your face can say.”

**Questions for Jasper.** Is the 8/10 gate right for the demo? Who can provide the sample, voice reference, phones and display adapter? What speech-service spend is approved?
