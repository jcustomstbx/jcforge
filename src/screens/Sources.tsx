import { useState, type FormEvent } from "react";
import { useObs } from "../lib/obs";
import { useBackend } from "../lib/backend";
import { useSettings, type RecordingBackendId } from "../lib/settingsContext";
import "./Sources.css";

// OBS-specific connection details, split into its own component so it only
// mounts (and only calls useObs()) while OBS is the active backend -
// Streamlabs has no ObsProvider/ObsContext to read from.
function ObsExtra() {
  const obs = useObs();
  return (
    <div className="sources-screen__mono sources-screen__mono--dim">
      {obs.status === "connected"
        ? `OBS ${obs.obsVersion} · websocket ${obs.websocketVersion}`
        : `${obs.url} · connect from the title bar`}
    </div>
  );
}

export function Sources() {
  const backend = useBackend();
  const settings = useSettings();
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const [folderDraft, setFolderDraft] = useState("");
  const [streamlabsSaved, setStreamlabsSaved] = useState(false);

  const channel = settings.twitchChannel;
  const isObs = settings.recordingBackend !== "streamlabs";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    await settings.setTwitchChannel(draft);
    setDraft("");
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const submitStreamlabs = async (e: FormEvent) => {
    e.preventDefault();
    if (tokenDraft.trim()) await settings.setStreamlabsToken(tokenDraft);
    if (folderDraft.trim())
      await settings.setStreamlabsReplayFolder(folderDraft);
    setTokenDraft("");
    setFolderDraft("");
    setStreamlabsSaved(true);
    setTimeout(() => setStreamlabsSaved(false), 2000);
  };

  const selectBackend = (id: RecordingBackendId) => {
    if (id !== settings.recordingBackend) settings.setRecordingBackend(id);
  };

  return (
    <div className="sources-screen">
      <div>
        <h1 className="sources-screen__title">Sources</h1>
        <p className="sources-screen__subtitle">
          JCForge drives your recording software's replay buffer to save
          clips at full quality, straight to your own drive. Twitch chat is
          optional context for detection.
        </p>
      </div>

      <div className="sources-screen__card">
        <div className="sources-screen__card-header">
          <span className="sources-screen__card-title">Recording backend</span>
        </div>
        <div className="sources-screen__backend-toggle">
          <button
            type="button"
            className={
              "sources-screen__backend-option" +
              (isObs ? " sources-screen__backend-option--active" : "")
            }
            onClick={() => selectBackend("obs")}
          >
            OBS
          </button>
          <button
            type="button"
            className={
              "sources-screen__backend-option" +
              (!isObs ? " sources-screen__backend-option--active" : "")
            }
            onClick={() => selectBackend("streamlabs")}
          >
            Streamlabs
          </button>
        </div>
        <div className="sources-screen__mono sources-screen__mono--dim">
          {isObs
            ? "OBS's InputVolumeMeters event provides mic level directly."
            : "Streamlabs has no live mic-level API, so JCForge captures the mic directly."}
        </div>
      </div>

      <div className="sources-screen__card">
        <div className="sources-screen__card-header">
          <span className="sources-screen__card-title">
            {isObs ? "OBS WebSocket" : "Streamlabs remote control"}
          </span>
          <span
            className={
              "sources-screen__badge" +
              (backend.status === "connected"
                ? " sources-screen__badge--connected"
                : "")
            }
          >
            {backend.status === "connected"
              ? "CONNECTED"
              : backend.status.toUpperCase()}
          </span>
        </div>
        {isObs ? (
          <ObsExtra />
        ) : (
          <>
            <div className="sources-screen__mono sources-screen__mono--dim">
              Get your remote-control token from Streamlabs Settings → Mobile
              (not "Remote Control" - Streamlabs moved it there and their own
              docs are stale on this).
            </div>
            <form
              className="sources-screen__form sources-screen__form--stacked"
              onSubmit={submitStreamlabs}
            >
              <input
                className="sources-screen__input"
                placeholder={
                  settings.streamlabsToken
                    ? "token saved — enter to replace"
                    : "remote control token"
                }
                value={tokenDraft}
                onChange={(e) => setTokenDraft(e.target.value)}
              />
              <input
                className="sources-screen__input"
                placeholder={
                  settings.streamlabsReplayFolder ??
                  "replay buffer output folder"
                }
                value={folderDraft}
                onChange={(e) => setFolderDraft(e.target.value)}
              />
              <button type="submit" className="sources-screen__submit">
                {streamlabsSaved ? "Saved" : "Save"}
              </button>
            </form>
            {backend.error && (
              <div className="sources-screen__mono sources-screen__mono--dim">
                {backend.error}
              </div>
            )}
          </>
        )}
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
