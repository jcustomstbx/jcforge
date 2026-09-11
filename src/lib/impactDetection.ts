import { convertFileSrc } from "@tauri-apps/api/core";
import { join, tempDir } from "@tauri-apps/api/path";
import { Command } from "@tauri-apps/plugin-shell";

// A tighter window than the live detection loop's 100ms sampling - this
// runs once on a whole clip's decoded audio, so there's no reason not to
// localize the peak precisely. A coarser window meant the flash/zoom could
// land up to ~100ms off the actual transient, which reads as "late"
// against fast game audio.
const WINDOW_SEC = 0.03;
const MIN_SPACING_SEC = 1.2;
const MAX_IMPACTS = 5;
const PEAK_STDDEV_MULTIPLIER = 1.3;

/**
 * Finds loud "impact" moments within [startSec, endSec] of a clip by
 * decoding its audio (Web Audio API - no extra native tool needed beyond
 * the ffmpeg extraction we already do for captions) and picking local RMS
 * peaks that stand out from the clip's own loudness distribution.
 *
 * Returned timestamps are relative to startSec (i.e. 0 = startSec),
 * matching the render's trimmed output timeline.
 */
export async function detectImpactMoments(
  sourcePath: string,
  startSec: number,
  endSec: number,
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
    const stddev = Math.sqrt(variance);
    const threshold = mean + PEAK_STDDEV_MULTIPLIER * stddev;

    const candidates: { time: number; value: number }[] = [];
    for (let i = 1; i < envelope.length - 1; i++) {
      if (
        envelope[i] > threshold &&
        envelope[i] >= envelope[i - 1] &&
        envelope[i] >= envelope[i + 1]
      ) {
        candidates.push({ time: i * WINDOW_SEC, value: envelope[i] });
      }
    }
    candidates.sort((a, b) => b.value - a.value);

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
