import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderOpen, Trash2 } from "lucide-react";
import { useClips } from "../lib/clips";
import { useNavigation } from "../lib/navigation";
import type { Clip } from "../lib/db";
import "./ClipLibrary.css";

function formatSize(bytes: number | null): string {
  if (bytes === null) return "—";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(0)} MB`;
}

function formatCapturedAt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function filename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function ClipCard({ clip }: { clip: Clip }) {
  const nav = useNavigation();
  const clips = useClips();

  const handleDelete = () => {
    if (
      !window.confirm(
        `Delete "${filename(clip.path)}"? This removes the video file from disk too.`,
      )
    ) {
      return;
    }
    clips.removeClip(clip.id, true);
  };

  return (
    <div className="clip-card">
      <div className="clip-card__thumb">
        <span className="clip-card__duration">
          {formatDuration(clip.durationSeconds)}
        </span>
      </div>
      <div className="clip-card__body">
        <div className="clip-card__title">{filename(clip.path)}</div>
        <div className="clip-card__meta">
          {formatCapturedAt(clip.capturedAt)} · {formatSize(clip.fileSizeBytes)}
        </div>
        <div className="clip-card__actions">
          <button
            className="clip-card__open-editor"
            onClick={() => nav.openEditor(clip.id)}
          >
            Open editor
          </button>
          <button
            className="clip-card__reveal"
            title="Reveal in folder"
            onClick={() => revealItemInDir(clip.path)}
          >
            <FolderOpen size={13} />
          </button>
          <button
            className="clip-card__delete"
            title="Delete clip"
            onClick={handleDelete}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

export function ClipLibrary() {
  const { clips, loading, refresh } = useClips();
  // Skipped clips delete their video file immediately (see clips.tsx) - the
  // row sticks around only so kept/skipped stats stay accurate, not to show
  // as a broken library card with nothing to open.
  const visibleClips = clips.filter((c) => c.kept !== false);

  return (
    <div className="clip-library">
      <div className="clip-library__header">
        <h1 className="clip-library__title">Clip library</h1>
        <span className="clip-library__count">
          {loading ? "loading…" : `${visibleClips.length} clips`}
        </span>
        <div className="clip-library__spacer" />
        <button className="clip-library__refresh" onClick={() => refresh()}>
          Refresh
        </button>
      </div>
      {!loading && visibleClips.length === 0 && (
        <div className="clip-library__empty">
          Nothing caught yet. Press F9 (or use the button on Live session)
          while the replay buffer is running to save your first clip.
        </div>
      )}
      <div className="clip-library__grid">
        {visibleClips.map((clip) => (
          <ClipCard key={clip.id} clip={clip} />
        ))}
      </div>
    </div>
  );
}
