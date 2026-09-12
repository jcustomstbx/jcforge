import { convertFileSrc } from "@tauri-apps/api/core";
import { join, tempDir } from "@tauri-apps/api/path";
import { Command } from "@tauri-apps/plugin-shell";
import type { CaptionLine } from "./captions";

// A tighter window than the live detection loop's 100ms sampling - this
// runs once on a whole clip's decoded audio, so there's no reason not to
// localize the peak precisely. A coarser window meant the flash/zoom could
// land up to ~100ms off the actual transient, which reads as "late"
// against fast game audio.
const WINDOW_SEC = 0.03;
const MIN_SPACING_SEC = 1.2;
const MAX_IMPACTS = 5;
const PEAK_STDDEV_MULTIPLIER = 1.3;

// How far around a caption line's own [start, end] to still credit it for
// an audio peak - a reaction ("no way!") often lands a beat before or after
// the actual audio transient it's reacting to.
const LANGUAGE_MATCH_WINDOW_SEC = 1.5;
const AUDIO_RANK_WEIGHT = 1;
const LANGUAGE_RANK_WEIGHT = 0.8;

// Keyword/phrase heuristics rather than a bolted-on ML model - this reuses
// the transcript Whisper already produces, runs instantly with no extra
// model to bundle or run inference on, and is exactly as auditable as the
// rest of this codebase's signal scoring (voice/chat/motion are all
// similar hand-tuned heuristics, not black boxes). A real semantic model
// would catch more nuance but is a much bigger, slower dependency for a
// desktop app that already bundles whisper.cpp and ffmpeg.
const HYPE_PATTERNS: RegExp[] = [
  /\blet'?s\s?go\b/i,
  /\bno\s?way\b/i,
  /\boh\s?my\s?god\b/i,
  /\bomg\b/i,
  /\bholy\b/i,
  /\binsane\b/i,
  /\bclutch\b/i,
  /\bpog(gers)?\b/i,
  /\bsheesh\b/i,
  /\bunbelievable\b/i,
  /\bwhat\s?the\b/i,
  /\bwtf\b/i,
  /\byoo+\b/i,
  /\bha(ha)+\b/i,
  /\blmao\b/i,
  /\blol\b/i,
  /\bf+u+c+k+\w*\b/i,
  /\bshit\b/i,
  /\bdamn\b/i,
  /\byes+!?\b/i,
];

/** 0 (no hype language), 0.5 (one marker), 1 (two or more). */
function hypeScoreForText(text: string): number {
  if (!text) return 0;
  let hits = 0;
  for (const pattern of HYPE_PATTERNS) {
    if (pattern.test(text)) hits++;
  }
  return Math.min(1, hits / 2);
}

/** Best hype score among caption lines whose window overlaps `absoluteTime`
 * within LANGUAGE_MATCH_WINDOW_SEC - 0 if no captions were provided. */
function languageScoreNear(
  absoluteTime: number,
  lines: CaptionLine[] | null | undefined,
): number {
  if (!lines || lines.length === 0) return 0;
  let best = 0;
  for (const line of lines) {
    const overlaps =
      absoluteTime >= line.start - LANGUAGE_MATCH_WINDOW_SEC &&
      absoluteTime <= line.end + LANGUAGE_MATCH_WINDOW_SEC;
    if (!overlaps) continue;
    const score = hypeScoreForText(line.text);
    if (score > best) best = score;
  }
  return best;
}

interface Candidate {
  /** Relative to startSec, matching the function's return contract. */
  time: number;
  rank: number;
}

/**
 * Finds "hype" moments within [startSec, endSec] of a clip by combining two
 * signals: loud RMS peaks in the clip's own audio (as before), and - when a
 * transcript is available - caption lines containing excited language
 * ("let's go", laughter, swearing, etc). Combining them catches what either
 * alone misses: a loud but unremarkable noise no longer wins purely on
 * volume if nothing was said, and a quietly-delivered "no way..." can still
 * surface even when the audio itself never spikes.
 *
 * Passing `captionLines` is optional - without it this behaves exactly as
 * the audio-only version did. Best results come from transcribing first,
 * since detection can then use both signals.
 *
 * Returned timestamps are relative to startSec (i.e. 0 = startSec),
 * matching the render's trimmed output timeline.
 */
export async function detectImpactMoments(
  sourcePath: string,
  startSec: number,
  endSec: number,
  captionLines?: CaptionLine[] | null,
): Promise<number[]> {
  const scratch = await tempDir();
  const wavPath = await join(scratch, `jcforge_impact_${Date.now()}.wav`);

  const extract = await Command.sidecar("binaries/ffmpeg", [
    "-y",
    "-i",
    sourcePath,
    "-ss",
    startSec.toFixed(3),
    "-to",
    endSec.toFixed(3),
    "-vn",
    "-ar",
    "44100",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    wavPath,
  ]).execute();
  if (extract.code !== 0) {
    console.error("[impact] audio extraction failed:", extract.stderr);
    return [];
  }

  let audioCtx: AudioContext | null = null;
  try {
    const response = await fetch(convertFileSrc(wavPath));
    const arrayBuffer = await response.arrayBuffer();
    audioCtx = new AudioContext();
    const decoded = await audioCtx.decodeAudioData(arrayBuffer);
    const samples = decoded.getChannelData(0);
    const sampleRate = decoded.sampleRate;

    const windowSize = Math.max(1, Math.floor(sampleRate * WINDOW_SEC));
    const envelope: number[] = [];
    for (let i = 0; i < samples.length; i += windowSize) {
      const end = Math.min(i + windowSize, samples.length);
      let sum = 0;
      for (let j = i; j < end; j++) sum += samples[j] * samples[j];
      envelope.push(Math.sqrt(sum / (end - i)));
    }
    if (envelope.length === 0) return [];

    const mean = envelope.reduce((a, b) => a + b, 0) / envelope.length;
    const variance =
      envelope.reduce((a, b) => a + (b - mean) ** 2, 0) / envelope.length;
    const stddev = Math.sqrt(variance) || 1e-9;
    const threshold = mean + PEAK_STDDEV_MULTIPLIER * stddev;

    // z-score of an envelope value, clamped and squashed to roughly 0..1
    // for ranking against language scores on a comparable scale.
    const audioRank = (value: number) =>
      Math.min(1, Math.max(0, (value - mean) / stddev / 4));

    const candidates: Candidate[] = [];

    // Signal 1: audio peaks that stand out from this clip's own loudness
    // distribution - unchanged from the original audio-only detector.
    for (let i = 1; i < envelope.length - 1; i++) {
      if (
        envelope[i] > threshold &&
        envelope[i] >= envelope[i - 1] &&
        envelope[i] >= envelope[i + 1]
      ) {
        const time = i * WINDOW_SEC;
        const rank =
          AUDIO_RANK_WEIGHT * audioRank(envelope[i]) +
          LANGUAGE_RANK_WEIGHT * languageScoreNear(time + startSec, captionLines);
        candidates.push({ time, rank });
      }
    }

    // Signal 2: caption lines with real hype language, even where the
    // audio itself never crossed the statistical peak threshold - this is
    // what catches a quietly-delivered reaction that pure loudness misses.
    if (captionLines) {
      for (const line of captionLines) {
        if (line.start < startSec || line.start > endSec) continue;
        const hype = hypeScoreForText(line.text);
        if (hype <= 0) continue;
        const midpoint = (line.start + line.end) / 2;
        const time = Math.min(endSec, Math.max(startSec, midpoint)) - startSec;
        const envelopeIndex = Math.min(
          envelope.length - 1,
          Math.max(0, Math.round(time / WINDOW_SEC)),
        );
        const rank =
          AUDIO_RANK_WEIGHT * audioRank(envelope[envelopeIndex]) +
          LANGUAGE_RANK_WEIGHT * hype;
        candidates.push({ time, rank });
      }
    }

    candidates.sort((a, b) => b.rank - a.rank);

    const chosen: number[] = [];
    for (const c of candidates) {
      if (chosen.length >= MAX_IMPACTS) break;
      if (chosen.every((t) => Math.abs(t - c.time) >= MIN_SPACING_SEC)) {
        chosen.push(c.time);
      }
    }
    return chosen.sort((a, b) => a - b);
  } catch (err) {
    console.error("[impact] detection failed:", err);
    return [];
  } finally {
    audioCtx?.close();
  }
}
