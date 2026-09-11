import { useCapture } from "../lib/capture";
import { useObs } from "../lib/obs";
import "./LiveSession.css";

export function LiveSession() {
  const obs = useObs();
  const capture = useCapture();
  const disabled = obs.status !== "connected";

  return (
    <div className="live-session">
      <div className="live-session__header">
        <h1 className="live-session__title">Live session</h1>
        <span className="live-session__subtitle">
          The full during-stream view — ingest preview, excitement timeline
          and caught-clips feed — lands with the detection signals in a later
          milestone.
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
    </div>
  );
}
