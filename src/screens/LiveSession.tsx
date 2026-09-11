import type { ReactNode } from "react";
import { useCapture } from "../lib/capture";
import { useObs } from "../lib/obs";
import { useBackend } from "../lib/backend";
import { useSettings } from "../lib/settingsContext";
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
  caption?: ReactNode;
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

// OBS reports which mic input it's tracking - split out so it only mounts
// (and only calls useObs()) while OBS is the active backend.
function ObsVoiceCaption() {
  const obs = useObs();
  if (obs.micInputName) return <>tracking "{obs.micInputName}"</>;
  if (obs.status === "connected") return <>no mic input found in OBS</>;
  return <>connect to OBS to track mic level</>;
}

export function LiveSession() {
  const backend = useBackend();
  const settings = useSettings();
  const capture = useCapture();
  const detection = useDetection();
  const isObs = settings.recordingBackend !== "streamlabs";
  const backendLabel = isObs ? "OBS" : "Streamlabs";
  const disabled = backend.status !== "connected";

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
          title={disabled ? `Connect to ${backendLabel} first` : undefined}
        >
          Mark manually (F9)
        </button>
      </div>

      <div className="live-session__signals">
        <Meter
          label="Raised voice"
          value={detection.voiceScore}
          caption={
            isObs ? (
              <ObsVoiceCaption />
            ) : backend.status === "connected" ? (
              "capturing mic directly"
            ) : (
              "connect to Streamlabs to track mic level"
            )
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
          caption={
            backend.sceneName
              ? `scene "${backend.sceneName}"`
              : !isObs
                ? "motion detection needs OBS"
                : undefined
          }
        />
      </div>

      <ExcitementTimeline
        history={detection.history}
        marks={detection.marks}
      />
    </div>
  );
}
