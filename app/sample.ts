// Building the offline sample download. The manifest (sample.json) only ever refers to files
// this same export produces, so every WAV it lists resolves to the matching exported file.
import { wav, type Fitted } from "./dub";
import type { Alibi, Cue } from "./pipeline";
import type { Phrase } from "./phrase";

export interface SampleSource {
  takeId: string;
  duration: number;
  clip: Blob;
  phrase: Phrase;
  original: string;
  originalCues: Cue[];
  alibis: Alibi[];
}

export interface ExportFile { name: string; blob: Blob }

/** `dubFor(i)` returns the fitted dub cached for alibi i, if any. WAVs are included only with `withDub`. */
export function sampleExport(res: SampleSource, dubFor: (i: number) => Fitted | undefined, withDub: boolean) {
  const ext = res.clip.type.includes("mp4") ? "mp4" : "webm";
  const files: ExportFile[] = [{ name: `clip.${ext}`, blob: res.clip }];
  const dubs: Record<string, string> = {};
  if (withDub) {
    res.alibis.forEach((_, i) => {
      const f = dubFor(i);
      if (!f) return;
      const name = `dub-${i + 1}.wav`;
      files.push({ name, blob: wav(f.pcm, f.sampleRate) });
      dubs[String(i)] = name;
    });
  }
  const meta = {
    clip: files[0].name,
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
  files.splice(1, 0, { name: "sample.json", blob: new Blob([JSON.stringify(meta, null, 2)], { type: "application/json" }) });
  return { files, meta };
}
