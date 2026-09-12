import { useState, type FormEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useSettings } from "../lib/settingsContext";
import {
  runAiEdit,
  exportAiClip,
  AiEditParseError,
  DEFAULT_STYLE_NOTES,
  type AiClipSuggestion,
} from "../lib/aiEdit";
import "./AiEdit.css";

type ExportState =
  | { status: "idle" }
  | { status: "exporting" }
  | { status: "done"; outputPath: string }
  | { status: "error"; message: string };

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}

export function AiEdit() {
  const settings = useSettings();
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiKeySaved, setApiKeySaved] = useState(false);
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [styleNotes, setStyleNotes] = useState(DEFAULT_STYLE_NOTES);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clips, setClips] = useState<AiClipSuggestion[] | null>(null);
  const [rawResponse, setRawResponse] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [exportStates, setExportStates] = useState<Record<number, ExportState>>({});

  const saveApiKey = async (e: FormEvent) => {
    e.preventDefault();
    if (!apiKeyDraft.trim()) return;
    await settings.setGeminiApiKey(apiKeyDraft);
    setApiKeyDraft("");
    setApiKeySaved(true);
    setTimeout(() => setApiKeySaved(false), 2000);
  };

  const pickVideo = async () => {
    const selected = await open({
      multiple: false,
      filters: [
        { name: "Video", extensions: ["mp4", "mkv", "mov", "flv", "avi", "webm"] },
      ],
    });
    if (typeof selected === "string") setVideoPath(selected);
  };

  const analyze = async () => {
    if (!videoPath || !settings.geminiApiKey) return;
    setRunning(true);
    setError(null);
    setClips(null);
    setRawResponse(null);
    try {
      const result = await runAiEdit(videoPath, settings.geminiApiKey, styleNotes);
      setClips(result.clips);
      setRawResponse(result.rawResponse);
      setExportStates({});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (err instanceof AiEditParseError) {
        setRawResponse(err.rawResponse);
      }
    } finally {
      setRunning(false);
    }
  };

  const exportClip = async (index: number, clip: AiClipSuggestion) => {
    if (!videoPath) return;
    setExportStates((s) => ({ ...s, [index]: { status: "exporting" } }));
    const result = await exportAiClip(videoPath, clip);
    setExportStates((s) => ({
      ...s,
      [index]: result.ok
        ? { status: "done", outputPath: result.outputPath }
        : { status: "error", message: result.error ?? "see console" },
    }));
  };

  const canAnalyze = !!videoPath && !!settings.geminiApiKey && !running;

  return (
    <div className="ai-edit-screen">
      <div>
        <h1 className="ai-edit-screen__title">AI edit</h1>
        <p className="ai-edit-screen__subtitle">
          Hand a full stream VOD to Google Gemini and get back suggested clip
          ranges, captions, and effect points. This calls Google's API
          directly with your own key - JCForge never sees or bills for usage.
        </p>
      </div>

      <div className="ai-edit-screen__card">
        <div className="ai-edit-screen__card-header">
          <span className="ai-edit-screen__card-title">Gemini API key</span>
          <span
            className={
              "ai-edit-screen__badge" +
              (settings.geminiApiKey ? " ai-edit-screen__badge--connected" : "")
            }
          >
            {settings.geminiApiKey ? "SET" : "NOT SET"}
          </span>
        </div>
        <div className="ai-edit-screen__mono ai-edit-screen__mono--dim">
          Get a key from Google AI Studio (aistudio.google.com/apikey). Stored
          locally, sent only to generativelanguage.googleapis.com.
        </div>
        <form className="ai-edit-screen__form" onSubmit={saveApiKey}>
          <input
            className="ai-edit-screen__input"
            type="password"
            placeholder={settings.geminiApiKey ? "key saved — enter to replace" : "Gemini API key"}
            value={apiKeyDraft}
            onChange={(e) => setApiKeyDraft(e.target.value)}
          />
          <button type="submit" className="ai-edit-screen__submit">
            {apiKeySaved ? "Saved" : "Save"}
          </button>
        </form>
      </div>

      <div className="ai-edit-screen__card">
        <div className="ai-edit-screen__card-header">
          <span className="ai-edit-screen__card-title">Source video</span>
        </div>
        <div className="ai-edit-screen__row">
          <button type="button" className="ai-edit-screen__submit" onClick={pickVideo}>
            Choose file…
          </button>
          <span className="ai-edit-screen__mono ai-edit-screen__mono--dim">
            {videoPath ?? "no file selected"}
          </span>
        </div>
      </div>

      <div className="ai-edit-screen__card">
        <div className="ai-edit-screen__card-header">
          <span className="ai-edit-screen__card-title">Style notes</span>
        </div>
        <textarea
          className="ai-edit-screen__textarea"
          rows={4}
          value={styleNotes}
          onChange={(e) => setStyleNotes(e.target.value)}
        />
      </div>

      <button
        type="button"
        className="ai-edit-screen__analyze"
        disabled={!canAnalyze}
        onClick={analyze}
      >
        {running ? "Analyzing… this can take a few minutes for a long VOD" : "Analyze"}
      </button>

      {error && (
        <div className="ai-edit-screen__error">
          {error}
          {rawResponse && (
            <button
              type="button"
              className="ai-edit-screen__raw-toggle"
              onClick={() => setShowRaw((v) => !v)}
            >
              {showRaw ? "hide raw response" : "show raw response"}
            </button>
          )}
        </div>
      )}

      {rawResponse && showRaw && (
        <pre className="ai-edit-screen__raw">{rawResponse}</pre>
      )}

      {clips && (
        <div className="ai-edit-screen__results">
          {clips.length === 0 && (
            <div className="ai-edit-screen__mono ai-edit-screen__mono--dim">
              Gemini didn't surface any clips it was confident about.
            </div>
          )}
          {clips.map((clip, i) => {
            const exportState = exportStates[i] ?? { status: "idle" as const };
            return (
            <div className="ai-edit-screen__clip" key={i}>
              <div className="ai-edit-screen__clip-header">
                <span className="ai-edit-screen__clip-time">
                  {formatTime(clip.startSeconds)} – {formatTime(clip.endSeconds)}
                </span>
                <div className="ai-edit-screen__spacer" />
                <button
                  type="button"
                  className="ai-edit-screen__submit"
                  disabled={exportState.status === "exporting"}
                  onClick={() => exportClip(i, clip)}
                >
                  {exportState.status === "exporting" ? "Exporting…" : "Export"}
                </button>
              </div>
              <div className="ai-edit-screen__clip-reason">{clip.reason}</div>
              {clip.hook && (
                <div className="ai-edit-screen__clip-section">
                  <span className="ai-edit-screen__clip-section-label">Hook</span>
                  <div className="ai-edit-screen__mono">{clip.hook}</div>
                </div>
              )}
              {clip.editingStyle && (
                <div className="ai-edit-screen__clip-section">
                  <span className="ai-edit-screen__clip-section-label">Editing style</span>
                  <div className="ai-edit-screen__mono">{clip.editingStyle}</div>
                </div>
              )}
              {clip.captions?.length > 0 && (
                <div className="ai-edit-screen__clip-section">
                  <span className="ai-edit-screen__clip-section-label">Captions</span>
                  {clip.captions.map((c, j) => (
                    <div className="ai-edit-screen__mono" key={j}>
                      {c.emphasis === "high" && (
                        <span className="ai-edit-screen__emphasis-tag">EMPHASIS</span>
                      )}
                      {formatTime(c.start)}–{formatTime(c.end)}: {c.text}
                    </div>
                  ))}
                </div>
              )}
              {clip.effects?.length > 0 && (
                <div className="ai-edit-screen__clip-section">
                  <span className="ai-edit-screen__clip-section-label">Effects</span>
                  {clip.effects.map((e, j) => (
                    <div className="ai-edit-screen__mono" key={j}>
                      {formatTime(e.time)}: {e.type}
                      {e.intensity ? ` (${e.intensity})` : ""}
                      {e.reason ? ` — ${e.reason}` : ""}
                    </div>
                  ))}
                </div>
              )}
              {clip.virality && (
                <div className="ai-edit-screen__clip-section">
                  <span className="ai-edit-screen__clip-section-label">
                    Virality score — {clip.virality.overall}/10 overall
                  </span>
                  <div className="ai-edit-screen__score-grid">
                    {(
                      [
                        ["Hook", clip.virality.hook],
                        ["Entertainment", clip.virality.entertainment],
                        ["Pacing", clip.virality.pacing],
                        ["Emotional impact", clip.virality.emotionalImpact],
                        ["Comedy", clip.virality.comedy],
                        ["Rewatch", clip.virality.rewatchPotential],
                        ["Shareability", clip.virality.shareability],
                        ["Comments", clip.virality.commentPotential],
                      ] as const
                    ).map(([label, score]) => (
                      <div className="ai-edit-screen__score" key={label}>
                        <span className="ai-edit-screen__score-value">{score}</span>
                        <span className="ai-edit-screen__score-label">{label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {clip.weaknesses && clip.weaknesses.length > 0 && (
                <div className="ai-edit-screen__clip-section">
                  <span className="ai-edit-screen__clip-section-label">Weaknesses</span>
                  {clip.weaknesses.map((w, j) => (
                    <div className="ai-edit-screen__mono" key={j}>
                      • {w}
                    </div>
                  ))}
                </div>
              )}
              {((clip.soundEffects && clip.soundEffects.length > 0) ||
                (clip.memes && clip.memes.length > 0) ||
                clip.music) && (
                <div className="ai-edit-screen__clip-section">
                  <span className="ai-edit-screen__clip-section-label">
                    Manual additions — not rendered automatically
                  </span>
                  {clip.soundEffects?.map((s, j) => (
                    <div className="ai-edit-screen__mono" key={`sfx-${j}`}>
                      {formatTime(s.time)}: SFX "{s.effect}"
                      {s.intensity ? ` (${s.intensity})` : ""} — {s.why}
                    </div>
                  ))}
                  {clip.memes?.map((m, j) => (
                    <div className="ai-edit-screen__mono" key={`meme-${j}`}>
                      {m.where}: meme "{m.meme}" — {m.why}
                    </div>
                  ))}
                  {clip.music && (
                    <div className="ai-edit-screen__mono">
                      Music: {clip.music.type} — {clip.music.why}
                    </div>
                  )}
                </div>
              )}
              {exportState.status === "done" && (
                <div className="ai-edit-screen__export-result">
                  <span className="ai-edit-screen__mono">{exportState.outputPath}</span>
                  <button
                    type="button"
                    className="ai-edit-screen__raw-toggle"
                    onClick={() => revealItemInDir(exportState.outputPath)}
                  >
                    Reveal in folder
                  </button>
                </div>
              )}
              {exportState.status === "error" && (
                <div className="ai-edit-screen__export-result ai-edit-screen__export-result--error">
                  Export failed — {exportState.message}
                </div>
              )}
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
