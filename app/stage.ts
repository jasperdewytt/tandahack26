// Presenter tab <-> projector tab on the same machine, over BroadcastChannel.
// The projector only ever receives the clip and the one set of subtitles it should show.
import type { Cue } from "./pipeline";
import type { DubMsg } from "./dub";

export type StageMsg =
  | { t: "hello" }
  | { t: "hold" }
  | { t: "slide"; n: Slide }
  | { t: "show"; clip: Blob; start: number; end: number; cues: Cue[]; reveal: number }
  | { t: "caption"; cues: Cue[]; reveal: number }
  | DubMsg
  // projector -> presenter (private status only; the projector never shows errors)
  | { t: "audio"; on: boolean }
  | { t: "dub-state"; state: "queued" | "playing" | "done" | "stopped" | "no-audio"; key?: string };

export type Slide = "title" | "final";

const NAME = "mouth-alibi-stage";

export function channel(onMsg: (m: StageMsg) => void): (m: StageMsg) => void {
  const ch = new BroadcastChannel(NAME);
  ch.onmessage = (e) => onMsg(e.data as StageMsg);
  return (m) => ch.postMessage(m);
}
