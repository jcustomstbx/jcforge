import { getCurrentWindow } from "@tauri-apps/api/window";
import { Eye, EyeOff, Minus, Square, X } from "lucide-react";
import { useRef, useState } from "react";
import { useObs } from "../lib/obs";
import "./TitleBar.css";

const appWindow = getCurrentWindow();

export function TitleBar() {
  const obs = useObs();
  const [showPasswordField, setShowPasswordField] = useState(false);
  const [password, setPassword] = useState("");
  const [revealPassword, setRevealPassword] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const bufferText =
    obs.replayBufferActive === true
      ? "replay buffer active"
      : obs.replayBufferActive === false
        ? "replay buffer inactive"
        : "replay buffer —";

  const metaText =
    obs.status === "connected"
      ? `JCForge v0.1 · attached to OBS ${obs.obsVersion ?? ""} · ${bufferText}`
      : obs.status === "connecting"
        ? "JCForge v0.1 · connecting to OBS…"
        : obs.status === "error"
          ? "JCForge v0.1 · OBS connection failed"
          : "JCForge v0.1 · not attached to OBS";

  const canRetry = obs.status === "disconnected" || obs.status === "error";

  const submitPassword = () => {
    const trimmed = password.trim();
    obs.connect(undefined, trimmed || undefined);
    setShowPasswordField(false);
  };

  return (
    <div className="title-bar" data-tauri-drag-region>
      <div className="title-bar__brand">
        <div className="title-bar__logo" />
        <span className="title-bar__name">JCForge</span>
      </div>
      <span className="title-bar__meta">{metaText}</span>
      <div className="title-bar__spacer" />
      <div className="title-bar__status-wrap">
        <div
          className={
            "title-bar__status" +
            (obs.status === "connected"
              ? " title-bar__status--connected"
              : "") +
            (canRetry ? " title-bar__status--clickable" : "")
          }
          title={obs.error ?? undefined}
          onClick={() => {
            if (!canRetry) return;
            setShowPasswordField((v) => !v);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
        >
          <span
            className={
              "title-bar__status-dot" +
              (obs.status === "connected"
                ? " title-bar__status-dot--live"
                : "")
            }
          />
          <span className="title-bar__status-text">
            {obs.status === "connected"
              ? "OBS CONNECTED"
              : obs.status === "connecting"
                ? "CONNECTING"
                : obs.status === "error"
                  ? "RETRY CONNECTION"
                  : "OBS DISCONNECTED"}
          </span>
        </div>
        {showPasswordField && canRetry && (
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
                  if (e.key === "Escape") setShowPasswordField(false);
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
              <button
                className="title-bar__password-submit"
                onClick={submitPassword}
              >
                Connect
              </button>
            </div>
            {obs.error && (
              <div className="title-bar__password-error">{obs.error}</div>
            )}
          </div>
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
