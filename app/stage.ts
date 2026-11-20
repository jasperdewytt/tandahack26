// Presenter tab <-> projector tab on the same machine, over BroadcastChannel.
// The projector only ever receives the clip and the one caption it should show.

export type StageMsg =
  | { t: "hello" }
  | { t: "hold" }
  | { t: "show"; clip: Blob; start: number; end: number; caption: string }
  | { t: "caption"; caption: string };

const NAME = "lip-service-stage";

export function channel(onMsg: (m: StageMsg) => void): (m: StageMsg) => void {
  const ch = new BroadcastChannel(NAME);
  ch.onmessage = (e) => onMsg(e.data as StageMsg);
  return (m) => ch.postMessage(m);
}
