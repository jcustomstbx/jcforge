import { useCapture } from "../lib/capture";
import { useObs } from "../lib/obs";
import { useBackend } from "../lib/backend";
import { useSettings } from "../lib/settingsContext";
import { useDetection } from "../lib/detection";
import { ExcitementTimeline } from "../components/ExcitementTimeline";
import { SignalMeter } from "../components/SignalMeter";
import "./LiveSession.css";

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
        <SignalMeter
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
        <SignalMeter
          label="Chat spike"
          value={detection.chatScore}
          caption={
            detection.chatConnected
              ? "connected to Twitch chat"
              : "set a Twitch channel on Sources to enable"
          }
        />
        <SignalMeter
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
        threshold={settings.detectionThreshold}
      />
    </div>
  );
}
