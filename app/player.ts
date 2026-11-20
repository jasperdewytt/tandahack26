// Muted, normal-speed loop of [start, end] within a clip. Changing the caption never
// touches the video element, so the playhead is never moved by a toggle.

export class LoopPlayer {
  private raf = 0;
  private url: string | null = null;
  start = 0;
  end = Infinity;

  constructor(private video: HTMLVideoElement) {
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("muted", "");
    video.playbackRate = 1;
  }

  async load(clip: Blob | string, start = 0, end = Infinity) {
    this.stop();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = typeof clip === "string" ? null : URL.createObjectURL(clip);
    this.start = start;
    this.end = end;
    this.video.src = this.url ?? (clip as string);
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      this.video.addEventListener("loadeddata", done, { once: true });
      this.video.addEventListener("error", done, { once: true });
      setTimeout(done, 4000);
    });
    this.video.currentTime = start;
    this.play();
  }

  play() {
    this.video.play().catch(() => {
      /* autoplay can be refused until a tap; the next user gesture retries */
    });
    const tick = () => {
      const t = this.video.currentTime;
      if (t >= this.end || this.video.ended || t < this.start - 0.25) {
        this.video.currentTime = this.start;
        if (this.video.paused) this.video.play().catch(() => {});
      }
      this.raf = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.video.pause();
  }
}
