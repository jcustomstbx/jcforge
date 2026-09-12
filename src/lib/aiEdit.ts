import { invoke } from "@tauri-apps/api/core";
import { join, tempDir } from "@tauri-apps/api/path";
import {
  renderVertical,
  summarizeFfmpegError,
  DEFAULT_CAPTION_FONT_SIZE,
  DEFAULT_CAPTION_MARGIN_V,
} from "./ffmpeg";
import {
  adjustCaptionsForTrim,
  linesToAss,
  writeTextFile,
  type CaptionLine,
} from "./captions";

export interface AiCaptionSuggestion {
  start: number;
  end: number;
  text: string;
  /** "high" = render bigger/bold/highlighted. Should be rare - the one
   * phrase per moment that carries the punchline, not every line. */
  emphasis?: "normal" | "high";
}

export type AiEffectType = "flash" | "zoom" | "both";
export type AiIntensity = "low" | "medium" | "high";

export interface AiEffectSuggestion {
  time: number;
  type: AiEffectType;
  intensity?: AiIntensity;
  reason?: string;
}

/** Recommendation-only - JCForge has no SFX/meme/music asset library or
 * audio-mixing pipeline yet, so these are surfaced as a checklist for the
 * editor to add by hand rather than silently applied on export. */
export interface AiSoundEffectSuggestion {
  time: number;
  effect: string;
  why: string;
  intensity?: AiIntensity;
}

export interface AiMemeSuggestion {
  where: string;
  meme: string;
  durationSeconds?: number;
  why: string;
}

export interface AiMusicSuggestion {
  type: string;
  why: string;
}

export interface AiViralityScores {
  hook: number;
  entertainment: number;
  pacing: number;
  emotionalImpact: number;
  comedy: number;
  rewatchPotential: number;
  shareability: number;
  commentPotential: number;
  overall: number;
}

export interface AiClipSuggestion {
  startSeconds: number;
  endSeconds: number;
  reason: string;
  /** How the clip should open and why that's the strongest possible hook. */
  hook?: string;
  /** e.g. "High energy" vs "Clean viral", with the reasoning for this clip. */
  editingStyle?: string;
  captions: AiCaptionSuggestion[];
  effects: AiEffectSuggestion[];
  soundEffects?: AiSoundEffectSuggestion[];
  memes?: AiMemeSuggestion[];
  music?: AiMusicSuggestion | null;
  virality?: AiViralityScores;
  weaknesses?: string[];
}

export const DEFAULT_STYLE_NOTES =
  "Fast-paced, high energy. Favor moments with a clear punchline, big reaction, or a clean win/loss. Keep captions short and punchy, not full transcript dumps.";

// Adapted from a viral-short editing framework the owner uses manually
// (hook-first structure, retention-focused cutting, virality scoring) -
// compressed into a strict JSON contract since the render pipeline (and
// the parser above) needs a fixed shape, not free-form editor notes.
function buildPrompt(styleNotes: string): string {
  return `You are an elite short-form video editor specializing in Twitch/YouTube streamer clips, gaming, comedy, and reaction content. Your job is to find moments in the provided footage worth turning into standalone vertical shorts (TikTok / YouTube Shorts / Instagram Reels) and produce a full edit plan for each one.

Optimize for viewer retention, rewatches, shares, comments, and emotional reaction. Every caption, sound effect, meme, and visual effect you suggest must have a clear purpose - do not suggest effects just to fill space, and do not caption every line with the same emphasis. Preserve the streamer's actual personality and the real context of the moment; never suggest anything misleading about what happens in the clip.

For each moment you pick:
- Identify the strongest possible hook (first 1-2 seconds) - if the natural start is weak, recommend starting closer to the payoff instead.
- Decide which 1-3 words or short phrases across the whole clip actually carry the punchline or reaction, and mark only those caption lines as high emphasis - everything else is normal.
- Recommend flash/zoom moments only where they emphasize something already funny, surprising, or dramatic, each with an intensity and a one-line reason.
- Recommend sound effects, meme inserts, and background music ONLY where they'd genuinely help - these are read-only suggestions for the editor to add by hand (no SFX/meme/music library exists yet), not something that gets rendered automatically. Use empty arrays / null where none of these would help - do not force a suggestion into every category.
- Score the clip 1-10 on each category below, honestly - most real clips are not 9s and 10s across the board.
- Name the three biggest weaknesses limiting this clip's performance.

Style notes from the editor: ${styleNotes || "(none given - use your own judgment)"}

Respond with ONLY valid JSON - no markdown code fences, no commentary before or after - matching exactly this shape:
{
  "clips": [
    {
      "startSeconds": number,
      "endSeconds": number,
      "hook": string,
      "reason": string (one sentence on why this moment is worth clipping),
      "editingStyle": string (e.g. "High energy: frequent punch-ins and quick cuts" or "Clean viral: minimal effects, let the reaction breathe" - and why this clip suits that),
      "captions": [{ "start": number, "end": number, "text": string, "emphasis": "normal" | "high" }],
      "effects": [{ "time": number, "type": "flash" | "zoom" | "both", "intensity": "low" | "medium" | "high", "reason": string }],
      "soundEffects": [{ "time": number, "effect": string, "why": string, "intensity": "low" | "medium" | "high" }],
      "memes": [{ "where": string, "meme": string, "durationSeconds": number, "why": string }],
      "music": { "type": string, "why": string } | null,
      "virality": {
        "hook": number, "entertainment": number, "pacing": number, "emotionalImpact": number,
        "comedy": number, "rewatchPotential": number, "shareability": number, "commentPotential": number,
        "overall": number
      },
      "weaknesses": [string, string, string]
    }
  ]
}

All times are in seconds from the start of the video, not the clip. Keep each clip between 15 and 90 seconds long. Only include clips you are genuinely confident about - an empty "clips" array is a fine answer if nothing stands out. Caption text should be short, natural spoken lines, not a full transcript.`;
}

/** Confirmed live against a real Interactions API response (2026-09-12):
 * the envelope has a top-level "steps" array mixing "thought" steps (no
 * usable text - just an opaque "signature") with a "model_output" step
 * shaped like { type: "model_output", content: [{ type: "text", text }] }.
 * Walk backwards past any thought steps to find the last model_output. */
function extractModelText(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.output_text === "string") return obj.output_text;

  if (Array.isArray(obj.steps)) {
    for (let i = obj.steps.length - 1; i >= 0; i--) {
      const step = obj.steps[i];
      if (!step || typeof step !== "object") continue;
      const stepObj = step as Record<string, unknown>;
      if (stepObj.type === "thought") continue;

      if (typeof stepObj.output_text === "string") return stepObj.output_text;
      if (typeof stepObj.text === "string") return stepObj.text;
      if (Array.isArray(stepObj.content)) {
        const textPart = stepObj.content.find(
          (p) =>
            p &&
            typeof p === "object" &&
            typeof (p as Record<string, unknown>).text === "string",
        ) as Record<string, unknown> | undefined;
        if (textPart) return textPart.text as string;
      }
    }
  }

  // Legacy generateContent shape, in case the account/model still routes
  // through it.
  if (Array.isArray(obj.candidates) && obj.candidates.length > 0) {
    const candidate = obj.candidates[0] as Record<string, unknown>;
    const content = candidate?.content as Record<string, unknown> | undefined;
    const parts = content?.parts as Array<Record<string, unknown>> | undefined;
    const text = parts?.find((p) => typeof p.text === "string")?.text;
    if (typeof text === "string") return text;
  }

  if (Array.isArray(obj.output) && obj.output.length > 0) {
    const first = obj.output[0];
    if (first && typeof first === "object" && typeof (first as Record<string, unknown>).text === "string") {
      return (first as Record<string, unknown>).text as string;
    }
  }

  return null;
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : trimmed;
}

export interface AiEditRunResult {
  clips: AiClipSuggestion[];
  /** The raw HTTP response body, always returned so a parsing failure or
   * an unexpected shape can still be inspected instead of just erroring. */
  rawResponse: string;
}

/** Thrown when the response comes back but doesn't parse as expected -
 * carries the raw body along so the caller can still show it for
 * debugging instead of just an error message. */
export class AiEditParseError extends Error {
  rawResponse: string;
  constructor(message: string, rawResponse: string) {
    super(message);
    this.name = "AiEditParseError";
    this.rawResponse = rawResponse;
  }
}

export async function runAiEdit(
  videoPath: string,
  apiKey: string,
  styleNotes: string,
): Promise<AiEditRunResult> {
  const prompt = buildPrompt(styleNotes);
  const rawResponse = await invoke<string>("analyze_video_with_gemini", {
    videoPath,
    apiKey,
    prompt,
  });

  let envelope: unknown;
  try {
    envelope = JSON.parse(rawResponse);
  } catch {
    throw new AiEditParseError(
      "Gemini's response wasn't valid JSON at all - see the raw response below.",
      rawResponse,
    );
  }

  const modelText = extractModelText(envelope);
  if (modelText === null) {
    throw new AiEditParseError(
      "Couldn't find the model's generated text in Gemini's response - the response shape may have changed. See the raw response below.",
      rawResponse,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(modelText));
  } catch {
    throw new AiEditParseError(
      "The model's response wasn't valid JSON as instructed - see the raw response below.",
      rawResponse,
    );
  }

  const clips = (parsed as { clips?: unknown })?.clips;
  if (!Array.isArray(clips)) {
    throw new AiEditParseError(
      "The model's JSON didn't have a 'clips' array as instructed - see the raw response below.",
      rawResponse,
    );
  }

  return { clips: clips as AiClipSuggestion[], rawResponse };
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function stamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${pad2(m)}m${pad2(s)}s`;
}

/** Mirrors ClipEditor's deriveOutputPath convention - the render lands next
 * to the source video rather than in the clip library, since this is
 * cutting an arbitrary VOD, not finishing an already-captured clip. */
function deriveAiOutputPath(
  sourcePath: string,
  startSeconds: number,
  endSeconds: number,
): { dir: string; path: string } {
  const lastSep = Math.max(
    sourcePath.lastIndexOf("/"),
    sourcePath.lastIndexOf("\\"),
  );
  const dir = sourcePath.slice(0, lastSep);
  const base = sourcePath.slice(lastSep + 1);
  const dot = base.lastIndexOf(".");
  const stem = dot === -1 ? base : base.slice(0, dot);
  const sep = sourcePath.includes("\\") ? "\\" : "/";
  const path = `${dir}${sep}${stem}_ai_${stamp(startSeconds)}-${stamp(endSeconds)}.mp4`;
  return { dir, path };
}

export interface AiExportResult {
  ok: boolean;
  outputPath: string;
  error?: string;
}

/** Renders one AI-suggested clip straight out of the source VOD using the
 * same crop/caption/effect pipeline as the manual clip editor - burns in
 * the model's suggested captions and flash/zoom points and writes a
 * finished vertical .mp4 next to the source file. This does not touch the
 * clip library; it's a standalone export, the same way the editor's own
 * "Render" button produces a file without adding a library row. */
export async function exportAiClip(
  videoPath: string,
  clip: AiClipSuggestion,
): Promise<AiExportResult> {
  const { path: outputPath } = deriveAiOutputPath(
    videoPath,
    clip.startSeconds,
    clip.endSeconds,
  );

  let captionsSrtPath: string | undefined;
  if (clip.captions.length > 0) {
    const lines: CaptionLine[] = clip.captions.map((c, i) => ({
      id: i + 1,
      start: c.start,
      end: c.end,
      text: c.text,
      emphasis: c.emphasis,
    }));
    const adjusted = adjustCaptionsForTrim(
      lines,
      clip.startSeconds,
      clip.endSeconds,
    );
    if (adjusted.length > 0) {
      const dir = await tempDir();
      captionsSrtPath = await join(dir, `jcforge_ai_render_${Date.now()}.ass`);
      await writeTextFile(
        captionsSrtPath,
        linesToAss(adjusted, DEFAULT_CAPTION_FONT_SIZE),
      );
    }
  }

  const flashSeconds = clip.effects
    .filter((e) => e.type === "flash" || e.type === "both")
    .map((e) => e.time - clip.startSeconds);
  const zoomSeconds = clip.effects
    .filter((e) => e.type === "zoom" || e.type === "both")
    .map((e) => e.time - clip.startSeconds);

  const result = await renderVertical({
    sourcePath: videoPath,
    outputPath,
    startSeconds: clip.startSeconds,
    endSeconds: clip.endSeconds,
    captionsSrtPath,
    flashSeconds: flashSeconds.length > 0 ? flashSeconds : undefined,
    zoomSeconds: zoomSeconds.length > 0 ? zoomSeconds : undefined,
    captionFontSize: DEFAULT_CAPTION_FONT_SIZE,
    captionMarginV: DEFAULT_CAPTION_MARGIN_V,
  });

  if (!result.ok) {
    return { ok: false, outputPath, error: summarizeFfmpegError(result.log) };
  }
  return { ok: true, outputPath };
}
