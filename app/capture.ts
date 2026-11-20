// Camera capture: one MediaRecorder for video (+audio, for the projector/sample),
// and a parallel audio-only recorder whose small blob is what we upload.

export interface Take {
  video: Blob;
  audio: Blob | null; // null when the parallel audio recorder failed
}

const VIDEO_TYPES = [
  "video/mp4;codecs=avc1,mp4a",
  "video/mp4",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];
const AUDIO_TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];

function pick(types: string[]): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return types.find((t) => MediaRecorder.isTypeSupported?.(t));
}

export async function openCamera(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 960 } },
    audio: { echoCancellation: true, noiseSuppression: true },
  });
}

function recorderBlob(rec: MediaRecorder, chunks: Blob[], fallbackType: string): Promise<Blob> {
  return new Promise((resolve) => {
    rec.addEventListener(
      "stop",
      () => resolve(new Blob(chunks, { type: (rec.mimeType || fallbackType).split(";")[0] })),
      { once: true },
    );
  });
}

export class Recorder {
  private videoRec: MediaRecorder;
  private audioRec: MediaRecorder | null = null;
  private videoDone: Promise<Blob>;
  private audioDone: Promise<Blob | null> = Promise.resolve(null);

  constructor(private stream: MediaStream) {
    const vChunks: Blob[] = [];
    const vType = pick(VIDEO_TYPES);
    this.videoRec = new MediaRecorder(stream, vType ? { mimeType: vType, videoBitsPerSecond: 2_500_000 } : {});
    this.videoRec.ondataavailable = (e) => e.data.size && vChunks.push(e.data);
    this.videoDone = recorderBlob(this.videoRec, vChunks, "video/webm");

    try {
      const aChunks: Blob[] = [];
      const aType = pick(AUDIO_TYPES);
      const audioStream = new MediaStream(stream.getAudioTracks());
      const rec = new MediaRecorder(audioStream, aType ? { mimeType: aType } : {});
      rec.ondataavailable = (e) => e.data.size && aChunks.push(e.data);
      const done = recorderBlob(rec, aChunks, "audio/webm");
      rec.onerror = () => (this.audioRec = null);
      this.audioRec = rec;
      this.audioDone = done.then((b) => (b.size > 1000 ? b : null)).catch(() => null);
    } catch {
      this.audioRec = null;
    }
  }

  start() {
    this.videoRec.start(500);
    try {
      this.audioRec?.start(500);
    } catch {
      this.audioRec = null;
      this.audioDone = Promise.resolve(null);
    }
  }

  async stop(): Promise<Take> {
    if (this.videoRec.state !== "inactive") this.videoRec.stop();
    if (this.audioRec && this.audioRec.state !== "inactive") this.audioRec.stop();
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), 2500));
    const [video, audio] = await Promise.all([this.videoDone, Promise.race([this.audioDone, timeout])]);
    this.stream.getTracks().forEach((t) => t.stop());
    return { video, audio };
  }
}
