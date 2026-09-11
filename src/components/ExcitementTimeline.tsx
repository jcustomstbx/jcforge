import type { ScorePoint } from "../lib/detection";
import "./ExcitementTimeline.css";

const WINDOW_MS = 30 * 60 * 1000;
const THRESHOLD = 0.72;

interface ExcitementTimelineProps {
  history: ScorePoint[];
  marks: number[];
}

export function ExcitementTimeline({
  history,
  marks,
}: ExcitementTimelineProps) {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  const visible = history.filter((p) => p.t >= windowStart);

  const toX = (t: number) => ((t - windowStart) / WINDOW_MS) * 100;
  const toY = (v: number) => (1 - Math.min(1, Math.max(0, v))) * 100;

  const points = visible.map((p) => `${toX(p.t)},${toY(p.value)}`).join(" ");
  const areaPoints =
    visible.length > 0 ? `0,100 ${points} ${toX(visible[visible.length - 1]!.t)},100` : "";

  const visibleMarks = marks.filter((m) => m >= windowStart);

  return (
    <div className="excitement-timeline">
      <div className="excitement-timeline__header">
        <span className="excitement-timeline__title">
          EXCITEMENT TIMELINE
        </span>
        <div className="excitement-timeline__spacer" />
        <span className="excitement-timeline__meta">
          last 30 min · threshold {THRESHOLD.toFixed(2)}
        </span>
      </div>
      <div className="excitement-timeline__well">
        <div
          className="excitement-timeline__threshold-line"
          style={{ top: `${(1 - THRESHOLD) * 100}%` }}
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
