// A one-shot (non-agentic) alternative to runAiEdit's Gemini call. Claude
// has no native video ingestion (Anthropic's vision API only accepts
// images/PDFs, not video files) - unlike Gemini, which watches the actual
// video - so this extracts a fixed set of still frames plus a full Whisper
// transcript and sends those in a single Messages API call instead.
//
// Deliberately NOT the agentic tool-use loop this app built and then
// removed earlier (real WebView/native-process crashes, real cost from
// runaway multi-turn calls) - this is one bounded request with a fixed
// frame count, same risk/cost shape as the existing Gemini call, not a
// loop. Whether still frames end up more or less accurate than Gemini's
// continuous video understanding is genuinely untested - this exists to
// let that be compared directly, not because it's known to be better.
import { invoke } from "@tauri-apps/api/core";
import { join, tempDir } from "@tauri-apps/api/path";
import { extractThumbnail, probeDuration } from "./ffmpeg";
import { transcribeClip } from "./captions";
import {
  buildPrompt,
  stripCodeFences,
  AiEditParseError,
  type AiEditRunResult,
  type AiClipSuggestion,
  type SfxCatalogEntry,
  type MusicCatalogEntry,
  type VfxCatalogEntry,
} from "./aiEdit";

const CLAUDE_MODEL = "claude-opus-5";
// Headroom for a clip list with several suggestions, each carrying a full
// caption/effect/SFX/VFX breakdown - 8192 was tight enough to risk
// truncating a longer response before this was raised.
const MAX_TOKENS = 12000;
// One frame every ~4s keeps a multi-minute VOD's frame count (and cost)
// reasonable while still catching most distinct moments - bounded at 40
// so an hours-long VOD doesn't balloon into hundreds of images in one
// request (Gemini's own video call has no such cap, but it's not paying
// per-frame the way Claude's vision tokens do). Confirmed live this
// session that a real analysis run at the previous 6s interval still came
// back noticeably more accurate than Gemini and cost little - denser
// sampling only helps pin down quick transitions further for not much
// more.
const FRAME_INTERVAL_SECONDS = 4;
const MAX_FRAMES = 40;

interface ContentBlock {
  type: string;
  text?: string;
  source?: { type: "base64"; media_type: string; data: string };
  [key: string]: unknown;
}

async function extractFrameTimestamps(durationSeconds: number): Promise<number[]> {
  const count = Math.min(
    MAX_FRAMES,
    Math.max(1, Math.floor(durationSeconds / FRAME_INTERVAL_SECONDS)),
  );
  const step = durationSeconds / count;
  const timestamps: number[] = [];
  for (let i = 0; i < count; i++) {
    timestamps.push(Math.min(durationSeconds - 0.1, i * step));
  }
  return timestamps;
}

export async function runClaudeOneShotEdit(
  videoPath: string,
  apiKey: string,
  styleNotes: string,
  sfxCatalog: SfxCatalogEntry[] = [],
  musicCatalog: MusicCatalogEntry[] = [],
  vfxCatalog: VfxCatalogEntry[] = [],
  canGenerateAudio: boolean = false,
  onProgress?: (message: string) => void,
): Promise<AiEditRunResult> {
  const durationSeconds = await probeDuration(videoPath);
  if (!durationSeconds) {
    throw new Error("Couldn't read the source video's duration.");
  }

  onProgress?.("Transcribing audio…");
  const transcript = await transcribeClip(videoPath);
  const transcriptText =
    transcript.length > 0
      ? transcript.map((l) => `[${l.start.toFixed(1)}s-${l.end.toFixed(1)}s] ${l.text}`).join("\n")
      : "(no speech detected)";

  const timestamps = await extractFrameTimestamps(durationSeconds);
  onProgress?.(`Extracting ${timestamps.length} frames…`);
  const dir = await tempDir();
  const framePaths: string[] = [];
  const imageBlocks: ContentBlock[] = [];
  try {
    for (const t of timestamps) {
      const framePath = await join(
        dir,
        `jcforge_claude_frame_${Math.round(t * 1000)}_${Date.now()}.jpg`,
      );
      // Wider than the UI's own thumbnail previews (480px) - small on-screen
      // text and subtle color differences (the exact failure mode Gemini
      // kept missing) read more reliably at this size, still comfortably
      // within a single vision "tile" so it doesn't multiply token cost.
      const ok = await extractThumbnail(videoPath, t, framePath, 768);
      if (!ok) continue;
      framePaths.push(framePath);
      const base64 = await invoke<string>("read_frame_as_base64", { path: framePath });
      imageBlocks.push({ type: "text", text: `Frame at ${t.toFixed(1)}s:` });
      imageBlocks.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: base64 },
      });
    }

    const samplingCaveat = `You were given ${timestamps.length} still frames sampled roughly every ${FRAME_INTERVAL_SECONDS} seconds (not the continuous video), each labeled with its timestamp - anything that happened between two frames, or any fast motion within a single frame, is invisible to you`;
    const system = buildPrompt(styleNotes, sfxCatalog, musicCatalog, vfxCatalog, canGenerateAudio, samplingCaveat);

    onProgress?.("Asking Claude to plan the edit…");
    const body = {
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [
        {
          role: "user",
          content: [
            ...imageBlocks,
            {
              type: "text",
              text: `Full audio transcript with timestamps:\n${transcriptText}\n\nUsing the frames above and this transcript, produce the edit plan as instructed.`,
            },
          ],
        },
      ],
    };

    const raw = await invoke<string>("call_claude_messages", { apiKey, body });
    const parsed = JSON.parse(raw);
    const content: ContentBlock[] = parsed.content ?? [];
    const finalText = content.find((b) => b.type === "text" && b.text?.trim())?.text;
    if (!finalText) {
      throw new AiEditParseError(
        "Claude's response had no text content.",
        JSON.stringify(parsed, null, 2),
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(stripCodeFences(finalText));
    } catch {
      throw new AiEditParseError("Claude's response wasn't valid JSON - see below.", finalText);
    }

    const clips = (parsedJson as { clips?: unknown })?.clips;
    if (!Array.isArray(clips)) {
      throw new AiEditParseError(
        "Claude's JSON didn't have a 'clips' array - see below.",
        finalText,
      );
    }

    return { clips: clips as AiClipSuggestion[], rawResponse: finalText };
  } finally {
    for (const p of framePaths) {
      await invoke("delete_file", { path: p }).catch(() => {});
    }
  }
}
