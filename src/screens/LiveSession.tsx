import { useCapture } from "../lib/capture";
import { useObs } from "../lib/obs";
import { useDetection } from "../lib/detection";
import { ExcitementTimeline } from "../components/ExcitementTimeline";
import "./LiveSession.css";

function Meter({
  label,
  value,
  caption,
}: {
  label: string;
  value: number;
  caption?: string;
}) {
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

export function LiveSession() {
  const obs = useObs();
  const capture = useCapture();
  const detection = useDetection();
  const disabled = obs.status !== "connected";

  return (
    <div className="live-session">
      <div className="live-session__header">
        <h1 className="live-session__title">Live session</h1>
        <span className="live-session__subtitle">
          The full ingest preview and caught-clips feed land with the editor
          and OBS dock milestones — the signals below are already live.
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
        <Meter
          label="Raised voice"
          value={detection.voiceScore}
          caption={
            obs.micInputName
              ? `tracking "${obs.micInputName}"`
              : obs.status === "connected"
                ? "no mic input found in OBS"
                : "connect to OBS to track mic level"
          }
        />
        <Meter
          label="Chat spike"
          value={detection.chatScore}
          caption={
            detection.chatConnected
              ? "connected to Twitch chat"
              : "set a Twitch channel on Sources to enable"
          }
        />
        <Meter
          label="Screen motion"
          value={detection.motionScore}
          caption={obs.sceneName ? `scene "${obs.sceneName}"` : undefined}
        />
      </div>

      <ExcitementTimeline
        history={detection.history}
        marks={detection.marks}
      />
    </div>
  );
}
