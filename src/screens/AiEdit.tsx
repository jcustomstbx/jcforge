import { useEffect, useRef, useState, type FormEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useSettings } from "../lib/settingsContext";
import {
  runAiEdit,
  exportAiClip,
  generateClipThumbnail,
  AiEditParseError,
  DEFAULT_STYLE_NOTES,
  type AiClipSuggestion,
  type SfxCatalogEntry,
  type MusicCatalogEntry,
  type VfxCatalogEntry,
} from "../lib/aiEdit";
import { runClaudeOneShotEdit } from "../lib/claudeEdit";
import {
  listSfxLibrary,
  importSfxFiles,
  removeSfxEntry,
  type SfxEntry,
} from "../lib/sfxLibrary";
import {
  listMusicLibrary,
  importMusicFiles,
  removeMusicEntry,
  type MusicEntry,
} from "../lib/musicLibrary";
import {
  listVfxLibrary,
  importVfxFiles,
  removeVfxEntry,
  type VfxEntry,
} from "../lib/vfxLibrary";
import "./AiEdit.css";

type ExportState =
  | { status: "idle" }
  | { status: "exporting" }
  | { status: "done"; outputPath: string }
  | { status: "error"; message: string };

type ThumbnailState =
  | { status: "loading" }
  | { status: "ready"; path: string }
  | { status: "error" };

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
  const [elevenLabsKeyDraft, setElevenLabsKeyDraft] = useState("");
  const [elevenLabsKeySaved, setElevenLabsKeySaved] = useState(false);
  const [anthropicKeyDraft, setAnthropicKeyDraft] = useState("");
  const [anthropicKeySaved, setAnthropicKeySaved] = useState(false);
  const [provider, setProvider] = useState<"gemini" | "claude">("gemini");
  const [claudeProgress, setClaudeProgress] = useState<string | null>(null);
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [styleNotes, setStyleNotes] = useState(DEFAULT_STYLE_NOTES);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clips, setClips] = useState<AiClipSuggestion[] | null>(null);
  const [rawResponse, setRawResponse] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [exportStates, setExportStates] = useState<Record<number, ExportState>>({});
  const [thumbnails, setThumbnails] = useState<Record<number, ThumbnailState>>({});
  const thumbnailsRef = useRef(thumbnails);
  thumbnailsRef.current = thumbnails;
  const [sfxLibrary, setSfxLibrary] = useState<SfxEntry[]>([]);
  const [sfxImporting, setSfxImporting] = useState(false);
  const [musicLibrary, setMusicLibrary] = useState<MusicEntry[]>([]);
  const [musicImporting, setMusicImporting] = useState(false);
  const [vfxLibrary, setVfxLibrary] = useState<VfxEntry[]>([]);
  const [vfxImporting, setVfxImporting] = useState(false);

  const refreshSfxLibrary = async () => {
    setSfxLibrary(await listSfxLibrary());
  };
  const refreshMusicLibrary = async () => {
    setMusicLibrary(await listMusicLibrary());
  };
  const refreshVfxLibrary = async () => {
    setVfxLibrary(await listVfxLibrary());
  };

  useEffect(() => {
    refreshSfxLibrary();
    refreshMusicLibrary();
    refreshVfxLibrary();
    // Leaving the screen with thumbnails still loaded (e.g. navigating away
    // mid-review) previously left those temp JPGs on disk permanently -
    // the ref (not the state closure) so this sees whatever was last set.
    return () => {
      deleteThumbnailFiles(thumbnailsRef.current);
    };
  }, []);

  const importSfx = async () => {
    const selected = await open({
      multiple: true,
      filters: [{ name: "Audio", extensions: ["wav", "mp3", "ogg", "flac"] }],
    });
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    if (paths.length === 0) return;
    setSfxImporting(true);
    try {
      await importSfxFiles(paths);
      await refreshSfxLibrary();
    } finally {
      setSfxImporting(false);
    }
  };

  const deleteSfx = async (entry: SfxEntry) => {
    await removeSfxEntry(entry);
    await refreshSfxLibrary();
  };

  const importMusic = async () => {
    const selected = await open({
      multiple: true,
      filters: [{ name: "Audio", extensions: ["wav", "mp3", "ogg", "flac"] }],
    });
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    if (paths.length === 0) return;
    setMusicImporting(true);
    try {
      await importMusicFiles(paths);
      await refreshMusicLibrary();
    } finally {
      setMusicImporting(false);
    }
  };

  const deleteMusic = async (entry: MusicEntry) => {
    await removeMusicEntry(entry);
    await refreshMusicLibrary();
  };

  const importVfx = async () => {
    const selected = await open({
      multiple: true,
      filters: [{ name: "Video", extensions: ["mp4", "mov", "webm", "mkv"] }],
    });
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    if (paths.length === 0) return;
    setVfxImporting(true);
    try {
      await importVfxFiles(paths);
      await refreshVfxLibrary();
    } finally {
      setVfxImporting(false);
    }
  };

  const deleteVfx = async (entry: VfxEntry) => {
    await removeVfxEntry(entry);
    await refreshVfxLibrary();
  };

  const saveApiKey = async (e: FormEvent) => {
    e.preventDefault();
    if (!apiKeyDraft.trim()) return;
    await settings.setGeminiApiKey(apiKeyDraft);
    setApiKeyDraft("");
    setApiKeySaved(true);
    setTimeout(() => setApiKeySaved(false), 2000);
  };

  const saveElevenLabsKey = async (e: FormEvent) => {
    e.preventDefault();
    if (!elevenLabsKeyDraft.trim()) return;
    await settings.setElevenLabsApiKey(elevenLabsKeyDraft);
    setElevenLabsKeyDraft("");
    setElevenLabsKeySaved(true);
    setTimeout(() => setElevenLabsKeySaved(false), 2000);
  };

  const saveAnthropicKey = async (e: FormEvent) => {
    e.preventDefault();
    if (!anthropicKeyDraft.trim()) return;
    await settings.setAnthropicApiKey(anthropicKeyDraft);
    setAnthropicKeyDraft("");
    setAnthropicKeySaved(true);
    setTimeout(() => setAnthropicKeySaved(false), 2000);
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

  // Sequential rather than parallel - each is a full ffmpeg seek+decode
  // against the same (often large) source file, and this is a
  // nice-to-have preview, not something worth contending disk/CPU for.
  const loadThumbnails = async (videoPath: string, clips: AiClipSuggestion[]) => {
    for (let i = 0; i < clips.length; i++) {
      setThumbnails((t) => ({ ...t, [i]: { status: "loading" } }));
      try {
        const path = await generateClipThumbnail(videoPath, clips[i].startSeconds);
        setThumbnails((t) => ({ ...t, [i]: { status: "ready", path } }));
      } catch {
        setThumbnails((t) => ({ ...t, [i]: { status: "error" } }));
      }
    }
  };

  // Each thumbnail is a real temp file on disk (see generateClipThumbnail) -
  // discarding the in-memory path on a fresh analysis previously just
  // leaked it forever, one JPG per suggested clip per "Analyze" click.
  const deleteThumbnailFiles = async (current: Record<number, ThumbnailState>) => {
    for (const t of Object.values(current)) {
      if (t.status === "ready") {
        await invoke("delete_file", { path: t.path }).catch(() => {});
      }
    }
  };

  const analyze = async () => {
    if (!videoPath) return;
    if (provider === "gemini" ? !settings.geminiApiKey : !settings.anthropicApiKey) return;
    setRunning(true);
    setError(null);
    setClips(null);
    setRawResponse(null);
    setClaudeProgress(null);
    try {
      const sfxCatalog: SfxCatalogEntry[] = sfxLibrary.map((s) => ({
        id: s.id,
        name: s.displayName,
        tags: s.tags,
      }));
      const musicCatalog: MusicCatalogEntry[] = musicLibrary.map((m) => ({
        id: m.id,
        name: m.displayName,
        tags: m.tags,
      }));
      const vfxCatalog: VfxCatalogEntry[] = vfxLibrary.map((v) => ({
        id: v.id,
        name: v.displayName,
        tags: v.tags,
      }));
      const result =
        provider === "gemini"
          ? await runAiEdit(
              videoPath,
              settings.geminiApiKey!,
              styleNotes,
              sfxCatalog,
              musicCatalog,
              vfxCatalog,
              !!settings.elevenLabsApiKey,
            )
          : await runClaudeOneShotEdit(
              videoPath,
              settings.anthropicApiKey!,
              styleNotes,
              sfxCatalog,
              musicCatalog,
              vfxCatalog,
              !!settings.elevenLabsApiKey,
              (msg) => setClaudeProgress(msg),
            );
      setClips(result.clips);
      setRawResponse(result.rawResponse);
      setExportStates({});
      await deleteThumbnailFiles(thumbnails);
      setThumbnails({});
      loadThumbnails(videoPath, result.clips);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (err instanceof AiEditParseError) {
        setRawResponse(err.rawResponse);
      }
    } finally {
      setRunning(false);
      setClaudeProgress(null);
    }
  };

  const exportClip = async (index: number, clip: AiClipSuggestion) => {
    if (!videoPath) return;
    setExportStates((s) => ({ ...s, [index]: { status: "exporting" } }));
    const result = await exportAiClip(
      videoPath,
      clip,
      sfxLibrary,
      musicLibrary,
      vfxLibrary,
      settings.elevenLabsApiKey ?? undefined,
    );
    setExportStates((s) => ({
      ...s,
      [index]: result.ok
        ? { status: "done", outputPath: result.outputPath }
        : { status: "error", message: result.error ?? "see console" },
    }));
  };

  const canAnalyze =
    !!videoPath &&
    !running &&
    (provider === "gemini" ? !!settings.geminiApiKey : !!settings.anthropicApiKey);

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
          <span className="ai-edit-screen__card-title">Claude API key (one-shot mode)</span>
          <span
            className={
              "ai-edit-screen__badge" +
              (settings.anthropicApiKey ? " ai-edit-screen__badge--connected" : "")
            }
          >
            {settings.anthropicApiKey ? "SET" : "OPTIONAL"}
          </span>
        </div>
        <div className="ai-edit-screen__mono ai-edit-screen__mono--dim">
          Optional alternative to Gemini. Claude has no native video
          ingestion, so this extracts still frames plus a full transcript
          and sends those in a single call instead - genuinely untested
          whether that's more or less accurate than Gemini watching the
          actual video. Your own Anthropic billing.
        </div>
        <form className="ai-edit-screen__form" onSubmit={saveAnthropicKey}>
          <input
            className="ai-edit-screen__input"
            type="password"
            placeholder={
              settings.anthropicApiKey ? "key saved — enter to replace" : "Anthropic API key"
            }
            value={anthropicKeyDraft}
            onChange={(e) => setAnthropicKeyDraft(e.target.value)}
          />
          <button type="submit" className="ai-edit-screen__submit">
            {anthropicKeySaved ? "Saved" : "Save"}
          </button>
        </form>
        <div className="ai-edit-screen__row" style={{ marginTop: "0.5rem", gap: "1rem" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer" }}>
            <input
              type="radio"
              name="ai-provider"
              checked={provider === "gemini"}
              onChange={() => setProvider("gemini")}
            />
            <span className="ai-edit-screen__mono ai-edit-screen__mono--dim">Gemini (video)</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", cursor: "pointer" }}>
            <input
              type="radio"
              name="ai-provider"
              checked={provider === "claude"}
              disabled={!settings.anthropicApiKey}
              onChange={() => setProvider("claude")}
            />
            <span className="ai-edit-screen__mono ai-edit-screen__mono--dim">
              Claude (frames + transcript)
              {!settings.anthropicApiKey ? " - needs a key above" : ""}
            </span>
          </label>
        </div>
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
          <span className="ai-edit-screen__card-title">Sound library</span>
          <span className="ai-edit-screen__badge">{sfxLibrary.length} FILES</span>
        </div>
        <div className="ai-edit-screen__mono ai-edit-screen__mono--dim">
          Gemini picks sound effects from what's imported here and JCForge
          mixes them into the export automatically at the right timestamp.
        </div>
        <div className="ai-edit-screen__row">
          <button
            type="button"
            className="ai-edit-screen__submit"
            disabled={sfxImporting}
            onClick={importSfx}
          >
            {sfxImporting ? "Importing…" : "Import files…"}
          </button>
        </div>
        {sfxLibrary.length > 0 && (
          <div className="ai-edit-screen__sfx-list">
            {sfxLibrary.map((entry) => (
              <div className="ai-edit-screen__sfx-row" key={entry.id}>
                <span className="ai-edit-screen__sfx-name">{entry.displayName}</span>
                <span className="ai-edit-screen__sfx-tags">{entry.tags.join(", ")}</span>
                <button
                  type="button"
                  className="ai-edit-screen__raw-toggle"
                  onClick={() => deleteSfx(entry)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="ai-edit-screen__card">
        <div className="ai-edit-screen__card-header">
          <span className="ai-edit-screen__card-title">Music library</span>
          <span className="ai-edit-screen__badge">{musicLibrary.length} FILES</span>
        </div>
        <div className="ai-edit-screen__mono ai-edit-screen__mono--dim">
          Gemini picks a background track from what's imported here (or none)
          and JCForge loops and mixes it in, ducked under voice/game audio.
        </div>
        <div className="ai-edit-screen__row">
          <button
            type="button"
            className="ai-edit-screen__submit"
            disabled={musicImporting}
            onClick={importMusic}
          >
            {musicImporting ? "Importing…" : "Import files…"}
          </button>
        </div>
        {musicLibrary.length > 0 && (
          <div className="ai-edit-screen__sfx-list">
            {musicLibrary.map((entry) => (
              <div className="ai-edit-screen__sfx-row" key={entry.id}>
                <span className="ai-edit-screen__sfx-name">{entry.displayName}</span>
                <span className="ai-edit-screen__sfx-tags">{entry.tags.join(", ")}</span>
                <button
                  type="button"
                  className="ai-edit-screen__raw-toggle"
                  onClick={() => deleteMusic(entry)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="ai-edit-screen__card">
        <div className="ai-edit-screen__card-header">
          <span className="ai-edit-screen__card-title">VFX overlays</span>
          <span className="ai-edit-screen__badge">{vfxLibrary.length} FILES</span>
        </div>
        <div className="ai-edit-screen__mono ai-edit-screen__mono--dim">
          Transition/VFX clips (light leaks, glitch bursts, film burns) that
          Gemini can composite on top of a moment - a hard cut, a big
          reveal, a glitch-style surprise. Used sparingly, most clips get
          none. Import plain video files (light background = additive
          "screen" blend; a .mov/.webm with real transparency uses alpha
          blending instead).
        </div>
        <div className="ai-edit-screen__row">
          <button
            type="button"
            className="ai-edit-screen__submit"
            disabled={vfxImporting}
            onClick={importVfx}
          >
            {vfxImporting ? "Importing…" : "Import files…"}
          </button>
        </div>
        {vfxLibrary.length > 0 && (
          <div className="ai-edit-screen__sfx-list">
            {vfxLibrary.map((entry) => (
              <div className="ai-edit-screen__sfx-row" key={entry.id}>
                <span className="ai-edit-screen__sfx-name">{entry.displayName}</span>
                <span className="ai-edit-screen__sfx-tags">
                  {entry.tags.join(", ")} · {entry.blendMode}
                </span>
                <button
                  type="button"
                  className="ai-edit-screen__raw-toggle"
                  onClick={() => deleteVfx(entry)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="ai-edit-screen__card">
        <div className="ai-edit-screen__card-header">
          <span className="ai-edit-screen__card-title">AI-generated fallback (ElevenLabs)</span>
          <span
            className={
              "ai-edit-screen__badge" +
              (settings.elevenLabsApiKey ? " ai-edit-screen__badge--connected" : "")
            }
          >
            {settings.elevenLabsApiKey ? "SET" : "OPTIONAL"}
          </span>
        </div>
        <div className="ai-edit-screen__mono ai-edit-screen__mono--dim">
          Optional. When set, Gemini can generate a sound effect or music
          track on demand (your own ElevenLabs billing) for moments nothing
          in your imported libraries fits - the library is always tried
          first. Leave blank to only ever use what you've imported above.
        </div>
        <form className="ai-edit-screen__form" onSubmit={saveElevenLabsKey}>
          <input
            className="ai-edit-screen__input"
            type="password"
            placeholder={
              settings.elevenLabsApiKey ? "key saved — enter to replace" : "ElevenLabs API key"
            }
            value={elevenLabsKeyDraft}
            onChange={(e) => setElevenLabsKeyDraft(e.target.value)}
          />
          <button type="submit" className="ai-edit-screen__submit">
            {elevenLabsKeySaved ? "Saved" : "Save"}
          </button>
        </form>
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
        {running
          ? provider === "claude"
            ? claudeProgress ?? "Analyzing…"
            : "Analyzing… this can take a few minutes for a long VOD"
          : `Analyze (${provider === "claude" ? "Claude" : "Gemini"})`}
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
            const thumbnail = thumbnails[i] ?? { status: "loading" as const };
            return (
            <div className="ai-edit-screen__clip" key={i}>
              <div className="ai-edit-screen__clip-thumb">
                {thumbnail.status === "ready" && (
                  <img
                    className="ai-edit-screen__clip-thumb-img"
                    src={convertFileSrc(thumbnail.path)}
                    alt={`Frame at ${formatTime(clip.startSeconds)}`}
                  />
                )}
                {thumbnail.status === "loading" && (
                  <div className="ai-edit-screen__clip-thumb-placeholder">Loading preview…</div>
                )}
                {thumbnail.status === "error" && (
                  <div className="ai-edit-screen__clip-thumb-placeholder">Preview unavailable</div>
                )}
              </div>
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
              {clip.segments && clip.segments.length > 1 && (
                <div className="ai-edit-screen__clip-section">
                  <span className="ai-edit-screen__clip-section-label">
                    Recut — {clip.segments.length} segments
                  </span>
                  {clip.segments.map((seg, j) => (
                    <div className="ai-edit-screen__mono" key={j}>
                      {j + 1}. {formatTime(seg.startSeconds)}–{formatTime(seg.endSeconds)}
                    </div>
                  ))}
                </div>
              )}
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
              {clip.soundEffects && clip.soundEffects.length > 0 && (
                <div className="ai-edit-screen__clip-section">
                  <span className="ai-edit-screen__clip-section-label">
                    Sound effects — mixed into export
                  </span>
                  {clip.soundEffects.map((s, j) => (
                    <div className="ai-edit-screen__mono" key={`sfx-${j}`}>
                      {s.sfxId === null && s.generatePrompt && settings.elevenLabsApiKey && (
                        <span className="ai-edit-screen__emphasis-tag">AI-GENERATED</span>
                      )}
                      {formatTime(s.time)}: SFX "{s.effect}"
                      {s.intensity ? ` (${s.intensity})` : ""} — {s.why}
                    </div>
                  ))}
                </div>
              )}
              {clip.music &&
                clip.music.musicId !== null &&
                (
                  <div className="ai-edit-screen__clip-section">
                    <span className="ai-edit-screen__clip-section-label">
                      Background music — mixed into export
                    </span>
                    <div className="ai-edit-screen__mono">
                      {clip.music.type} — {clip.music.why}
                    </div>
                  </div>
                )}
              {clip.music &&
                clip.music.musicId === null &&
                clip.music.generatePrompt &&
                settings.elevenLabsApiKey && (
                  <div className="ai-edit-screen__clip-section">
                    <span className="ai-edit-screen__clip-section-label">
                      Background music — AI-generated, mixed into export
                    </span>
                    <div className="ai-edit-screen__mono">
                      {clip.music.type} — {clip.music.why}
                    </div>
                  </div>
                )}
              {((clip.memes && clip.memes.length > 0) ||
                (clip.music &&
                  clip.music.musicId === null &&
                  (!clip.music.generatePrompt || !settings.elevenLabsApiKey))) && (
                <div className="ai-edit-screen__clip-section">
                  <span className="ai-edit-screen__clip-section-label">
                    Manual additions — not rendered automatically
                  </span>
                  {clip.memes?.map((m, j) => (
                    <div className="ai-edit-screen__mono" key={`meme-${j}`}>
                      {m.where}: meme "{m.meme}" — {m.why}
                    </div>
                  ))}
                  {clip.music &&
                    clip.music.musicId === null &&
                    (!clip.music.generatePrompt || !settings.elevenLabsApiKey) && (
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
