import type { ReactNode } from "react";
import "./SignalMeter.css";

interface SignalMeterProps {
  label: string;
  value: number;
  caption?: ReactNode;
}

export function SignalMeter({ label, value, caption }: SignalMeterProps) {
  return (
    <div className="signal-meter">
      <div className="signal-meter__row">
        <span className="signal-meter__label">{label}</span>
        <span className="signal-meter__value">{value.toFixed(2)}</span>
      </div>
      <div className="signal-meter__track">
        <div
          className={
            "signal-meter__fill" +
            (value > 0.8 ? " signal-meter__fill--alert" : "")
          }
          style={{ width: `${Math.round(Math.min(1, value) * 100)}%` }}
        />
      </div>
      {caption && <div className="signal-meter__caption">{caption}</div>}
    </div>
  );
}
