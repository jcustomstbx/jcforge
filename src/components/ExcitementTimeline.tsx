import type { ScorePoint } from "../lib/detection";
import { DEFAULT_DETECTION_THRESHOLD } from "../lib/settingsContext";
import "./ExcitementTimeline.css";

const WINDOW_MS = 30 * 60 * 1000;

interface ExcitementTimelineProps {
  history: ScorePoint[];
  marks: number[];
  threshold?: number;
  /** Explicit time range for the x-axis, e.g. a past session's span -
   * defaults to "the last 30 minutes up to now" for the live view. */
  rangeStart?: number;
  rangeEnd?: number;
  /** Label shown where the live view says "last 30 min". */
  rangeLabel?: string;
}

export function ExcitementTimeline({
  history,
  marks,
  threshold = DEFAULT_DETECTION_THRESHOLD,
  rangeStart,
  rangeEnd,
  rangeLabel = "last 30 min",
}: ExcitementTimelineProps) {
  const windowEnd = rangeEnd ?? Date.now();
  const windowStart = rangeStart ?? windowEnd - WINDOW_MS;
  const span = Math.max(1, windowEnd - windowStart);
  const visible = history.filter(
    (p) => p.t >= windowStart && p.t <= windowEnd,
  );

  const toX = (t: number) => ((t - windowStart) / span) * 100;
  const toY = (v: number) => (1 - Math.min(1, Math.max(0, v))) * 100;

  const points = visible.map((p) => `${toX(p.t)},${toY(p.value)}`).join(" ");
  const areaPoints =
    visible.length > 0 ? `0,100 ${points} ${toX(visible[visible.length - 1]!.t)},100` : "";

  const visibleMarks = marks.filter((m) => m >= windowStart && m <= windowEnd);

  return (
    <div className="excitement-timeline">
      <div className="excitement-timeline__header">
        <span className="excitement-timeline__title">
          EXCITEMENT TIMELINE
        </span>
        <div className="excitement-timeline__spacer" />
        <span className="excitement-timeline__meta">
          {rangeLabel} · threshold {threshold.toFixed(2)}
        </span>
      </div>
      <div className="excitement-timeline__well">
        <div
          className="excitement-timeline__threshold-line"
          style={{ top: `${(1 - threshold) * 100}%` }}
        />
        {visibleMarks.map((m) => (
          <div
            key={m}
            className="excitement-timeline__mark"
            style={{ left: `${toX(m)}%` }}
          />
        ))}
        {visible.length > 1 && (
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="excitement-timeline__svg"
          >
            <defs>
              <linearGradient id="excitement-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#3ddbc6" stopOpacity="0.45" />
                <stop offset="100%" stopColor="#3ddbc6" stopOpacity="0" />
              </linearGradient>
            </defs>
            <polygon points={areaPoints} fill="url(#excitement-fill)" />
            <polyline
              points={points}
              fill="none"
              stroke="#3ddbc6"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}
      </div>
    </div>
  );
}
