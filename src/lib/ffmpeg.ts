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
  /** Absolute path to an SRT or ASS subtitle file, already time-shifted to
   * the trim range. ASS is needed for per-line styling (e.g. AI-suggested
   * emphasis) that a plain SRT + uniform force_style can't express. */
  captionsSrtPath?: string;
  /** Timestamps (seconds, relative to the trim start) to flash to white
   * at. Independent of zoomSeconds so each effect type can be placed on
   * its own. */
  flashSeconds?: number[];
  /** Timestamps (seconds, relative to the trim start) to punch a zoom-in
   * at. Independent of flashSeconds. */
  zoomSeconds?: number[];
  /** Total duration (seconds) each flash fades in and back out over. */
  flashDurationSec?: number;
  /** Total duration (seconds) each zoom punch eases in and back out over. */
  zoomDurationSec?: number;
  /** Horizontal crop position, -1 (left edge) to 1 (right edge), 0 =
   * centered. Fixed for the whole render - see buildCropFilter. */
  framingPan?: number;
  /** Caption font size, in pixels of the final 1080x1920 output. */
  captionFontSize?: number;
  /** Caption baseline distance from the bottom edge, in pixels of the
   * final 1080x1920 output - ASS's MarginV. Higher = higher up the frame. */
  captionMarginV?: number;
}

export interface RenderResult {
  ok: boolean;
  log: string;
}

/** ffmpeg's stderr always ends with a generic "Conversion failed!" trailer -
 * the actual root-cause line (e.g. a filter expression error) usually
 * appears well before that, so slicing the tail of the log hides exactly
 * the part that matters. Pull out lines that look like the real error
 * instead of just the last N characters. */
export function summarizeFfmpegError(log: string): string {
  const lines = log.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const errorLines = lines.filter(
    (l) => /error/i.test(l) && !/^conversion failed/i.test(l.trim()),
  );
  const excerpt =
    errorLines.length > 0 ? errorLines.join("\n") : lines.slice(-5).join("\n");
  return excerpt.slice(0, 500);
}

// 9:16 crop: keep the full source height and take a vertical strip,
// horizontally positioned by `pan`. "Track subject" from the design mock
// would need real subject/face tracking - out of scope for an honest v1 -
// so this is a manually-positioned static crop rather than a tracked one.
// pan is a single fixed value for the whole render (not time-varying), so
// there's no need for crop's eval=frame mode here.
function buildCropFilter(pan: number): string {
  const clamped = Math.max(-1, Math.min(1, pan));
  // (iw-ih*9/16)/2 is the centered x position; scaling that by (1+pan)
  // slides it from the left edge (pan=-1) through center (pan=0) to the
  // right edge (pan=1).
  return `crop=ih*9/16:ih:(iw-ih*9/16)/2*(1+(${clamped})):0,scale=1080:1920`;
}

// ffmpeg's subtitles filter treats ':' and '\' specially in its own arg
// syntax, regardless of the OS - escape a Windows path for use inside it.
function escapeForSubtitlesFilter(path: string): string {
  return path.replace(/\\/g, "/").replace(/:/g, "\\:");
}

export const DEFAULT_CAPTION_FONT_SIZE = 20;
export const DEFAULT_CAPTION_MARGIN_V = 90;

// A plain .srt carries no resolution info, so libass falls back to its own
// default reference resolution (384x288) for interpreting FontSize/MarginV,
// then scales that up to the real frame size - meaning those values are
// NOT literal output pixels unless PlayResX/PlayResY are pinned explicitly.
// Without this, a MarginV past ~250-300 gets scaled by ~6.7x (1920/288)
// and pushed the caption entirely off the top of the frame - confirmed by
// rendering the same clip with and without these two options.
function buildCaptionStyle(fontSize: number, marginV: number): string {
  return `PlayResX=1080,PlayResY=1920,FontName=Arial,FontSize=${fontSize},Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Alignment=2,MarginV=${marginV}`;
}

export async function renderVertical(
  opts: RenderOptions,
): Promise<RenderResult> {
  const duration = Math.max(0.1, opts.endSeconds - opts.startSeconds);

  const stages = [buildCropFilter(opts.framingPan ?? 0)];
  const zoomFilter = buildZoomPunchFilter(opts.zoomSeconds ?? [], opts.zoomDurationSec);
  if (zoomFilter) stages.push(zoomFilter);
  if (opts.captionsSrtPath) {
    const style = buildCaptionStyle(
      opts.captionFontSize ?? DEFAULT_CAPTION_FONT_SIZE,
      opts.captionMarginV ?? DEFAULT_CAPTION_MARGIN_V,
    );
    stages.push(
      `subtitles='${escapeForSubtitlesFilter(opts.captionsSrtPath)}':force_style='${style}'`,
    );
  }
  const flashFilter = buildFlashFilter(opts.flashSeconds ?? [], opts.flashDurationSec);
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
