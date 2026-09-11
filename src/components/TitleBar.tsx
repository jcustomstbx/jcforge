import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";
import { useObs } from "../lib/obs";
import "./TitleBar.css";

const appWindow = getCurrentWindow();

export function TitleBar() {
  const obs = useObs();

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

  return (
    <div className="title-bar" data-tauri-drag-region>
      <div className="title-bar__brand">
        <div className="title-bar__logo" />
        <span className="title-bar__name">JCForge</span>
      </div>
      <span className="title-bar__meta">{metaText}</span>
      <div className="title-bar__spacer" />
      <div
        className={
          "title-bar__status" +
          (obs.status === "connected" ? " title-bar__status--connected" : "") +
          (obs.status === "disconnected" || obs.status === "error"
            ? " title-bar__status--clickable"
            : "")
        }
        title={obs.error ?? undefined}
        onClick={() => {
          if (obs.status === "disconnected" || obs.status === "error") {
            obs.connect();
          }
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
