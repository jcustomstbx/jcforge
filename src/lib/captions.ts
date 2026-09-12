import { invoke } from "@tauri-apps/api/core";
import { join, resolveResource, tempDir } from "@tauri-apps/api/path";
import { Command } from "@tauri-apps/plugin-shell";

export interface CaptionLine {
  id: number;
  start: number;
  end: number;
  text: string;
  /** "high" renders this line larger, bold, and colour-highlighted rather
   * than identically to every other line - lets an AI suggestion (or a
   * future manual toggle) call out the one phrase per moment that matters,
   * per the "don't caption every word with the same emphasis" principle. */
  emphasis?: "normal" | "high";
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

// Whisper emits bracketed/parenthetical tags for non-speech audio events
// ("[music]", "[no noise]", "[BLANK_AUDIO]", "(coughing)") rather than
// actual words - a caption line that's entirely one of these isn't
// something a viewer should read as dialogue.
const NON_SPEECH_TAG = /^[\[(][^\])]*[\])]$/;

function isNonSpeechTag(text: string): boolean {
  return NON_SPEECH_TAG.test(text.trim());
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
    if (!text || isNonSpeechTag(text)) continue;
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

function formatAssTime(t: number): string {
  const clamped = Math.max(0, t);
  const centis = Math.round((clamped % 1) * 100);
  const total = Math.floor(clamped);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${h}:${pad(m)}:${pad(s)}.${pad(centis)}`;
}

// ASS dialogue text uses "\N" for a line break and treats a literal
// backslash/brace as the start of an override tag - escape both so caption
// text can't accidentally inject one.
function escapeAssText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}

/** A self-contained .ass file (its own [V4+ Styles] Default entry, though
 * ffmpeg's `force_style` is expected to overwrite most of it at render
 * time - see buildCaptionStyle in ffmpeg.ts) with inline per-line override
 * codes for "high" emphasis lines. Plain SRT has no way to size/colour
 * individual lines differently since force_style applies one style to the
 * whole file - ASS's inline `{\...}` tags are the only way to do that. */
export function linesToAss(lines: CaptionLine[], baseFontSize: number): string {
  const emphasisFontSize = Math.round(baseFontSize * 1.6);
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,Arial,${baseFontSize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,2,0,2,10,10,90,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const events = lines
    .map((l) => {
      const override =
        l.emphasis === "high"
          ? `{\\b1\\fs${emphasisFontSize}\\c&H00FFFF&}`
          : "";
      const text = override + escapeAssText(l.text).replace(/\r?\n/g, "\\N");
      return `Dialogue: 0,${formatAssTime(l.start)},${formatAssTime(l.end)},Default,,0,0,0,,${text}`;
    })
    .join("\n");

  return `${header}\n${events}\n`;
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
    "-sns",
  ]).execute();
  if (whisper.code !== 0) {
    throw new Error(`Transcription failed: ${whisper.stderr.slice(-300)}`);
  }

  const srtContent = await readTextFile(`${srtBase}.srt`);
  return parseSrt(srtContent);
}
