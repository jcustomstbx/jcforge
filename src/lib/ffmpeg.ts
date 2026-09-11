import { Command } from "@tauri-apps/plugin-shell";
import { buildFlashFilter, buildZoomPunchFilter } from "./effects";

export async function probeDuration(path: string): Promise<number | null> {
  try {
    const output = await Command.sidecar("binaries/ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      path,
    ]).execute();
    const value = parseFloat(output.stdout.trim());
    return Number.isFinite(value) ? value : null;
  } catch (err) {
    console.error("[ffmpeg] probe failed:", err);
    return null;
  }
}

export interface RenderOptions {
  sourcePath: string;
  outputPath: string;
  startSeconds: number;
  endSeconds: number;
  /** Absolute path to an SRT file, already time-shifted to the trim range. */
  captionsSrtPath?: string;
  /** Impact timestamps (seconds, relative to the trim start) to punch a
   * flash + zoom into during render. */
  impactSeconds?: number[];
}

export interface RenderResult {
  ok: boolean;
  log: string;
}

// Static-center 9:16 crop: keep the full source height and take a
// horizontally-centered vertical strip, then scale to a clean 1080x1920.
// "Track subject" from the design mock would need real subject/face
// tracking - out of scope for an honest v1, so this is the only framing
// mode for now.
const CROP_FILTER = "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920";

// ffmpeg's subtitles filter treats ':' and '\' specially in its own arg
// syntax, regardless of the OS - escape a Windows path for use inside it.
function escapeForSubtitlesFilter(path: string): string {
  return path.replace(/\\/g, "/").replace(/:/g, "\\:");
}

const CAPTION_STYLE =
  "FontName=Arial,FontSize=20,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Alignment=2,MarginV=90";

export async function renderVertical(
  opts: RenderOptions,
): Promise<RenderResult> {
  const duration = Math.max(0.1, opts.endSeconds - opts.startSeconds);

  const stages = [CROP_FILTER];
  const zoomFilter = buildZoomPunchFilter(opts.impactSeconds ?? []);
  if (zoomFilter) stages.push(zoomFilter);
  if (opts.captionsSrtPath) {
    stages.push(
      `subtitles='${escapeForSubtitlesFilter(opts.captionsSrtPath)}':force_style='${CAPTION_STYLE}'`,
    );
  }
  const flashFilter = buildFlashFilter(opts.impactSeconds ?? []);
  if (flashFilter) stages.push(flashFilter);
  const videoFilter = stages.join(",");
  const args = [
    "-y",
    "-ss",
    opts.startSeconds.toFixed(3),
    "-i",
    opts.sourcePath,
    "-t",
    duration.toFixed(3),
    "-vf",
    videoFilter,
    "-c:v",
    "h264_nvenc",
    "-preset",
    "p5",
    "-b:v",
    "18M",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    opts.outputPath,
  ];
  try {
    const output = await Command.sidecar("binaries/ffmpeg", args).execute();
    return { ok: output.code === 0, log: output.stderr };
  } catch (err) {
    return { ok: false, log: err instanceof Error ? err.message : String(err) };
  }
}
