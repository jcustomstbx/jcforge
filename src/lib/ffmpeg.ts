import { Command } from "@tauri-apps/plugin-shell";

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

export async function renderVertical(
  opts: RenderOptions,
): Promise<RenderResult> {
  const duration = Math.max(0.1, opts.endSeconds - opts.startSeconds);
  const args = [
    "-y",
    "-ss",
    opts.startSeconds.toFixed(3),
    "-i",
    opts.sourcePath,
    "-t",
    duration.toFixed(3),
    "-vf",
    CROP_FILTER,
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
