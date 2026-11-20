// Browser-side homophene lookup over the build-time index (public/lex.txt).
// Hard constraints: same syllable count, and the positions of closed lips (P),
// lip-on-teeth (F) and rounded lips (W) never change. Exact first, then one near miss.

export interface Entry { key: string; syl: number; cand: boolean }

const PROTECTED = new Set(["P", "F", "W"]);
const VOWELISH = ["A", "E", "O"];
const CONSONANTISH = ["D", "T", "L", "K", "J", "R"];

const STOP = new Set(
  ("a an the and or but if so of to in on at by for from with as is am are was were be been being it its it's " +
    "i i'm i've i'd i'll me my mine we us our you your he him his she her they them their this that these those " +
    "there here what which who whom whose when where why how do does did done have has had not no yes just " +
    "very really also too then than um uh like oh okay yeah well can could would should will shall may might must " +
    "some any all both each few more most other such only own same into about over under again out up down off " +
    "get got go going gonna wanna today brought bring bringing")
    .split(" "),
);

export class Lexicon {
  forward = new Map<string, Entry>();
  reverse = new Map<string, string[]>();
  rank = new Map<string, number>();

  static async load(url = "/lex.txt"): Promise<Lexicon> {
    const text = await (await fetch(url)).text();
    const lex = new Lexicon();
    let i = 0;
    for (const line of text.split("\n")) {
      if (!line) continue;
      const [word, key, syl, star] = line.split(" ");
      const e = { key, syl: Number(syl), cand: star !== "*" };
      lex.forward.set(word, e);
      lex.rank.set(word, i++);
      if (e.cand) {
        const k = `${key}|${e.syl}`;
        const list = lex.reverse.get(k);
        if (list) list.push(word);
        else lex.reverse.set(k, [word]);
      }
    }
    return lex;
  }

  isContent(word: string): boolean {
    const w = clean(word);
    return w.length >= 3 && !STOP.has(w) && this.forward.has(w);
  }

  /** Lip-compatible replacements for one word, most common first. */
  candidates(word: string, maxExact = 30, maxNear = 15): { exact: string[]; near: string[] } {
    const w = clean(word);
    const e = this.forward.get(w);
    if (!e) return { exact: [], near: [] };
    const notSelf = (c: string) => c !== w && !sameStem(c, w);
    const exact = (this.reverse.get(`${e.key}|${e.syl}`) ?? []).filter(notSelf).slice(0, maxExact);

    const near: string[] = [];
    const seen = new Set(exact);
    for (let i = 0; i < e.key.length; i++) {
      const c = e.key[i];
      if (PROTECTED.has(c)) continue;
      const pool = VOWELISH.includes(c) ? VOWELISH : CONSONANTISH;
      for (const r of pool) {
        if (r === c) continue;
        const k = collapse(e.key.slice(0, i) + r + e.key.slice(i + 1));
        for (const cand of this.reverse.get(`${k}|${e.syl}`) ?? []) {
          if (!seen.has(cand) && notSelf(cand)) {
            seen.add(cand);
            near.push(cand);
          }
        }
      }
    }
    near.sort((a, b) => (this.rank.get(a) ?? 1e9) - (this.rank.get(b) ?? 1e9));
    return { exact, near: near.slice(0, maxNear) };
  }
}

export const clean = (w: string) => w.toLowerCase().replace(/[^a-z']/g, "").replace(/^'+|'+$/g, "");

const collapse = (k: string) => k.replace(/(.)\1+/g, "$1");

// Avoid "swaps" that are just the same word inflected (bag -> bags).
function sameStem(a: string, b: string): boolean {
  const s = (x: string) => x.replace(/('s|s|es|ed|ing|er|ers)$/, "");
  return s(a) === s(b);
}
