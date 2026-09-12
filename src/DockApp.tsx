import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import logo from "./assets/logo.png";
import {
  DOCK_ACTION_EVENT,
  DOCK_STATE_EVENT,
  type DockState,
} from "./lib/dockProtocol";
import "./DockApp.css";

const appWindow = getCurrentWindow();
const FLASH_DURATION_MS = 1600;

const EMPTY_STATE: DockState = {
  obsStatus: "disconnected",
  replayBufferActive: null,
  voiceScore: 0,
  chatScore: 0,
  motionScore: 0,
  voiceWave: [],
  proposal: null,
  lastResolution: null,
  keptCount: 0,
  skippedCount: 0,
};

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <div className="dock-meter">
      <div className="dock-meter__row">
        <span>{label}</span>
        <span className="dock-meter__value">{value.toFixed(2)}</span>
      </div>
      <div className="dock-meter__track">
        <div
          className={
            "dock-meter__fill" + (value > 0.8 ? " dock-meter__fill--alert" : "")
          }
          style={{ width: `${Math.round(Math.min(1, value) * 100)}%` }}
        />
      </div>
    </div>
  );
}

export function DockApp() {
  const [state, setState] = useState<DockState>(EMPTY_STATE);
  const [flash, setFlash] = useState<"kept" | "skipped" | null>(null);
  const lastSeenResolutionAt = useRef<number | null>(null);

  useEffect(() => {
    const unlisten = listen<DockState>(DOCK_STATE_EVENT, (event) => {
      setState(event.payload);
      const resolution = event.payload.lastResolution;
      if (resolution && resolution.at !== lastSeenResolutionAt.current) {
        lastSeenResolutionAt.current = resolution.at;
        setFlash(resolution.type);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // A click (or an auto-approved capture) used to just silently revert to
  // "Watching for moments…" with no confirmation, which made it genuinely
  // hard to tell whether it registered - flash a brief confirmation instead.
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), FLASH_DURATION_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  const act = (action: "keep" | "skip") => {
    if (!state.proposal) return;
    emit(DOCK_ACTION_EVENT, { action, clipId: state.proposal.clipId });
    setState((s) => ({ ...s, proposal: null }));
  };

  const connected = state.obsStatus === "connected";

  return (
    <div className="dock-app">
      <div className="dock-app__titlebar" data-tauri-drag-region>
        <img className="dock-app__logo" src={logo} alt="" />
        <span className="dock-app__name">JCForge</span>
        <div className="dock-app__spacer" />
        <button
          className="dock-app__close"
          aria-label="Hide dock"
          onClick={() => appWindow.hide()}
        >
          <X size={12} />
        </button>
      </div>

      <div className="dock-app__body">
        {!connected && (
          <div className="dock-app__disconnected">Not attached to OBS</div>
        )}

        <div
          className={
            "dock-app__alert" +
            (state.proposal ? " dock-app__alert--active" : "") +
            (flash ? ` dock-app__alert--${flash}` : "")
          }
        >
          <span className="dock-app__alert-dot" />
          <span className="dock-app__alert-text">
            {flash
              ? flash === "kept"
                ? "Kept ✓"
                : "Skipped"
              : state.proposal
                ? "Moment detected"
                : "Watching for moments…"}
          </span>
          <div className="dock-app__spacer" />
          {state.proposal && !flash && (
            <span className="dock-app__alert-score">
              {state.proposal.score.toFixed(2)}
            </span>
          )}
        </div>

        <div className="dock-app__actions">
          <button
            className="dock-app__keep"
            disabled={!state.proposal}
            onClick={() => act("keep")}
          >
            Keep
          </button>
          <button
            className="dock-app__skip"
            disabled={!state.proposal}
            onClick={() => act("skip")}
          >
            Skip
          </button>
        </div>

        <div className="dock-app__wave">
          {Array.from({ length: 34 }).map((_, i) => {
            const v = state.voiceWave[state.voiceWave.length - 34 + i] ?? 0;
            return (
              <div
                key={i}
                className="dock-app__wave-bar"
                style={{ height: `${Math.max(6, v * 100)}%` }}
              />
            );
          })}
        </div>

        <div className="dock-app__meters">
          <Meter label="Voice" value={state.voiceScore} />
          <Meter label="Motion" value={state.motionScore} />
          <Meter label="Chat" value={state.chatScore} />
        </div>

        <div className="dock-app__footer">
          <span>
            {state.keptCount} kept · {state.skippedCount} skipped
          </span>
          <span className="dock-app__footer-hint">F9 mark</span>
        </div>
      </div>
    </div>
  );
}
