import { useEffect, useRef, useState } from "react";
import "./TuningSlider.css";

/** A slider that shows every drag movement immediately but only commits the
 * value after motion stops - used for values that feed straight into a
 * running loop (live detection weights, a render's effect timing), where
 * committing on every intermediate drag step would restart that loop or
 * recompute derived state dozens of times per second for nothing. */
export function TuningSlider({
  label,
  value,
  min,
  max,
  step,
  format,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(value);

  useEffect(() => {
    draftRef.current = value;
    setDraft(value);
  }, [value]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (draftRef.current !== value) onCommit(draftRef.current);
    }, 200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  return (
    <div className="tuning-slider">
      <div className="tuning-slider__row">
        <span className="tuning-slider__label">{label}</span>
        <span className="tuning-slider__value">{format(draft)}</span>
      </div>
      <input
        type="range"
        className="tuning-slider__input"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(e) => {
          const v = Number(e.target.value);
          draftRef.current = v;
          setDraft(v);
        }}
      />
    </div>
  );
}
