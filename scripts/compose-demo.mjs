// Compose the demo video from make-demo.mjs output (take.mp4, dub.wav, cues.json) and the
// stage slides: title → what they said (original audio) → beat → the alibi (dub) → final slide.
//   node scripts/compose-demo.mjs testdata/demo   → testdata/demo/mouth-alibi-demo.mp4
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? "testdata/demo");
const slides = resolve("testdata/slides");
const cues = JSON.parse(readFileSync(join(dir, "cues.json"), "utf8"));
const take = join(dir, "take.mp4");
const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", take]).toString());
const LEAD = 0.09; // same head start the app gives captions

const t = (s) => {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${sec.toFixed(2).padStart(5, "0")}`;
};
const esc = (s) => s.replace(/[{}]/g, "").replace(/\n/g, "\\N");
function ass(list, label) {
  const sorted = [...list].sort((a, b) => a.start - b.start);
  const lines = sorted.map((c, i) => {
    const end = Math.min(c.end, sorted[i + 1]?.start ?? Infinity);
    return `Dialogue: 0,${t(c.start - LEAD)},${t(end - LEAD)},Cap,,0,0,0,,${esc(c.text)}`;
  });
  if (label) lines.push(`Dialogue: 1,${t(0)},${t(dur)},Label,,0,0,0,,${esc(label)}`);
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Arial,72,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,5,2,2,120,120,90,1
Style: Label,Arial,40,&H0040E6FF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,2,0,1,3,0,7,60,60,50,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${lines.join("\n")}
`;
}
writeFileSync(join(dir, "said.ass"), ass(cues.said, "WHAT THEY SAID"));
writeFileSync(join(dir, "alibi.ass"), ass(cues.alibi, "THE ALIBI · dubbed in their own voice"));
writeFileSync(join(dir, "beat.ass"), ass([{ start: 0.3, end: 9, text: "But their mouth has an alibi…" }], ""));

const ff = (a) => execFileSync("ffmpeg", ["-v", "error", "-y", ...a], { cwd: dir, stdio: "inherit" });
const V = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", "30"];
const A = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"];
// Portrait clip centred over a blurred, darkened copy of itself.
const frame = "[0:v]split[a][b];[a]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=40:2,eq=brightness=-0.25[bg];[b]scale=-2:1080[fg];[bg][fg]overlay=(W-w)/2:0,setsar=1";

function slide(png, secs, out) {
  ff(["-loop", "1", "-t", String(secs), "-i", join(slides, png), "-f", "lavfi", "-t", String(secs), "-i", "anullsrc=r=48000:cl=stereo",
    "-vf", "scale=1920:1080,setsar=1,fade=t=in:st=0:d=0.4", ...V, ...A, "-shortest", out]);
}
slide("title-1920x1080.png", 3, "seg1.mp4");
ff(["-i", "take.mp4", "-filter_complex", `${frame},subtitles=said.ass[v];[0:a]loudnorm=I=-16:TP=-1.5[a]`, "-map", "[v]", "-map", "[a]", ...V, ...A, "seg2.mp4"]);
ff(["-i", "take.mp4", "-f", "lavfi", "-t", "2.5", "-i", "anullsrc=r=48000:cl=stereo", "-filter_complex",
  `[0:v]trim=end_frame=1,loop=loop=75:size=1:start=0,setpts=N/30/TB,split[a][b];[a]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=40:2,eq=brightness=-0.25[bg];[b]scale=-2:1080,eq=brightness=-0.15[fg];[bg][fg]overlay=(W-w)/2:0,setsar=1,subtitles=beat.ass[v]`,
  "-map", "[v]", "-map", "1:a", "-t", "2.5", ...V, ...A, "seg3.mp4"]);
ff(["-i", "take.mp4", "-i", "dub.wav", "-filter_complex", `${frame},subtitles=alibi.ass[v];[1:a]loudnorm=I=-16:TP=-1.5,apad[a]`, "-map", "[v]", "-map", "[a]", "-t", String(dur), ...V, ...A, "seg4.mp4"]);
slide("final-1920x1080.png", 7, "seg5.mp4");
writeFileSync(join(dir, "segs.txt"), ["seg1", "seg2", "seg3", "seg4", "seg5"].map((s) => `file '${s}.mp4'`).join("\n"));
ff(["-f", "concat", "-safe", "0", "-i", "segs.txt", "-c", "copy", "-movflags", "+faststart", "mouth-alibi-demo.mp4"]);
console.log("Wrote", join(dir, "mouth-alibi-demo.mp4"));
