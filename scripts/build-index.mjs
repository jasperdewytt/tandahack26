// Build-time lexicon: frequency list -> blocklist filter -> CMUdict -> coarse viseme key.
// Output: public/lex.txt (one "word key syllables [*]" line per word, most frequent first;
// "*" marks words outside the candidate pool that are only used to read the transcript)
// and public/block.json (the same blocklist the browser applies to every caption).
//
// Sources (downloaded into scripts/.cache, not committed):
//   hermitdave/FrequencyWords en_50k (OpenSubtitles 2018; spoken English)
//   LDNOOBW List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words (en)
//   dsojevic/profanity-list (en.json; adds slurs and hate terms with tags)
//   cmusphinx/cmudict
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cache = join(here, ".cache");
const out = join(here, "..", "public");
const CANDIDATES = 30000;

const SOURCES = {
  "freq.txt": "https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_50k.txt",
  "block.txt": "https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/master/en",
  "dsojevic.json": "https://raw.githubusercontent.com/dsojevic/profanity-list/main/en.json",
  "cmudict.dict": "https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict",
};

mkdirSync(cache, { recursive: true });
for (const [name, url] of Object.entries(SOURCES)) {
  const p = join(cache, name);
  if (existsSync(p)) continue;
  console.log("downloading", url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  writeFileSync(p, Buffer.from(await r.arrayBuffer()));
}

// ---------- coarse visemes ----------
// Azure's 22 visemes collapsed to 14 mouth shapes a viewer can tell apart in silence.
//   P closed lips (p b m)      F lip on teeth (f v)      D tongue between teeth (th dh)
//   T alveolar (t d n s z)     L tongue tip up (l)       K back/hidden (k g ng h y)
//   J lips pushed out (sh zh ch jh)                      R r-colour (r er)
//   W rounded tight (w uw)     O rounded open (ao ow oy)    U open-to-rounded (aw)
//   A open (aa ae ah)          I open-to-spread (ay)        E spread (eh ey ih iy uh)
const VISEME = {
  P: "P", B: "P", M: "P",
  F: "F", V: "F",
  TH: "D", DH: "D",
  T: "T", D: "T", N: "T", S: "T", Z: "T",
  L: "L",
  K: "K", G: "K", NG: "K", HH: "K", Y: "K",
  SH: "J", ZH: "J", CH: "J", JH: "J",
  R: "R", ER: "R",
  W: "W", UW: "W",
  AO: "O", OW: "O", OY: "O", AW: "U",
  AA: "A", AE: "A", AH: "A", AY: "I",
  EH: "E", EY: "E", IH: "E", IY: "E", UH: "E",
};
const VOWELS = new Set(["AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY", "IH", "IY", "OW", "OY", "UH", "UW"]);

function keyFor(phones) {
  let key = "";
  let syl = 0;
  for (const raw of phones) {
    const ph = raw.replace(/\d/g, "");
    const v = VISEME[ph];
    if (!v) throw new Error("unknown phone " + raw);
    if (VOWELS.has(ph)) syl++;
    // Adjacent identical shapes read as one on the lips ("cats" ~ "cat" + held T).
    if (key[key.length - 1] !== v) key += v;
  }
  return { key, syl };
}

// ---------- blocklist ----------
const words = new Set();
const phrases = new Set();
const patterns = new Set();
const norm = (s) => s.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
const addTerm = (t) => {
  t = norm(t);
  if (!t) return;
  if (t.includes("*")) patterns.add(t);
  else if (t.includes(" ")) phrases.add(t);
  else words.add(t);
};
for (const line of readFileSync(join(cache, "block.txt"), "utf8").split(/\r?\n/)) addTerm(line);
for (const e of JSON.parse(readFileSync(join(cache, "dsojevic.json"), "utf8"))) {
  const hateful = (e.tags ?? []).some((t) => ["racial", "lgbtq", "religious", "shock"].includes(t));
  if (e.severity < 2 && !hateful) continue; // severity 1 is mild ("damn"); innuendo is allowed
  for (const alt of String(e.match).split("|")) addTerm(alt);
}
// "x*" in dsojevic means one-or-more of x; compile once for the filter below.
const patternRes = [...patterns].map((p) => new RegExp("^" + p.replace(/[.+?^${}()[\]\\]/g, "\\$&").replace(/\*/g, "+") + "$"));
const isBlockedWord = (w) => words.has(w) || patternRes.some((re) => re.test(w));

// ---------- CMUdict ----------
const pron = new Map();
for (const line of readFileSync(join(cache, "cmudict.dict"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([a-z'.-]+)(\(\d+\))?\s+([A-Z0-9 ]+?)(\s+#.*)?$/);
  if (!m || m[2]) continue; // first pronunciation only
  pron.set(m[1], m[3].split(" "));
}

// ---------- assemble ----------
const lines = [];
let rank = 0, cand = 0, skippedBlock = 0, skippedNoPron = 0;
const seen = new Set();
for (const line of readFileSync(join(cache, "freq.txt"), "utf8").split(/\r?\n/)) {
  const w = line.split(" ")[0]?.toLowerCase();
  if (!w || seen.has(w)) continue;
  seen.add(w);
  rank++;
  if (!/^[a-z][a-z']*$/.test(w)) continue;
  if (isBlockedWord(w)) { skippedBlock++; continue; }
  const p = pron.get(w);
  if (!p) { skippedNoPron++; continue; }
  const { key, syl } = keyFor(p);
  // Candidate pool: top ~30k, minus single letters and odd contractions.
  const isCand = rank <= CANDIDATES && (w.length > 1 || w === "a" || w === "i") && !/'$/.test(w);
  if (isCand) cand++;
  lines.push(`${w} ${key} ${syl}${isCand ? "" : " *"}`);
}

// Speech frequency files often split contractions. Keep dictionary pronunciations for
// contractions and inflections of familiar words so natural dialogue can pass the checker.
for (const [word, phones] of pron) {
  if (seen.has(word) || !/^[a-z][a-z']+$/.test(word) || isBlockedWord(word)) continue;
  const stem = word.replace(/(?:s|ed|ing)$/, "");
  if (!word.includes("'") && (stem === word || !(seen.has(stem) || seen.has(stem + "e")))) continue;
  const { key, syl } = keyFor(phones);
  lines.push(`${word} ${key} ${syl} *`);
}

writeFileSync(join(out, "lex.txt"), lines.join("\n") + "\n");
writeFileSync(
  join(out, "block.json"),
  JSON.stringify({ words: [...words].sort(), phrases: [...phrases].sort(), patterns: [...patterns].sort() }),
);
console.log(
  `lex.txt: ${lines.length} words (${cand} candidates); blocked ${skippedBlock}, no pronunciation ${skippedNoPron}; ` +
    `blocklist ${words.size} words, ${phrases.size} phrases, ${patterns.size} patterns`,
);
