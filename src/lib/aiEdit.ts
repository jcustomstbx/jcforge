import { invoke } from "@tauri-apps/api/core";
import { join, tempDir } from "@tauri-apps/api/path";
import {
  renderVertical,
  mixSoundEffects,
  compositeVfxOverlays,
  extractThumbnail,
  extractClipAudioForTranscription,
  summarizeFfmpegError,
  DEFAULT_CAPTION_FONT_SIZE,
  DEFAULT_CAPTION_MARGIN_V,
  type VfxOverlayInput,
} from "./ffmpeg";
import {
  linesToAss,
  writeTextFile,
  transcribeClip,
  preventCaptionOverlaps,
  type CaptionLine,
} from "./captions";
import { resolveSfxPath, type SfxEntry } from "./sfxLibrary";
import { resolveMusicPath, type MusicEntry } from "./musicLibrary";
import { resolveVfxPath, type VfxEntry } from "./vfxLibrary";

export interface AiCaptionSuggestion {
  start: number;
  end: number;
  text: string;
  /** "high" = render bigger/bold/highlighted. Should be rare - the one
   * phrase per moment that carries the punchline, not every line. */
  emphasis?: "normal" | "high";
}

export type AiEffectType =
  | "flash"
  | "zoom"
  | "both"
  | "shake"
  | "glitch"
  | "mosaic"
  | "invert";
export type AiIntensity = "low" | "medium" | "high";

export interface AiEffectSuggestion {
  time: number;
  type: AiEffectType;
  intensity?: AiIntensity;
  reason?: string;
}

/** sfxId references an entry from the SFX catalog passed into the prompt -
 * the model picks from what's actually in the library rather than
 * inventing a description, so export can always resolve it to a real
 * file and actually mix it in. null means nothing in the library fit.
 * generatePrompt is only ever read when sfxId is null AND the user has
 * opted into AI generation (their own ElevenLabs key) - a fallback for
 * when the library genuinely doesn't have anything close, never the
 * first choice. */
export interface AiSoundEffectSuggestion {
  time: number;
  sfxId: number | null;
  effect: string;
  why: string;
  intensity?: AiIntensity;
  generatePrompt?: string;
}

export interface SfxCatalogEntry {
  id: number;
  name: string;
  tags: string[];
}

export interface AiMemeSuggestion {
  where: string;
  meme: string;
  durationSeconds?: number;
  why: string;
}

/** musicId references an entry from the music catalog passed into the
 * prompt, same pattern as soundEffects.sfxId - the model picks a real
 * track it can be mixed in automatically, rather than describing a genre
 * with nothing behind it. null means no track in the library fits, or
 * this clip is better with no music (e.g. voice commentary carrying it). */
export interface AiMusicSuggestion {
  musicId: number | null;
  type: string;
  why: string;
  /** Same fallback pattern as soundEffects.generatePrompt - only read when
   * musicId is null and ElevenLabs generation is available. */
  generatePrompt?: string;
}

export interface MusicCatalogEntry {
  id: number;
  name: string;
  tags: string[];
}

/** vfxId references an entry from the VFX catalog passed into the prompt -
 * same closed-set pattern as sfxId/musicId, since the overlay has to exist
 * as a real file to composite. null (or the whole array left empty) means
 * this clip doesn't need one - most clips shouldn't get one at all, this
 * is for the rare transition/reveal moment that actually earns it. */
export interface AiVfxOverlaySuggestion {
  time: number;
  vfxId: number | null;
  why: string;
  /** How long the overlay plays, starting at `time`. Kept short - this is
   * a transition/punctuation moment, not a filter over half the clip. */
  durationSeconds?: number;
  intensity?: AiIntensity;
}

export interface VfxCatalogEntry {
  id: number;
  name: string;
  tags: string[];
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

export interface AiSegment {
  startSeconds: number;
  endSeconds: number;
}

export interface AiClipSuggestion {
  /** With `segments` present, these are just the overall span (first
   * segment's start, last segment's end) for display/thumbnail purposes -
   * the actual source ranges rendered are `segments`. */
  startSeconds: number;
  endSeconds: number;
  reason: string;
  /** How the clip should open and why that's the strongest possible hook. */
  hook?: string;
  /** e.g. "High energy" vs "Clean viral", with the reasoning for this clip. */
  editingStyle?: string;
  /** When present with 2+ entries, the clip is cut from these source
   * ranges concatenated in the order listed (not necessarily chronological
   * - reordering is how a clip leads with its payoff and rewinds for
   * context) instead of one contiguous trim. Absent or a single entry
   * means a normal single-range clip. */
  segments?: AiSegment[];
  captions: AiCaptionSuggestion[];
  effects: AiEffectSuggestion[];
  soundEffects?: AiSoundEffectSuggestion[];
  memes?: AiMemeSuggestion[];
  music?: AiMusicSuggestion | null;
  vfxOverlays?: AiVfxOverlaySuggestion[];
  virality?: AiViralityScores;
  weaknesses?: string[];
}

/** Maps an absolute source-video timestamp to its position in the
 * concatenated output timeline, or null if it falls inside a gap that got
 * cut out (dead air removed, or simply not part of any segment) - such a
 * caption/effect/SFX simply no longer has footage to attach to and should
 * be dropped rather than mapped to some arbitrary nearby point. */
export function sourceTimeToOutputTime(
  segments: AiSegment[],
  sourceTime: number,
): number | null {
  let cumulative = 0;
  for (const seg of segments) {
    if (sourceTime >= seg.startSeconds && sourceTime <= seg.endSeconds) {
      return cumulative + (sourceTime - seg.startSeconds);
    }
    cumulative += seg.endSeconds - seg.startSeconds;
  }
  return null;
}

export const DEFAULT_STYLE_NOTES =
  "Fast-paced, high energy. Favor moments with a clear punchline, big reaction, or a clean win/loss. Keep captions short and punchy, not full transcript dumps.";

// Adapted from a viral-short editing framework the owner uses manually
// (hook-first structure, retention-focused cutting, virality scoring) -
// compressed into a strict JSON contract since the render pipeline (and
// the parser above) needs a fixed shape, not free-form editor notes.
// Shared between the Gemini path (buildPrompt below, sees continuous
// video) and the Claude one-shot path (claudeEdit.ts, sees only the still
// frames + transcript we chose to extract) - each passes its own honest
// description of what it's actually being given, since claiming Gemini's
// "roughly 1fps" sampling caveat applies to Claude (which never saw
// continuous video at all) would be its own kind of inaccuracy.
export function buildPrompt(
  styleNotes: string,
  sfxCatalog: SfxCatalogEntry[],
  musicCatalog: MusicCatalogEntry[],
  vfxCatalog: VfxCatalogEntry[],
  canGenerateAudio: boolean,
  samplingCaveat: string = `Internally you sample video at roughly 1 frame per second by default, so a fast effect, a quick color change, or a brief on-screen number can be genuinely hard to pin down`,
): string {
  const generationNote = canGenerateAudio
    ? ` If truly nothing in this list fits a moment that genuinely needs one, you may instead leave the id null and set "generatePrompt" to a short description of the sound to generate instead (e.g. "sharp glass shatter", "retro 8-bit victory jingle") - use this rarely, only when the library has a real gap, not as a default.`
    : ``;

  const sfxSection =
    sfxCatalog.length > 0
      ? `Available sound effects - pick ONLY from this list by id, never invent an effect that isn't here.${generationNote}
${JSON.stringify(sfxCatalog.map((s) => ({ id: s.id, name: s.name, tags: s.tags })))}
If nothing fits and generation isn't an option, leave soundEffects empty for that moment rather than forcing a mismatched pick.`
      : canGenerateAudio
        ? `No sound effect library is loaded, but on-demand generation is available - set "sfxId" to null and use "generatePrompt" to describe the sound, but only where a sound effect genuinely earns its place.`
        : `No sound effect library is loaded, so leave "soundEffects" as an empty array for every clip.`;

  const musicSection =
    musicCatalog.length > 0
      ? `Available background music - pick ONLY from this list by id, never invent a track that isn't here.${generationNote} It gets mixed in automatically, looped for the clip's length and ducked under voice/game audio - so only pick a track (matching mood/energy to the clip) where continuous background music genuinely helps; set "music" to null for clips that are stronger with just the raw audio, especially ones carrying a lot of commentary or dialogue.
${JSON.stringify(musicCatalog.map((m) => ({ id: m.id, name: m.name, tags: m.tags })))}`
      : canGenerateAudio
        ? `No background music library is loaded, but on-demand generation is available - set "musicId" to null and use "generatePrompt" to describe the track's mood/genre, only where continuous background music genuinely helps.`
        : `No background music library is loaded, so set "music" to null for every clip.`;

  const vfxSection =
    vfxCatalog.length > 0
      ? `Available VFX overlays (light leaks, glitch bursts, film burns, transitions) - pick ONLY from this list by id, never invent one that isn't here. These composite on top of the footage for a short window - use them sparingly (0-2 per clip, most clips should have none) for a hard cut/reorder point, a big reveal, or a glitch-style surprise beat, never as constant decoration.
${JSON.stringify(vfxCatalog.map((v) => ({ id: v.id, name: v.name, tags: v.tags })))}`
      : `No VFX overlay library is loaded, so leave "vfxOverlays" as an empty array for every clip.`;

  return `You are an elite short-form video editor specializing in Twitch/YouTube streamer clips, gaming, comedy, and reaction content. Your job is to find moments in the provided footage worth turning into standalone vertical shorts (TikTok / YouTube Shorts / Instagram Reels) and produce a full edit plan for each one.

Optimize for viewer retention, rewatches, shares, comments, and emotional reaction. Every caption, sound effect, meme, and visual effect you suggest must have a clear purpose - do not suggest effects just to fill space, and do not caption every line with the same emphasis. Preserve the streamer's actual personality and the real context of the moment; never suggest anything misleading about what happens in the clip.

CRITICAL - ground every specific claim in what THIS footage actually shows, not what you already know about the game: if you recognize the game, boss, or activity, you likely also know its "textbook" mechanics from training data - that general knowledge is not a substitute for actually looking at this specific footage, which may not match the textbook version (different attack order, a different visual effect than the canonical one, camera angle, RNG, or a HUD overlay covering part of the screen). ${samplingCaveat} - when that happens, describe only what you can actually confirm (e.g. "a bright effect appears" rather than guessing a specific named mechanic you can't clearly see), and cross-check against the audio track (distinct sound cues, on-screen chat/game messages) rather than visuals alone. A caption or effect description that's specific but wrong is worse than one that's general but accurate - never state a specific detail (a color, a named attack, a mechanic) unless you can actually point to the visual or audio evidence for it in this footage. If the footage has a HUD/plugin overlay with on-screen labels, treat static reference text (a legend, a key, a permanently-displayed tip like "do X when Y happens") as instructions for the player, not as proof that Y is happening at this exact moment - confirm what's actually happening from the boss/effect's own appearance (its actual color, animation) and the live combat/chat log messages scrolling by, which describe real events as they happen, not from a label that's on screen the whole fight regardless of phase. Specifically watch for this failure mode: a mechanic/attack/hazard often has a well-known conventional name (from the game's wiki or community terminology) that you may recall strongly - e.g. calling something "fire" because that is what a mechanic is usually called - even when the actual rendered effect in THIS footage is a clearly different color (blue, cyan, green, purple). When the name you'd reach for and the color you can actually see disagree, describe what you SEE ("a cyan energy spout"), not the conventional name - the viewer is watching this exact footage, and a caption describing a color that isn't there is instantly, visibly wrong to them even if it matches the wiki.

For each moment you pick:
- Identify the strongest possible hook (first 1-2 seconds) - if the natural start is weak, don't just start later: use "segments" to actually cut to the payoff first, then optionally rewind to the setup for context. Also use "segments" to remove real dead air (long pauses, dead time, off-topic tangents) from the middle of a clip - list only the source ranges worth keeping, in the order they should play (not necessarily chronological), and each gets stitched together with a hard cut, no crossfade. A normal single-range clip just omits "segments" (or gives it one entry) - only reach for multiple segments when reordering or cutting dead air genuinely improves the clip, not on every clip by default. EXCEPTION: if the style notes describe this as a tutorial, walkthrough, guide, or how-to, never reorder for a hook - segments (if used at all, e.g. to cut dead air) must stay in strict chronological order, since the instructions being read have to match what's actually happening on screen at that moment; a viewer following a boss-fight or process guide with the footage jumping backward in time mid-video cannot use it to learn anything. This also means completeness matters more than pacing here: if the style notes name specific steps/phases/mechanics to cover, find and include a segment for every one of them that's actually present in the source footage, even a brief one - do not skip an entire named phase just because it looked less visually interesting or to save time, and do not silently cut straight past minutes of footage between two segments without checking whether a required phase/step lives in the part you're cutting out. A tutorial missing a phase it claimed to teach is a failed edit regardless of how clean the cut feels. Before finalizing this clip's "segments", explicitly re-check them against the style notes' list of steps/phases one by one - go through the footage again in your head phase by phase, confirm each one you can actually find in the source has a matching segment, and add any you missed back in before writing your final answer. Do not skip this check just because the edit already feels complete - a self-review after a first pass is exactly how a missed phase gets caught before it ships instead of after.
- Decide which 1-3 words or short phrases across the whole clip actually carry the punchline or reaction, and mark only those caption lines as high emphasis - everything else is normal.
- Recommend effect moments only where they emphasize something already funny, surprising, or dramatic - never as decoration - each with an intensity and a one-line reason. Available effect types: "flash" (white flash - big reveals, punchlines), "zoom" (punch-in - reactions, emphasis), "both" (flash+zoom together - the biggest moments only), "shake" (camera-shake jitter - impacts, chaos, explosions), "glitch" (RGB channel-split - tech/error/surprise beats), "mosaic" (pixelation burst - comedic censor-style reveals), "invert" (colour-invert pulse - shock/surprise stingers). Mix types across a clip rather than reusing one everywhere, and don't stack more than two effects on the same moment.
- ${sfxSection}
- ${musicSection}
- ${vfxSection}
- Recommend meme inserts ONLY where they'd genuinely help - these are read-only suggestions for the editor to add by hand (no meme library exists yet), not something that gets rendered automatically. Use an empty array where memes wouldn't help - do not force a suggestion into every category.
- Score the clip 1-10 on each category below, honestly - most real clips are not 9s and 10s across the board.
- Name the three biggest weaknesses limiting this clip's performance.

Style notes from the editor: ${styleNotes || "(none given - use your own judgment)"}

Respond with ONLY valid JSON - no markdown code fences, no commentary before or after - matching exactly this shape:
{
  "clips": [
    {
      "startSeconds": number,
      "endSeconds": number,
      "segments": [{ "startSeconds": number, "endSeconds": number }] (optional - omit or give one entry for a normal single-range clip; 2+ entries are concatenated in the order listed to reorder for a stronger hook or cut out dead air),
      "hook": string,
      "reason": string (one sentence on why this moment is worth clipping),
      "editingStyle": string (e.g. "High energy: frequent punch-ins and quick cuts" or "Clean viral: minimal effects, let the reaction breathe" - and why this clip suits that),
      "captions": [{ "start": number, "end": number, "text": string, "emphasis": "normal" | "high" }],
      "effects": [{ "time": number, "type": "flash" | "zoom" | "both" | "shake" | "glitch" | "mosaic" | "invert", "intensity": "low" | "medium" | "high", "reason": string }],
      "soundEffects": [{ "time": number, "sfxId": number | null, "effect": string (catalog name, or a short label for a generated one), "why": string, "intensity": "low" | "medium" | "high", "generatePrompt": string (only when sfxId is null and generation is available) }],
      "memes": [{ "where": string, "meme": string, "durationSeconds": number, "why": string }],
      "music": { "musicId": number | null, "type": string (catalog name, or a short label for a generated one), "why": string, "generatePrompt": string (only when musicId is null and generation is available) } | null,
      "vfxOverlays": [{ "time": number, "vfxId": number | null, "why": string, "durationSeconds": number, "intensity": "low" | "medium" | "high" }],
      "virality": {
        "hook": number, "entertainment": number, "pacing": number, "emotionalImpact": number,
        "comedy": number, "rewatchPotential": number, "shareability": number, "commentPotential": number,
        "overall": number
      },
      "weaknesses": [string, string, string]
    }
  ]
}

All times (captions, effects, sound effects, and segment ranges) are in seconds from the start of the whole source video, not the clip - including for a multi-segment clip, where a caption/effect should be timed to whichever segment's source range it actually falls in; anything timed into a gap between segments simply won't appear, so don't place captions/effects inside cut-out dead air. Keep each clip's total playing time (sum of its segments) between 15 and 90 seconds. Only include clips you are genuinely confident about - an empty "clips" array is a fine answer if nothing stands out. Caption text should be short, natural spoken lines, not a full transcript.`;
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

export function stripCodeFences(text: string): string {
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
  sfxCatalog: SfxCatalogEntry[] = [],
  musicCatalog: MusicCatalogEntry[] = [],
  vfxCatalog: VfxCatalogEntry[] = [],
  canGenerateAudio: boolean = false,
): Promise<AiEditRunResult> {
  const prompt = buildPrompt(styleNotes, sfxCatalog, musicCatalog, vfxCatalog, canGenerateAudio);
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

// Gemini's caption timestamps come from the same long-video temporal
// grounding as its clip-range timestamps - confirmed unreliable in the
// same way (see the Zulrah clip mismatch this session). Whisper, run on
// the clip's own actual cut audio, gives sample-accurate timing but no
// editorial judgement (which phrase matters, what's worth emphasizing) -
// so each Gemini caption keeps its own text/emphasis but adopts the
// timing of whichever Whisper line's midpoint is closest, as long as
// that's within a few seconds (a match further off than that is more
// likely a wrong pairing than a real correction, so it falls back to
// Gemini's own mapped timing instead of a confidently wrong one).
const CAPTION_MATCH_TOLERANCE_SECONDS = 4;

async function reconcileCaptionTiming(
  videoPath: string,
  segments: AiSegment[],
  geminiLines: CaptionLine[],
): Promise<CaptionLine[]> {
  let whisperLines: CaptionLine[];
  const dir = await tempDir();
  const audioPath = await join(dir, `jcforge_ai_transcribe_${Date.now()}.wav`);
  try {
    const ok = await extractClipAudioForTranscription(videoPath, segments, audioPath);
    if (!ok) throw new Error("audio extraction failed");
    whisperLines = await transcribeClip(audioPath);
  } catch (err) {
    console.error("[aiEdit] Whisper re-timing failed, keeping Gemini's own caption timing:", err);
    return geminiLines;
  } finally {
    invoke("delete_file", { path: audioPath }).catch(() => {});
  }

  const usedWhisperIds = new Set<number>();
  return geminiLines
    .map((g) => {
      const gMid = (g.start + g.end) / 2;
      let best: CaptionLine | null = null;
      let bestDist = Infinity;
      for (const w of whisperLines) {
        if (usedWhisperIds.has(w.id)) continue;
        const dist = Math.abs((w.start + w.end) / 2 - gMid);
        if (dist < bestDist) {
          bestDist = dist;
          best = w;
        }
      }
      if (best && bestDist <= CAPTION_MATCH_TOLERANCE_SECONDS) {
        usedWhisperIds.add(best.id);
        return { ...g, start: best.start, end: best.end };
      }
      return g;
    })
    .sort((a, b) => a.start - b.start)
    .map((l, i) => ({ ...l, id: i + 1 }));
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
  sfxLibrary: SfxEntry[] = [],
  musicLibrary: MusicEntry[] = [],
  vfxLibrary: VfxEntry[] = [],
  elevenLabsApiKey?: string,
): Promise<AiExportResult> {
  const { path: outputPath } = deriveAiOutputPath(
    videoPath,
    clip.startSeconds,
    clip.endSeconds,
  );

  // A plain single-range clip is just the degenerate one-segment case, so
  // captions/effects/SFX can all go through the same segment-aware time
  // mapping regardless of whether this clip actually has multiple segments.
  const segments: AiSegment[] =
    clip.segments && clip.segments.length > 0
      ? clip.segments
      : [{ startSeconds: clip.startSeconds, endSeconds: clip.endSeconds }];
  const mapTime = (sourceTime: number) => sourceTimeToOutputTime(segments, sourceTime);

  let captionsSrtPath: string | undefined;
  if (clip.captions.length > 0) {
    const geminiLines: CaptionLine[] = [];
    for (const c of clip.captions) {
      const start = mapTime(c.start);
      const end = mapTime(c.end);
      // Falls inside a cut-out gap, or the model timed it across a
      // segment boundary - either way there's no clean footage for it.
      if (start === null || end === null || end <= start) continue;
      geminiLines.push({
        id: geminiLines.length + 1,
        start,
        end,
        text: c.text,
        emphasis: c.emphasis,
      });
    }
    if (geminiLines.length > 0) {
      const reconciled = await reconcileCaptionTiming(videoPath, segments, geminiLines);
      const lines = preventCaptionOverlaps(reconciled);
      const dir = await tempDir();
      captionsSrtPath = await join(dir, `jcforge_ai_render_${Date.now()}.ass`);
      await writeTextFile(captionsSrtPath, linesToAss(lines, DEFAULT_CAPTION_FONT_SIZE));
    }
  }

  const INTENSITY_STRENGTH: Record<AiIntensity, number> = {
    low: 0.6,
    medium: 1,
    high: 1.7,
  };
  const strengthFor = (intensity?: AiIntensity) =>
    intensity ? INTENSITY_STRENGTH[intensity] : 1;

  const impactsFor = (...types: AiEffectType[]) =>
    clip.effects
      .filter((e) => types.includes(e.type))
      .map((e) => {
        const time = mapTime(e.time);
        return time === null ? null : { time, strength: strengthFor(e.intensity) };
      })
      .filter((x): x is { time: number; strength: number } => x !== null);

  const flashSeconds = impactsFor("flash", "both");
  const zoomSeconds = impactsFor("zoom", "both");
  const shakeSeconds = impactsFor("shake");
  const glitchSeconds = impactsFor("glitch");
  const mosaicSeconds = impactsFor("mosaic");
  const invertSeconds = impactsFor("invert");

  const sfxById = new Map(sfxLibrary.map((s) => [s.id, s]));
  const SFX_VOLUME: Record<AiIntensity, number> = { low: 0.35, medium: 0.55, high: 0.8 };
  const librarySfx = (clip.soundEffects ?? []).filter(
    (s) => s.sfxId !== null && sfxById.has(s.sfxId),
  );
  const mappedLibrarySfx = librarySfx
    .map((s) => ({ ...s, outSeconds: mapTime(s.time) }))
    .filter((s): s is typeof s & { outSeconds: number } => s.outSeconds !== null);
  // Fallback only: an SFX suggestion the model explicitly couldn't match to
  // the library, with its own generatePrompt, and only reachable at all
  // when the user opted in with their own ElevenLabs key.
  const generateSfx = elevenLabsApiKey
    ? (clip.soundEffects ?? []).filter((s) => s.sfxId === null && s.generatePrompt)
    : [];
  const mappedGenerateSfx = generateSfx
    .map((s) => ({ ...s, outSeconds: mapTime(s.time) }))
    .filter((s): s is typeof s & { outSeconds: number } => s.outSeconds !== null);

  // No intensity dial on music suggestions (unlike SFX/effects) - a single
  // moderate pre-ducking level, since sidechaincompress is what actually
  // keeps it from competing with voice/game audio.
  const MUSIC_BASE_VOLUME = 0.6;
  const musicById = new Map(musicLibrary.map((m) => [m.id, m]));
  const musicEntry =
    clip.music?.musicId !== null && clip.music?.musicId !== undefined
      ? musicById.get(clip.music.musicId)
      : undefined;
  const generateMusicPrompt =
    !musicEntry && elevenLabsApiKey && clip.music?.musicId === null
      ? clip.music.generatePrompt
      : undefined;

  const VFX_OPACITY: Record<AiIntensity, number> = { low: 0.5, medium: 0.7, high: 0.9 };
  const DEFAULT_VFX_DURATION_SECONDS = 1.2;
  const vfxById = new Map(vfxLibrary.map((v) => [v.id, v]));
  const mappedVfxOverlays = (clip.vfxOverlays ?? [])
    .filter((v) => v.vfxId !== null && vfxById.has(v.vfxId))
    .map((v) => ({ ...v, outSeconds: mapTime(v.time) }))
    .filter((v): v is typeof v & { outSeconds: number } => v.outSeconds !== null);

  const needsVfx = mappedVfxOverlays.length > 0;
  const needsMix =
    mappedLibrarySfx.length > 0 ||
    mappedGenerateSfx.length > 0 ||
    musicEntry !== undefined ||
    !!generateMusicPrompt;
  // Three possible passes chain into outputPath: renderVertical (always) ->
  // compositeVfxOverlays (video-only, if needed) -> mixSoundEffects
  // (audio-only, if needed). Whichever passes are actually needed decide
  // where each stage's intermediate file lands, so a clip needing neither
  // extra pass renders straight to outputPath with no intermediate at all.
  const renderTargetPath =
    needsVfx || needsMix ? outputPath.replace(/\.mp4$/, "_pre.mp4") : outputPath;

  const result = await renderVertical({
    sourcePath: videoPath,
    outputPath: renderTargetPath,
    startSeconds: clip.startSeconds,
    endSeconds: clip.endSeconds,
    segments: segments.length > 1 ? segments : undefined,
    captionsSrtPath,
    flashSeconds: flashSeconds.length > 0 ? flashSeconds : undefined,
    zoomSeconds: zoomSeconds.length > 0 ? zoomSeconds : undefined,
    shakeSeconds: shakeSeconds.length > 0 ? shakeSeconds : undefined,
    glitchSeconds: glitchSeconds.length > 0 ? glitchSeconds : undefined,
    mosaicSeconds: mosaicSeconds.length > 0 ? mosaicSeconds : undefined,
    invertSeconds: invertSeconds.length > 0 ? invertSeconds : undefined,
    captionFontSize: DEFAULT_CAPTION_FONT_SIZE,
    captionMarginV: DEFAULT_CAPTION_MARGIN_V,
  });
  // Only needed for the render call above (ffmpeg's subtitles filter reads
  // it once and burns the captions in) - never cleaned up before, so it
  // accumulated one .ass file per export indefinitely.
  if (captionsSrtPath) {
    await invoke("delete_file", { path: captionsSrtPath }).catch(() => {});
  }

  if (!result.ok) {
    // renderTargetPath is only an intermediate (needs cleanup) when this
    // clip needed a later VFX/mix pass - otherwise it's outputPath itself,
    // which a failed render never actually wrote a usable file to anyway.
    if (renderTargetPath !== outputPath) {
      await invoke("delete_file", { path: renderTargetPath }).catch(() => {});
    }
    return { ok: false, outputPath, error: summarizeFfmpegError(result.log) };
  }

  let mixSourcePath = renderTargetPath;
  if (needsVfx) {
    const vfxInputs: VfxOverlayInput[] = await Promise.all(
      mappedVfxOverlays.map(async (v) => {
        const entry = vfxById.get(v.vfxId as number) as VfxEntry;
        return {
          filePath: await resolveVfxPath(entry),
          atSeconds: v.outSeconds,
          durationSeconds: v.durationSeconds ?? DEFAULT_VFX_DURATION_SECONDS,
          blendMode: entry.blendMode,
          opacity: VFX_OPACITY[v.intensity ?? "medium"],
        };
      }),
    );
    const vfxTargetPath = needsMix ? outputPath.replace(/\.mp4$/, "_base.mp4") : outputPath;
    const vfxResult = await compositeVfxOverlays(renderTargetPath, vfxTargetPath, vfxInputs);
    await invoke("delete_file", { path: renderTargetPath }).catch(() => {});
    if (!vfxResult.ok) {
      if (vfxTargetPath !== outputPath) {
        await invoke("delete_file", { path: vfxTargetPath }).catch(() => {});
      }
      return { ok: false, outputPath, error: summarizeFfmpegError(vfxResult.log) };
    }
    mixSourcePath = vfxTargetPath;
  }

  if (!needsMix) {
    return { ok: true, outputPath };
  }

  const libraryInputs = await Promise.all(
    mappedLibrarySfx.map(async (s) => ({
      filePath: await resolveSfxPath(sfxById.get(s.sfxId as number) as SfxEntry),
      atSeconds: s.outSeconds,
      volume: SFX_VOLUME[s.intensity ?? "medium"],
    })),
  );
  // Generation failures (bad key, network, quota) just drop that one SFX
  // rather than failing the whole export - it was always a fallback for a
  // library gap, not something the render depends on.
  const generatedInputs = (
    await Promise.all(
      mappedGenerateSfx.map(async (s) => {
        try {
          const filePath = await generateSfxFile(s.generatePrompt as string, elevenLabsApiKey as string);
          return { filePath, atSeconds: s.outSeconds, volume: SFX_VOLUME[s.intensity ?? "medium"] };
        } catch (err) {
          console.error("[aiEdit] ElevenLabs SFX generation failed:", err);
          return null;
        }
      }),
    )
  ).filter((s): s is NonNullable<typeof s> => s !== null);
  const sfxInputs = [...libraryInputs, ...generatedInputs];

  let musicInput: { filePath: string; volume: number } | undefined;
  let generatedMusicPath: string | undefined;
  if (musicEntry) {
    musicInput = { filePath: await resolveMusicPath(musicEntry), volume: MUSIC_BASE_VOLUME };
  } else if (generateMusicPrompt) {
    const totalDurationSeconds = segments.reduce(
      (sum, s) => sum + (s.endSeconds - s.startSeconds),
      0,
    );
    try {
      const filePath = await generateMusicFile(
        generateMusicPrompt,
        elevenLabsApiKey as string,
        totalDurationSeconds,
      );
      musicInput = { filePath, volume: MUSIC_BASE_VOLUME };
      generatedMusicPath = filePath;
    } catch (err) {
      console.error("[aiEdit] ElevenLabs music generation failed:", err);
    }
  }

  const mixResult = await mixSoundEffects(mixSourcePath, outputPath, sfxInputs, musicInput);
  await invoke("delete_file", { path: mixSourcePath }).catch(() => {});
  // Generated SFX/music are one-off temp files (unlike library entries,
  // which resolve to a permanent path that must not be touched) - clean
  // them up now that the mix has consumed them, regardless of outcome.
  for (const s of generatedInputs) {
    await invoke("delete_file", { path: s.filePath }).catch(() => {});
  }
  if (generatedMusicPath) {
    await invoke("delete_file", { path: generatedMusicPath }).catch(() => {});
  }
  if (!mixResult.ok) {
    return { ok: false, outputPath, error: summarizeFfmpegError(mixResult.log) };
  }
  return { ok: true, outputPath };
}

/** A raw frame grabbed at a suggested clip's start time, so its content can
 * be eyeballed against the model's own description before spending a full
 * render on it - video-understanding timestamp accuracy degrades on longer
 * source footage, so a suggestion's stated time range doesn't always land
 * on what it describes. */
export async function generateClipThumbnail(
  videoPath: string,
  atSeconds: number,
): Promise<string> {
  const dir = await tempDir();
  const outputPath = await join(
    dir,
    `jcforge_ai_thumb_${Math.round(atSeconds * 1000)}_${Date.now()}.jpg`,
  );
  const ok = await extractThumbnail(videoPath, atSeconds, outputPath);
  if (!ok) throw new Error("Failed to extract thumbnail frame");
  return outputPath;
}

/** Generates a one-shot SFX via the user's own ElevenLabs key and writes it
 * to a temp file - only ever called as a fallback when nothing in the
 * imported library fits (see exportAiClip). Failures are caught by the
 * caller and simply skip that one effect rather than failing the export. */
async function generateSfxFile(prompt: string, apiKey: string): Promise<string> {
  const dir = await tempDir();
  const outputPath = await join(dir, `jcforge_ai_sfx_gen_${Date.now()}.mp3`);
  await invoke("generate_sfx_with_elevenlabs", {
    apiKey,
    prompt,
    outputPath,
  });
  return outputPath;
}

/** Same fallback pattern as generateSfxFile, for background music. */
async function generateMusicFile(
  prompt: string,
  apiKey: string,
  durationSeconds: number,
): Promise<string> {
  const dir = await tempDir();
  const outputPath = await join(dir, `jcforge_ai_music_gen_${Date.now()}.mp3`);
  await invoke("generate_music_with_elevenlabs", {
    apiKey,
    prompt,
    outputPath,
    musicLengthMs: Math.round(durationSeconds * 1000),
  });
  return outputPath;
}
