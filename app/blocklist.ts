// The same blocklist the build step used, applied to transcripts, model output and
// reconstructed captions before anything is displayed.

export class Blocklist {
  private words = new Set<string>();
  private phrases: string[] = [];
  private patterns: RegExp[] = [];

  static async load(url = "/block.json"): Promise<Blocklist> {
    const data = await (await fetch(url)).json();
    const b = new Blocklist();
    b.words = new Set(data.words);
    b.phrases = data.phrases;
    b.patterns = data.patterns.map(
      (p: string) => new RegExp("^" + p.replace(/[.+?^${}()[\]\\]/g, "\\$&").replace(/\*/g, "+") + "$"),
    );
    return b;
  }

  /** True when any word, phrase or pattern in the text is blocked. */
  blocks(text: string): boolean {
    const norm = text.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();
    const tokens = norm.split(" ");
    for (const t of tokens) {
      const bare = t.replace(/'s$/, "");
      if (this.words.has(t) || this.words.has(bare)) return true;
      if (this.patterns.some((re) => re.test(t))) return true;
    }
    const padded = ` ${norm} `;
    return this.phrases.some((p) => padded.includes(` ${p} `));
  }
}
