import { useCapture } from "../lib/capture";
import { useObs } from "../lib/obs";
import { useVoiceSignal } from "../lib/voiceSignal";
import "./LiveSession.css";

export function LiveSession() {
  const obs = useObs();
  const capture = useCapture();
  const voice = useVoiceSignal();
  const disabled = obs.status !== "connected";

  return (
    <div className="live-session">
      <div className="live-session__header">
        <h1 className="live-session__title">Live session</h1>
        <span className="live-session__subtitle">
          The full during-stream view — ingest preview, excitement timeline
          and caught-clips feed — lands with the chat and motion signals in a
          later milestone.
        </span>
        <div className="live-session__spacer" />
        <button
          className="live-session__mark-button"
          disabled={disabled}
          onClick={() => capture.triggerCapture()}
          title={disabled ? "Connect to OBS first" : undefined}
        >
          Mark manually (F9)
        </button>
      </div>

      <div className="live-session__signals">
        <div className="signal-meter">
          <div className="signal-meter__row">
            <span className="signal-meter__label">Raised voice</span>
            <span className="signal-meter__value">
              {voice.score.toFixed(2)}
            </span>
          </div>
          <div className="signal-meter__track">
            <div
              className={
                "signal-meter__fill" +
                (voice.score > 0.8 ? " signal-meter__fill--alert" : "")
              }
              style={{ width: `${Math.round(voice.score * 100)}%` }}
            />
          </div>
          <div className="signal-meter__caption">
            {obs.micInputName
              ? `tracking "${obs.micInputName}"`
              : obs.status === "connected"
                ? "no mic input found in OBS"
                : "connect to OBS to track mic level"}
          </div>
        </div>
      </div>
    </div>
  );
}
