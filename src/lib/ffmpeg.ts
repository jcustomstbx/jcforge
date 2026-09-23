import { Command } from "@tauri-apps/plugin-shell";
import {
  buildFlashFilter,
  buildZoomPunchFilter,
  buildShakeFilter,
  buildGlitchFilter,
  buildMosaicFilter,
  buildInvertFilter,
  type ImpactInput,
} from "./effects";

/** Extracts just the audio covering the given source ranges (concatenated
 * in order for a multi-segment clip, matching renderVertical's own segment
 * handling) into a 16kHz mono WAV, timestamps starting at 0 - i.e. audio
 * on the same timeline the final render's captions need to land on. Used
 * to get real Whisper transcription timing for an AI-suggested clip
 * instead of trusting Gemini's own guessed caption timestamps, which -
 * like its clip-range timestamps - lose precision on longer source
 * videos. */
export async function extractClipAudioForTranscription(
  sourcePath: string,
  segments: { startSeconds: number; endSeconds: number }[],
  outputPath: string,
): Promise<boolean> {
  try {
    let args: string[];
    if (segments.length > 1) {
      const parts = segments.map(
        (seg, i) =>
          `[0:a]atrim=start=${seg.startSeconds.toFixed(3)}:end=${seg.endSeconds.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`,
      );
      const concat = `${segments.map((_, i) => `[a${i}]`).join("")}concat=n=${segments.length}:v=0:a=1[aout]`;
      args = [
        "-y",
        "-i",
        sourcePath,
        "-filter_complex",
        [...parts, concat].join(";"),
        "-map",
        "[aout]",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        outputPath,
      ];
    } else {
      const seg = segments[0];
      const duration = Math.max(0.1, seg.endSeconds - seg.startSeconds);
      args = [
        "-y",
        "-ss",
        seg.startSeconds.toFixed(3),
        "-i",
        sourcePath,
        "-t",
        duration.toFixed(3),
        "-vn",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        outputPath,
      ];
    }
    const output = await Command.sidecar("binaries/ffmpeg", args).execute();
    return output.code === 0;
  } catch (err) {
    console.error("[ffmpeg] clip audio extraction for transcription failed:", err);
    return false;
  }
}

/** Grabs a single raw (uncropped) frame at a timestamp - used to let a
 * suggested clip be eyeballed against its own description before spending
 * a full render on it. Deliberately not run through the crop/effects
 * chain: the point is to check whether the source footage really matches
 * what was described at that timestamp, which is easier to judge with
 * more context, not less. */
export async function extractThumbnail(
  sourcePath: string,
  atSeconds: number,
  outputPath: string,
  widthPx: number = 480,
): Promise<boolean> {
  try {
    const output = await Command.sidecar("binaries/ffmpeg", [
      "-y",
      "-ss",
      Math.max(0, atSeconds).toFixed(3),
      "-i",
      sourcePath,
      "-frames:v",
      "1",
      "-vf",
      `scale=${widthPx}:-1`,
      outputPath,
    ]).execute();
    return output.code === 0;
  } catch (err) {
    console.error("[ffmpeg] thumbnail extraction failed:", err);
    return false;
  }
}

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
  /** When given 2+ entries, the render concatenates these source ranges
   * (in the order listed - not necessarily chronological, so this also
   * covers reordering a clip to lead with its payoff) instead of a single
   * contiguous trim. startSeconds/endSeconds above are still used for
   * duration bookkeeping when this is omitted or has a single entry - the
   * common case stays on the plain -ss/-t path with no behaviour change. */
  segments?: { startSeconds: number; endSeconds: number }[];
  /** Absolute path to an SRT or ASS subtitle file, already time-shifted to
   * the trim range. ASS is needed for per-line styling (e.g. AI-suggested
   * emphasis) that a plain SRT + uniform force_style can't express. */
  captionsSrtPath?: string;
  /** Timestamps (seconds, relative to the trim start) to flash to white
   * at. Independent of zoomSeconds so each effect type can be placed on
   * its own. A plain number uses normal strength; pass a WeightedImpact to
   * scale one impact's duration/amplitude (e.g. from an AI intensity). */
  flashSeconds?: ImpactInput[];
  /** Timestamps (seconds, relative to the trim start) to punch a zoom-in
   * at. Independent of flashSeconds. */
  zoomSeconds?: ImpactInput[];
  /** Timestamps for a brief camera-shake jitter. */
  shakeSeconds?: ImpactInput[];
  /** Timestamps for a brief RGB channel-split glitch. */
  glitchSeconds?: ImpactInput[];
  /** Timestamps for a brief pixelation burst. */
  mosaicSeconds?: ImpactInput[];
  /** Timestamps for a brief colour-invert pulse. */
  invertSeconds?: ImpactInput[];
  /** Total duration (seconds) each flash fades in and back out over. */
  flashDurationSec?: number;
  /** Total duration (seconds) each zoom punch eases in and back out over. */
  zoomDurationSec?: number;
  /** Total duration (seconds) each shake jitter lasts. */
  shakeDurationSec?: number;
  /** Total duration (seconds) each glitch burst lasts. */
  glitchDurationSec?: number;
  /** Total duration (seconds) each mosaic burst lasts. */
  mosaicDurationSec?: number;
  /** Total duration (seconds) each invert pulse fades in and back out over. */
  invertDurationSec?: number;
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

// Raw game/mic audio varies wildly in level (a real capture measured at
// -52 dBFS - practically inaudible next to a phone's default volume) with
// nothing in this pipeline ever correcting it. Single-pass EBU R128
// loudnorm won't hit -14 LUFS as precisely as a measure-then-apply two-pass
// would, but it needs no extra ffmpeg run and reliably brings quiet source
// audio up (and hot audio down) into a normal streaming-loudness range
// instead of leaving whatever the raw capture happened to be.
const LOUDNORM_FILTER = "loudnorm=I=-14:TP=-1.5:LRA=11";

// 20px was the original default, tuned without checking legibility at the
// real 1920px-tall output - a real exported clip made it obvious that's
// far too small to read at a glance (confirmed against a live AI-exported
// render). 56px was the first fix; bumped again to 68px after live
// feedback that captions still didn't feel prominent/"in your face"
// enough against busy gameplay footage.
export const DEFAULT_CAPTION_FONT_SIZE = 68;
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

// Splits the source into per-segment trim+setpts branches (video and audio
// separately - concat needs matching pair counts, and keeping them apart
// lets the audio branch feed straight into the existing SFX-mixing pass)
// and concatenates them back into single [vcat]/[acat] streams. setpts is
// required, not cosmetic: without resetting each segment's timestamps to
// start at 0, concat sees the original absolute source timestamps and
// either stalls or reproduces the gaps between segments instead of
// actually joining them back-to-back.
function buildSegmentConcatStages(
  segments: { startSeconds: number; endSeconds: number }[],
): { preStages: string[]; videoLabel: string; audioLabel: string } {
  const videoParts = segments.map(
    (seg, i) =>
      `[0:v]trim=start=${seg.startSeconds.toFixed(3)}:end=${seg.endSeconds.toFixed(3)},setpts=PTS-STARTPTS[cv${i}]`,
  );
  const audioParts = segments.map(
    (seg, i) =>
      `[0:a]atrim=start=${seg.startSeconds.toFixed(3)}:end=${seg.endSeconds.toFixed(3)},asetpts=PTS-STARTPTS[ca${i}]`,
  );
  const videoConcat = `${segments.map((_, i) => `[cv${i}]`).join("")}concat=n=${segments.length}:v=1:a=0[vcat]`;
  const audioConcat = `${segments.map((_, i) => `[ca${i}]`).join("")}concat=n=${segments.length}:v=0:a=1[acat]`;
  return {
    preStages: [...videoParts, ...audioParts, videoConcat, audioConcat],
    videoLabel: "vcat",
    audioLabel: "acat",
  };
}

export async function renderVertical(
  opts: RenderOptions,
): Promise<RenderResult> {
  const stages = [buildCropFilter(opts.framingPan ?? 0)];
  const shakeFilter = buildShakeFilter(opts.shakeSeconds ?? [], opts.shakeDurationSec);
  if (shakeFilter) stages.push(shakeFilter);
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
  const glitchFilter = buildGlitchFilter(opts.glitchSeconds ?? [], opts.glitchDurationSec);
  if (glitchFilter) stages.push(glitchFilter);
  const mosaicFilter = buildMosaicFilter(opts.mosaicSeconds ?? [], opts.mosaicDurationSec);
  if (mosaicFilter) stages.push(mosaicFilter);
  const invertFilter = buildInvertFilter(opts.invertSeconds ?? [], opts.invertDurationSec);
  if (invertFilter) stages.push(invertFilter);
  const flashFilter = buildFlashFilter(opts.flashSeconds ?? [], opts.flashDurationSec);
  if (flashFilter) stages.push(flashFilter);

  const segments = opts.segments ?? [];
  const isMultiSegment = segments.length > 1;

  // Every branch forces yuv420p explicitly - without it, NVENC just keeps
  // whatever pixel format the filter chain happens to produce, and geq
  // (the invert effect) outputs RGB (confirmed live: gbrp), not YUV. An
  // H.264 file that isn't standard 4:2:0 chroma is a real compatibility
  // problem, not just a quality nuance - phones and platforms like TikTok
  // either mishandle it or silently re-transcode it themselves at worse
  // quality than delivering yuv420p directly would have. p7 (NVENC's
  // highest-quality preset) costs a few extra seconds of encode time,
  // negligible for a 15-90s clip.
  let args: string[];
  if (isMultiSegment) {
    const { preStages, videoLabel, audioLabel } = buildSegmentConcatStages(segments);
    const videoChain = `[${videoLabel}]${stages.join(",")}[vout]`;
    // Loudness-normalize here too (see the single-range branch below for
    // why) - folded into the same filter_complex since -af can't be mixed
    // with an existing -filter_complex targeting the same stream.
    const audioChain = `[${audioLabel}]${LOUDNORM_FILTER}[aout]`;
    const filterComplex = [...preStages, videoChain, audioChain].join(";");
    args = [
      "-y",
      "-i",
      opts.sourcePath,
      "-filter_complex",
      filterComplex,
      "-map",
      "[vout]",
      "-map",
      "[aout]",
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "h264_nvenc",
      "-preset",
      "p7",
      "-b:v",
      "18M",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      opts.outputPath,
    ];
  } else {
    const duration = Math.max(0.1, opts.endSeconds - opts.startSeconds);
    args = [
      "-y",
      "-ss",
      opts.startSeconds.toFixed(3),
      "-i",
      opts.sourcePath,
      "-t",
      duration.toFixed(3),
      "-vf",
      stages.join(","),
      "-af",
      LOUDNORM_FILTER,
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "h264_nvenc",
      "-preset",
      "p7",
      "-b:v",
      "18M",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      opts.outputPath,
    ];
  }

  try {
    const output = await Command.sidecar("binaries/ffmpeg", args).execute();
    return { ok: output.code === 0, log: output.stderr };
  } catch (err) {
    return { ok: false, log: err instanceof Error ? err.message : String(err) };
  }
}

export interface SfxMixInput {
  filePath: string;
  /** Seconds from the start of the already-trimmed video to start this
   * sound effect at. */
  atSeconds: number;
  /** 0-1 relative volume - kept well under 1 by convention so an SFX
   * accents the mix rather than drowning out voice/game audio. */
  volume: number;
}

export interface MusicMixInput {
  filePath: string;
  /** 0-1 relative volume before ducking - the level it plays at during
   * quiet stretches, not its peak (sidechaincompress pulls it down further
   * under voice/game audio). */
  volume: number;
}

/** A second pass over an already-rendered clip that mixes in one-shot
 * sound effects and/or a looping background music bed onto its existing
 * audio track, without touching video (stream-copied). Kept separate from
 * renderVertical rather than folded into its single -vf chain, so the
 * well-exercised manual editor render path (no audio mixing) can't
 * regress from this.
 *
 * Every mixed-in source is normalized to 48kHz stereo first - source
 * files can be mono/different sample rates, and ffmpeg's amix expects
 * matching formats across inputs. amix's default auto-normalize would
 * quietly turn down the base track's volume for every source layered in;
 * normalize=0 plus explicit per-input `volume` keeps the base audio at
 * its original level regardless of how much is mixed in on top of it.
 *
 * Music is looped indefinitely (`-stream_loop -1`) rather than measured
 * and trimmed to length up front - amix's `duration=first` already
 * truncates every other input to the base track's length (confirmed live
 * against a real multi-SFX export), so an infinite loop is simplest and
 * needs no duration probing. It's ducked via sidechaincompress keyed off
 * the base track, so it backs off under voice/game audio and comes back
 * up in quiet stretches rather than just playing underneath at a fixed,
 * always-competing volume. */
export async function mixSoundEffects(
  videoPath: string,
  outputPath: string,
  sfx: SfxMixInput[],
  music?: MusicMixInput,
): Promise<RenderResult> {
  const inputArgs: string[] = ["-i", videoPath];
  for (const s of sfx) inputArgs.push("-i", s.filePath);
  const musicIndex = music ? 1 + sfx.length : null;
  if (music) inputArgs.push("-stream_loop", "-1", "-i", music.filePath);

  const filterParts = ["[0:a]aformat=sample_rates=48000:channel_layouts=stereo[base]"];
  const mixLabels = ["base"];
  sfx.forEach((s, i) => {
    const inputIndex = i + 1;
    const delayMs = Math.max(0, Math.round(s.atSeconds * 1000));
    const label = `s${inputIndex}`;
    filterParts.push(
      `[${inputIndex}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${delayMs}|${delayMs},volume=${s.volume.toFixed(3)}[${label}]`,
    );
    mixLabels.push(label);
  });
  if (music && musicIndex !== null) {
    filterParts.push(
      `[${musicIndex}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${music.volume.toFixed(3)}[musicraw]`,
    );
    filterParts.push(
      `[musicraw][base]sidechaincompress=threshold=0.05:ratio=10:attack=5:release=300[musicducked]`,
    );
    mixLabels.push("musicducked");
  }
  // The base track going in is already loudness-normalized (renderVertical
  // applies it too), but SFX/music get added on top at fixed relative
  // volumes, not loudness-matched themselves - re-normalizing the final
  // combined mix is what actually guarantees the delivered file lands at
  // the target loudness regardless of how hot or quiet the imported
  // SFX/music files happen to be.
  filterParts.push(
    `[${mixLabels.join("][")}]amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0:normalize=0,${LOUDNORM_FILTER}[aout]`,
  );

  const args = [
    "-y",
    ...inputArgs,
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    "0:v",
    "-map",
    "[aout]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    outputPath,
  ];
  try {
    const output = await Command.sidecar("binaries/ffmpeg", args).execute();
    return { ok: output.code === 0, log: output.stderr };
  } catch (err) {
    return { ok: false, log: err instanceof Error ? err.message : String(err) };
  }
}

export interface VfxOverlayInput {
  filePath: string;
  /** Seconds from the start of the already-rendered clip to start playing
   * this overlay at. */
  atSeconds: number;
  /** How long the overlay plays for - the overlay clip is trimmed to this. */
  durationSeconds: number;
  /** "screen" = additive blend, correct for the common case of a plain
   * MP4 on a black background (pure black contributes nothing, so it
   * reads as transparent with no real alpha channel needed). "alpha" =
   * the file actually carries a transparency channel (ProRes 4444 MOV,
   * VP9 alpha WebM) and can go through a normal overlay compose. */
  blendMode: "screen" | "alpha";
  /** 0-1. Only meaningful for "screen" - dials how strongly the additive
   * glow reads over the base footage; alpha-channel overlays are already
   * fully opaque wherever they have content, so this doesn't apply there. */
  opacity: number;
}

/** A third pass over an already-rendered clip (after renderVertical, and
 * before or after mixSoundEffects - order between those two doesn't
 * matter, one is video-only and the other audio-only) that composites
 * transition/VFX overlay footage (light leaks, glitch bursts, film burns)
 * on top at specific moments. Kept as its own pass for the same reason
 * mixSoundEffects is: isolating new compositing work from the
 * already-intricate renderVertical filter chain rather than growing it
 * further.
 *
 * eof_action=pass on both overlay and blend is required, not optional -
 * without it, ffmpeg ends the whole output the moment the (much shorter)
 * overlay clip's trimmed stream runs out, silently truncating the render
 * to just a few seconds. shortest=0 keeps blend's framesync from doing
 * the same. */
export async function compositeVfxOverlays(
  videoPath: string,
  outputPath: string,
  overlays: VfxOverlayInput[],
): Promise<RenderResult> {
  const inputArgs: string[] = ["-i", videoPath];
  for (const o of overlays) inputArgs.push("-i", o.filePath);

  const filterParts: string[] = [];
  let currentLabel = "0:v";
  overlays.forEach((o, i) => {
    const inputIndex = i + 1;
    const prepared = `ov${inputIndex}`;
    const start = Math.max(0, o.atSeconds);
    const duration = Math.max(0.1, o.durationSeconds);
    const end = start + duration;
    // Cover-fit to the vertical canvas, trim/hold to the requested
    // window length, then shift its own timeline so its first frame
    // lands at `start` on the base video's timeline (the video
    // equivalent of adelay for an audio SFX).
    filterParts.push(
      `[${inputIndex}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS+${start.toFixed(3)}/TB[${prepared}]`,
    );
    const nextLabel = `vfx${inputIndex}`;
    if (o.blendMode === "alpha") {
      filterParts.push(
        `[${currentLabel}][${prepared}]overlay=enable='between(t,${start.toFixed(3)},${end.toFixed(3)})':eof_action=pass:format=auto[${nextLabel}]`,
      );
    } else {
      filterParts.push(
        `[${currentLabel}][${prepared}]blend=all_mode=screen:all_opacity=${o.opacity.toFixed(2)}:eof_action=pass:shortest=0:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'[${nextLabel}]`,
      );
    }
    currentLabel = nextLabel;
  });

  const args = [
    "-y",
    ...inputArgs,
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    `[${currentLabel}]`,
    "-map",
    "0:a",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "h264_nvenc",
    "-preset",
    "p7",
    "-b:v",
    "18M",
    "-c:a",
    "copy",
    outputPath,
  ];
  try {
    const output = await Command.sidecar("binaries/ffmpeg", args).execute();
    return { ok: output.code === 0, log: output.stderr };
  } catch (err) {
    return { ok: false, log: err instanceof Error ? err.message : String(err) };
  }
}
