import type { ReactNode } from "react";
import { useObs } from "../lib/obs";
import { useSettings } from "../lib/settingsContext";
import "./Recording.css";

// The decision here (per the owner) is display-and-warn, not manage: JCForge
// never changes OBS's encoder/resolution/framerate settings, only reads them
// back and flags anything that looks off against what the product expects.
const RECOMMENDED_MAX_FPS = 60;
const RECOMMENDED_MIN_WIDTH = 1280;
const RECOMMENDED_MIN_HEIGHT = 720;

function Warning({ children }: { children: ReactNode }) {
  return <div className="recording-screen__warning">{children}</div>;
}

// Split out so it only mounts (and only calls useObs()) while OBS is the
// active backend - Streamlabs has no ObsProvider/ObsContext to read from,
// and its API exposes no equivalent video-settings read either.
function ObsVideoSettingsCard() {
  const obs = useObs();
  const v = obs.videoSettings;

  if (obs.status !== "connected") {
    return (
      <div className="recording-screen__mono recording-screen__mono--dim">
        Connect to OBS to read its current video settings.
      </div>
    );
  }
  if (!v) {
    return (
      <div className="recording-screen__mono recording-screen__mono--dim">
        Couldn't read OBS's video settings - see console.
      </div>
    );
  }

  const warnings: string[] = [];
  if (v.fps > RECOMMENDED_MAX_FPS) {
    warnings.push(
      `${v.fps.toFixed(0)} fps is above the ${RECOMMENDED_MAX_FPS} fps this product targets - the replay buffer will use more memory than it needs to for content that mostly ships at 30-60 fps.`,
    );
  }
  if (v.outputWidth < RECOMMENDED_MIN_WIDTH || v.outputHeight < RECOMMENDED_MIN_HEIGHT) {
    warnings.push(
      `${v.outputWidth}×${v.outputHeight} is below the recommended ${RECOMMENDED_MIN_WIDTH}×${RECOMMENDED_MIN_HEIGHT} minimum for clips worth publishing.`,
    );
  }

  return (
    <>
      <div className="recording-screen__mono">
        {v.outputWidth}×{v.outputHeight} · {v.fps.toFixed(v.fps % 1 === 0 ? 0 : 2)} fps
      </div>
      {warnings.map((w) => (
        <Warning key={w}>{w}</Warning>
      ))}
    </>
  );
}

export function Recording() {
  const settings = useSettings();
  const isObs = settings.recordingBackend !== "streamlabs";

  return (
    <div className="recording-screen">
      <div>
        <h1 className="recording-screen__title">Recording</h1>
        <p className="recording-screen__subtitle">
          JCForge reads your recording software's video settings and flags
          anything that looks off - it never changes them for you.
        </p>
      </div>

      <div className="recording-screen__card">
        <div className="recording-screen__card-header">
          <span className="recording-screen__card-title">Video settings</span>
        </div>
        {isObs ? (
          <ObsVideoSettingsCard />
        ) : (
          <div className="recording-screen__mono recording-screen__mono--dim">
            Streamlabs' remote-control API doesn't expose video settings, so
            JCForge can't read or warn on them under this backend - check
            Streamlabs' own Video settings manually.
          </div>
        )}
      </div>

      <div className="recording-screen__card">
        <div className="recording-screen__card-header">
          <span className="recording-screen__card-title">Encoder</span>
        </div>
        <div className="recording-screen__mono recording-screen__mono--dim">
          Not read automatically yet - obs-websocket doesn't expose a single
          reliable "current encoder" call across Simple and Advanced output
          modes. Check OBS Settings → Output to confirm you're on a hardware
          encoder (NVENC/AMF/QSV) rather than the CPU x264 fallback.
        </div>
      </div>
    </div>
  );
}
