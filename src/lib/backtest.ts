import type { SignalSample } from "./db";
import type { DetectionWeights } from "./settingsContext";
import type { ScorePoint } from "./detection";

export interface BacktestParams {
  threshold: number;
  cooldownMs: number;
  weights: DetectionWeights;
}

export interface BacktestResult {
  history: ScorePoint[];
  marks: number[];
}

/** Re-runs the same threshold+cooldown detection logic detection.tsx uses
 * live, but over a stored sample history with adjustable parameters - so
 * tuning weights/threshold can be judged against a real past session
 * instead of only the current live stream. */
export function runBacktest(
  samples: SignalSample[],
  params: BacktestParams,
): BacktestResult {
  const history: ScorePoint[] = [];
  const marks: number[] = [];
  let lastTrigger = -Infinity;

  for (const s of samples) {
    const composite =
      s.voice * params.weights.voice +
      s.chat * params.weights.chat +
      s.motion * params.weights.motion;
    history.push({ t: s.tMs, value: composite });

    if (
      composite >= params.threshold &&
      s.tMs - lastTrigger > params.cooldownMs
    ) {
      lastTrigger = s.tMs;
      marks.push(s.tMs);
    }
  }

  return { history, marks };
}
