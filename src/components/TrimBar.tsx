import { useEffect, useRef } from "react";
import { formatTime } from "../lib/format";
import "./TrimBar.css";

export interface TrimBarMarker {
  time: number;
  variant: "flash" | "zoom" | "both";
  onClick?: () => void;
}

interface TrimBarProps {
  duration: number;
  start: number;
  end: number;
  currentTime: number;
  onChangeStart: (t: number) => void;
  onChangeEnd: (t: number) => void;
  onSeek: (t: number) => void;
  markers?: TrimBarMarker[];
}

export function TrimBar({
  duration,
  start,
  end,
  currentTime,
  onChangeStart,
  onChangeEnd,
  onSeek,
  markers,
}: TrimBarProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<"start" | "end" | null>(null);

  const timeFromClientX = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || duration <= 0) return 0;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * duration;
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      const t = timeFromClientX(e.clientX);
      if (draggingRef.current === "start") {
        onChangeStart(Math.min(t, end - 0.1));
      } else {
        onChangeEnd(Math.max(t, start + 0.1));
      }
    };
    const onUp = () => {
      draggingRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end, duration]);

  const pct = (t: number) => (duration > 0 ? (t / duration) * 100 : 0);

  return (
    <div className="trim-bar">
      <span className="trim-bar__time">{formatTime(0)}</span>
      <div
        className="trim-bar__track"
        ref={trackRef}
        onClick={(e) => {
          if (draggingRef.current) return;
          onSeek(timeFromClientX(e.clientX));
        }}
      >
        <div
          className="trim-bar__selection"
          style={{ left: `${pct(start)}%`, right: `${100 - pct(end)}%` }}
        />
        <div
          className="trim-bar__playhead"
          style={{ left: `${pct(currentTime)}%` }}
        />
        <div
          className="trim-bar__handle trim-bar__handle--start"
          style={{ left: `${pct(start)}%` }}
          onPointerDown={(e) => {
            e.stopPropagation();
            draggingRef.current = "start";
          }}
        />
        <div
          className="trim-bar__handle trim-bar__handle--end"
          style={{ left: `${pct(end)}%` }}
          onPointerDown={(e) => {
            e.stopPropagation();
            draggingRef.current = "end";
          }}
        />
        {markers?.map((m) => (
          <div
            key={m.time}
            className={`trim-bar__marker trim-bar__marker--${m.variant}`}
            style={{ left: `${pct(m.time)}%` }}
            title={`${m.variant} · ${formatTime(m.time)}`}
            onClick={(e) => {
              e.stopPropagation();
              m.onClick?.();
            }}
          />
        ))}
      </div>
      <span className="trim-bar__time">{formatTime(duration)}</span>
    </div>
  );
}
