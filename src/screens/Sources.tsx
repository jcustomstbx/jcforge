import { useState, type FormEvent } from "react";
import { useObs } from "../lib/obs";
import { useSettings } from "../lib/settingsContext";
import "./Sources.css";

export function Sources() {
  const obs = useObs();
  const settings = useSettings();
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(false);

  const channel = settings.twitchChannel;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    await settings.setTwitchChannel(draft);
    setDraft("");
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="sources-screen">
      <div>
        <h1 className="sources-screen__title">Sources</h1>
        <p className="sources-screen__subtitle">
          JCForge drives OBS's replay buffer to save clips at full quality,
          straight to your own drive. Twitch chat is optional context for
          detection.
        </p>
      </div>

      <div className="sources-screen__card">
        <div className="sources-screen__card-header">
          <span className="sources-screen__card-title">OBS WebSocket</span>
          <span
            className={
              "sources-screen__badge" +
              (obs.status === "connected"
                ? " sources-screen__badge--connected"
                : "")
            }
          >
            {obs.status === "connected" ? "CONNECTED" : obs.status.toUpperCase()}
          </span>
        </div>
        <div className="sources-screen__mono">{obs.url}</div>
        <div className="sources-screen__mono sources-screen__mono--dim">
          {obs.status === "connected"
            ? `OBS ${obs.obsVersion} · websocket ${obs.websocketVersion}`
            : "connect from the title bar"}
        </div>
      </div>

      <div className="sources-screen__card">
        <div className="sources-screen__card-header">
          <span className="sources-screen__card-title">Twitch chat</span>
          <span
            className={
              "sources-screen__badge" +
              (channel ? " sources-screen__badge--connected" : "")
            }
          >
            {channel ? "CONFIGURED" : "NOT SET"}
          </span>
        </div>
        <div className="sources-screen__mono sources-screen__mono--dim">
          Anonymous read-only IRC connection - no login needed, only used to
          score chat activity for detection.
        </div>
        <form className="sources-screen__form" onSubmit={submit}>
          <input
            className="sources-screen__input"
            placeholder={channel ?? "your twitch channel name"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" className="sources-screen__submit">
            {saved ? "Saved" : "Save"}
          </button>
        </form>
      </div>
    </div>
  );
}
