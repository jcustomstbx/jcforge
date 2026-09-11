import { invoke } from "@tauri-apps/api/core";
import { join, resolveResource, tempDir } from "@tauri-apps/api/path";
import { Command } from "@tauri-apps/plugin-shell";

export interface CaptionLine {
  id: number;
  start: number;
  end: number;
  text: string;
}

function parseSrtTime(t: string): number {
  const [h, m, sRest] = t.trim().split(":");
  const [s, ms] = sRest.split(",");
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

function formatSrtTime(t: number): string {
  const clamped = Math.max(0, t);
  const ms = Math.round((clamped % 1) * 1000);
  const total = Math.floor(clamped);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number, len = 2) => n.toString().padStart(len, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

export function parseSrt(content: string): CaptionLine[] {
  const blocks = content.split(/\r?\n\r?\n/).filter((b) => b.trim());
  const lines: CaptionLine[] = [];
  for (const block of blocks) {
    const rows = block.split(/\r?\n/).filter((r) => r.length > 0);
    const timeLine = rows.find((r) => r.includes("-->"));
    if (!timeLine) continue;
    const [startStr, endStr] = timeLine.split("-->").map((s) => s.trim());
    const text = rows.slice(rows.indexOf(timeLine) + 1).join(" ").trim();
    if (!text) continue;
    lines.push({
      id: lines.length + 1,
      start: parseSrtTime(startStr),
      end: parseSrtTime(endStr.split(" ")[0]),
      text,
    });
  }
  return lines;
}

export function linesToSrt(lines: CaptionLine[]): string {
  return lines
    .map(
      (l, i) =>
        `${i + 1}\n${formatSrtTime(l.start)} --> ${formatSrtTime(l.end)}\n${l.text}\n`,
    )
    .join("\n");
}

/** Shift captions so `rangeStart` becomes 0, keep only lines overlapping
 * [rangeStart, rangeEnd], and clip them to that window - used to line
 * captions up with a trimmed render. */
export function adjustCaptionsForTrim(
  lines: CaptionLine[],
  rangeStart: number,
  rangeEnd: number,
): CaptionLine[] {
  return lines
    .filter((l) => l.end > rangeStart && l.start < rangeEnd)
    .map((l) => ({
      ...l,
      start: Math.max(0, l.start - rangeStart),
      end: Math.min(rangeEnd, l.end) - rangeStart,
    }));
}

async function readTextFile(path: string): Promise<string> {
  return invoke<string>("read_text_file", { path });
}

export async function writeTextFile(
  path: string,
  contents: string,
): Promise<void> {
  await invoke("write_text_file", { path, contents });
}

export async function transcribeClip(
  sourcePath: string,
): Promise<CaptionLine[]> {
  const scratch = await tempDir();
  const stamp = Date.now();
  const wavPath = await join(scratch, `jcforge_${stamp}.wav`);
  const srtBase = await join(scratch, `jcforge_${stamp}`);

  const extract = await Command.sidecar("binaries/ffmpeg", [
    "-y",
    "-i",
    sourcePath,
    "-vn",
    "-ar",
    "16000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    wavPath,
  ]).execute();
  if (extract.code !== 0) {
    throw new Error(
      `Failed to extract audio: ${extract.stderr.slice(-300)}`,
    );
  }

  const modelPath = await resolveResource("models/ggml-base.en.bin");
  const whisper = await Command.sidecar("binaries/whisper-cli", [
    "-m",
    modelPath,
    "-f",
    wavPath,
    "-osrt",
    "-of",
    srtBase,
    "-l",
    "en",
    "-np",
  ]).execute();
  if (whisper.code !== 0) {
    throw new Error(`Transcription failed: ${whisper.stderr.slice(-300)}`);
  }

  const srtContent = await readTextFile(`${srtBase}.srt`);
  return parseSrt(srtContent);
}
