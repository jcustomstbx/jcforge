import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useState } from "react";
import "./ObsDock.css";

async function getDockWindow() {
  return WebviewWindow.getByLabel("dock");
}

export function ObsDock() {
  const [busy, setBusy] = useState(false);

  const openDock = async () => {
    setBusy(true);
    try {
      const win = await getDockWindow();
      await win?.show();
      await win?.setFocus();
    } finally {
      setBusy(false);
    }
  };

  const hideDock = async () => {
    setBusy(true);
    try {
      const win = await getDockWindow();
      await win?.hide();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="obs-dock-screen">
      <div>
        <h1 className="obs-dock-screen__title">OBS dock</h1>
        <p className="obs-dock-screen__subtitle">
          A small floating panel you drag over your game while you play - one
          decision at a time, no lists, nothing that requires reading a
          sentence. It's a separate always-on-top window, not literally
          registered inside OBS's own dock UI, but it does the same job.
        </p>
      </div>
      <div className="obs-dock-screen__notes">
        <div className="obs-dock-screen__note">
          <div className="obs-dock-screen__note-title">
            One decision at a time
          </div>
          <div className="obs-dock-screen__note-body">
            A proposal appears, you keep or skip. Nothing else to read while
            you play.
          </div>
        </div>
        <div className="obs-dock-screen__note">
          <div className="obs-dock-screen__note-title">Hotkey parity</div>
          <div className="obs-dock-screen__note-body">
            F9 still marks manually from anywhere, dock included.
          </div>
        </div>
        <div className="obs-dock-screen__note">
          <div className="obs-dock-screen__note-title">Reads live state</div>
          <div className="obs-dock-screen__note-body">
            The dock mirrors this window's detection signals in real time -
            it doesn't run its own separate detection.
          </div>
        </div>
      </div>
      <div className="obs-dock-screen__actions">
        <button
          className="obs-dock-screen__open"
          disabled={busy}
          onClick={openDock}
        >
          Open dock
        </button>
        <button
          className="obs-dock-screen__hide"
          disabled={busy}
          onClick={hideDock}
        >
          Hide dock
        </button>
      </div>
    </div>
  );
}
