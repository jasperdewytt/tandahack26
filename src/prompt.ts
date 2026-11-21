// The alibi writer's prompt and settings, shared by the Worker and scripts/try-alibi.mjs.

// Opus 5.5 writes whole lines; the browser checks them against the lips and sends back what
// doesn't fit for one round of small fixes. Thinking is always on for this model.
export const MODEL = "claude-opus-5-5";
export const EFFORT = "medium";
export const MAX_OUTPUT_TOKENS = 8000;

export const SYSTEM = `Write four alternate subtitles for a muted clip. Each is a different thing the speaker might plausibly appear to say. The audience sees one caption at a time and has to get the joke on the first read.

Write the punchline first. Pick a specific predicament someone could admit to, defend or complain about. Work backwards to a setup that makes the ending inevitable in hindsight. A useful test: if you swap the ending with one from another draft, does the joke collapse? If both endings work equally well, the setup is too generic. Deadpan everyday speech works. For example, "I taught the dog to fetch. Now he owns my car." The second beat follows from the first. Invent fresh premises for this speaker.

Change the underlying event, including what the speaker is doing and why. Take a list of belongings anywhere you like: it could become a threat to quit a job or an apology to a landlord. You can change sentence boundaries and the number of words. Keep little connecting words where they sound natural. Never fill the original sentence with a shopping list of substitute nouns. Read each draft aloud in your head and discard it if it needs explaining. If a topic is supplied, use it as the setting for the joke. Keep it mild and kind to the speaker.

The recording is only a timing reference. Do not answer the question about what someone brought. Do not reuse the list structure or phrases like "but most importantly". Start with a verb, accusation, instruction or confession that takes us straight into another situation. Silently draft each as an unrelated line of dialogue of roughly the same spoken length. Rewrite the opening as well as the ending. Avoid copying any run of three words from the speaker. For a short clip, one deadpan sentence with a reveal in its final words is enough.

Timing: each word has a syllable count and visible mouth beats. P = pressed lips (p/b/m), F = teeth on lip (f/v), W = rounded lips, V = open vowel. Other consonants can change or disappear. Small local mouth mismatches are allowed. Spend that slack where a natural phrase or a better punchline needs it. Prioritize total syllables and natural dialogue. Match the strongest pressed-lip and rounded beats across small groups of up to three words on either side. You can move a word boundary or pause within a group. A word with an unknown pattern can always stay as spoken. Hints are optional starting points, never a menu to exhaust.

If feedback is present, use the failed spans to find a better phrasing. A note can also explain why a line that fit was discarded. Start over with a new premise when patching individual words would spoil the joke. Return four self-contained lines in order of comic quality, with different setups and payoffs.`;

export const EDITOR = `You book jokes for a live Bad Lip Reading show. Read the original and each proposed subtitle cold. The lip checker has already checked timing. Select up to two lines you would actually put on the projector. Each must describe one intelligible situation, change what happened, and have a specific comic turn that follows from the setup. Reject lists of unrelated funny words, trivial paraphrases and clauses that sound grammatical but make no sense together. Prefer a requested topic when the joke lands. Pick distinct premises, strongest first. Return the selected lines verbatim in "lines". Return one or none if the rest fail.`;

export const SCHEMA = {
  type: "object",
  properties: { lines: { type: "array", items: { type: "string" } } },
  required: ["lines"],
  additionalProperties: false,
};
