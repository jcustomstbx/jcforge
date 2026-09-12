import { getCurrentWindow } from "@tauri-apps/api/window";
import { Eye, EyeOff, Minus, Square, X } from "lucide-react";
import { useRef, useState } from "react";
import { useObs } from "../lib/obs";
import { useBackend } from "../lib/backend";
import { useSettings } from "../lib/settingsContext";
import { useLicense } from "../lib/license";
import logo from "../assets/logo.png";
import "./TitleBar.css";

function formatTrialRemaining(ms: number): string {
  const totalMinutes = Math.ceil(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  return `${minutes}m left`;
}

const appWindow = getCurrentWindow();

// OBS-specific password-retry popover, split out so it only mounts (and
// only calls useObs()) while OBS is actually the active backend - Streamlabs
// has no ObsProvider/ObsContext to read from.
function ObsRetryPopover({ show, onClose }: { show: boolean; onClose: () => void }) {
  const obs = useObs();
  const [password, setPassword] = useState("");
  const [revealPassword, setRevealPassword] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  if (!show) return null;

  const submitPassword = () => {
    const trimmed = password.trim();
    obs.connect(undefined, trimmed || undefined);
    onClose();
  };

  return (
    <div className="title-bar__password-popover">
      <div className="title-bar__password-label">
        OBS WebSocket password (if required)
      </div>
      <div className="title-bar__password-row">
        <input
          ref={inputRef}
          type={revealPassword ? "text" : "password"}
          className="title-bar__password-input"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitPassword();
            if (e.key === "Escape") onClose();
          }}
          placeholder="leave blank if none"
          autoFocus
        />
        <button
          type="button"
          className="title-bar__password-reveal"
          aria-label={revealPassword ? "Hide password" : "Show password"}
          onClick={() => setRevealPassword((v) => !v)}
        >
          {revealPassword ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
        <button className="title-bar__password-submit" onClick={submitPassword}>
          Connect
        </button>
      </div>
      {obs.error && <div className="title-bar__password-error">{obs.error}</div>}
    </div>
  );
}

export function TitleBar() {
  const backend = useBackend();
  const settings = useSettings();
  const license = useLicense();
  const isObs = settings.recordingBackend !== "streamlabs";
  const backendLabel = isObs ? "OBS" : "Streamlabs";
  const [showPasswordField, setShowPasswordField] = useState(false);

  const bufferText =
    backend.replayBufferActive === true
      ? "replay buffer active"
      : backend.replayBufferActive === false
        ? "replay buffer inactive"
        : "replay buffer —";

  const metaText =
    backend.status === "connected"
      ? `JCForge v0.1 · attached to ${backendLabel} · ${bufferText}`
      : backend.status === "connecting"
        ? `JCForge v0.1 · connecting to ${backendLabel}…`
        : backend.status === "error"
          ? `JCForge v0.1 · ${backendLabel} connection failed`
          : `JCForge v0.1 · not attached to ${backendLabel}`;

  const canRetry =
    isObs &&
    (backend.status === "disconnected" || backend.status === "error");

  return (
    <div className="title-bar" data-tauri-drag-region>
      <div className="title-bar__brand">
        <img className="title-bar__logo" src={logo} alt="" />
        <span className="title-bar__name">JCForge</span>
      </div>
      <span className="title-bar__meta">{metaText}</span>
      <span className="title-bar__license">
        {license.isLicensed
          ? "LICENSED"
          : license.trialMsRemaining !== null
            ? `TRIAL · ${formatTrialRemaining(license.trialMsRemaining)}`
            : null}
      </span>
      <div className="title-bar__spacer" />
      <div className="title-bar__status-wrap">
        <div
          className={
            "title-bar__status" +
            (backend.status === "connected"
              ? " title-bar__status--connected"
              : "") +
            (canRetry ? " title-bar__status--clickable" : "")
          }
          title={backend.error ?? undefined}
          onClick={() => {
            if (!canRetry) return;
            setShowPasswordField((v) => !v);
          }}
        >
          <span
            className={
              "title-bar__status-dot" +
              (backend.status === "connected"
                ? " title-bar__status-dot--live"
                : "")
            }
          />
          <span className="title-bar__status-text">
            {backend.status === "connected"
              ? `${backendLabel.toUpperCase()} CONNECTED`
              : backend.status === "connecting"
                ? "CONNECTING"
                : backend.status === "error"
                  ? canRetry
                    ? "RETRY CONNECTION"
                    : `${backendLabel.toUpperCase()} ERROR`
                  : `${backendLabel.toUpperCase()} DISCONNECTED`}
          </span>
        </div>
        {isObs && (
          <ObsRetryPopover
            show={showPasswordField && canRetry}
            onClose={() => setShowPasswordField(false)}
          />
        )}
      </div>
      <div className="title-bar__controls">
        <button
          className="title-bar__control"
          aria-label="Minimize"
          onClick={() => appWindow.minimize()}
        >
          <Minus size={13} />
        </button>
        <button
          className="title-bar__control"
          aria-label="Maximize"
          onClick={() => appWindow.toggleMaximize()}
        >
          <Square size={11} />
        </button>
        <button
          className="title-bar__control title-bar__control--close"
          aria-label="Close"
          onClick={() => appWindow.close()}
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
