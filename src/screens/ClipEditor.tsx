import { convertFileSrc } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useRef, useState } from "react";
import { useClips } from "../lib/clips";
import { useNavigation } from "../lib/navigation";
import { renderVertical } from "../lib/ffmpeg";
import { formatTime } from "../lib/format";
import { TrimBar } from "../components/TrimBar";
import "./ClipEditor.css";

function filename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function deriveOutputPath(sourcePath: string): string {
  const lastSep = Math.max(
    sourcePath.lastIndexOf("/"),
    sourcePath.lastIndexOf("\\"),
  );
  const dir = sourcePath.slice(0, lastSep);
  const base = sourcePath.slice(lastSep + 1);
  const dot = base.lastIndexOf(".");
  const stem = dot === -1 ? base : base.slice(0, dot);
  const sep = sourcePath.includes("\\") ? "\\" : "/";
  return `${dir}${sep}${stem}_vertical.mp4`;
}

type RenderState =
  | { status: "idle" }
  | { status: "rendering" }
  | { status: "done"; outputPath: string }
  | { status: "error"; message: string };

export function ClipEditor() {
  const nav = useNavigation();
  const { clips } = useClips();
  const clip = clips.find((c) => c.id === nav.editingClipId) ?? null;

  const videoRef = useRef<HTMLVideoElement>(null);
  const [openStep, setOpenStep] = useState<1 | 2>(1);
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(clip?.durationSeconds ?? 0);
  const [currentTime, setCurrentTime] = useState(0);
  const [render, setRender] = useState<RenderState>({ status: "idle" });

  useEffect(() => {
    setStartSec(0);
    setEndSec(clip?.durationSeconds ?? 0);
    setCurrentTime(0);
    setRender({ status: "idle" });
  }, [clip?.id]);

  // Loop playback within the selected trim range, so scrubbing the handles
  // doubles as an in/out preview instead of needing to play the whole clip.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      if (video.currentTime >= endSec) {
        video.currentTime = startSec;
        if (video.paused) video.pause();
      }
    };
    video.addEventListener("timeupdate", onTimeUpdate);
    return () => video.removeEventListener("timeupdate", onTimeUpdate);
  }, [startSec, endSec]);

  const videoSrc = useMemo(
    () => (clip ? convertFileSrc(clip.path) : null),
    [clip],
  );
  const outputPath = clip ? deriveOutputPath(clip.path) : null;

  if (!clip) {
    return (
      <div className="clip-editor clip-editor--empty">
        <h1 className="clip-editor__title">Clip editor</h1>
        <p className="clip-editor__empty-text">
          Open a clip from the library to edit it.
        </p>
      </div>
    );
  }

  const seekTo = (t: number) => {
    if (videoRef.current) videoRef.current.currentTime = t;
    setCurrentTime(t);
  };

  const doRender = async () => {
    if (!outputPath) return;
    setRender({ status: "rendering" });
    const result = await renderVertical({
      sourcePath: clip.path,
      outputPath,
      startSeconds: startSec,
      endSeconds: endSec,
    });
    if (result.ok) {
      setRender({ status: "done", outputPath });
    } else {
      console.error("[editor] render failed:", result.log);
      setRender({ status: "error", message: result.log.slice(-400) });
    }
  };

  return (
    <div className="clip-editor">
      <div className="clip-editor__header">
        <h1 className="clip-editor__title">Clip editor</h1>
        <span className="clip-editor__context">
          {filename(clip.path)} ·{" "}
          {clip.durationSeconds !== null
            ? formatTime(clip.durationSeconds)
            : "—"}
        </span>
      </div>

      <div className="clip-editor__body">
        <div className="clip-editor__preview-col">
          {videoSrc && (
            <video
              ref={videoRef}
              className="clip-editor__video"
              src={videoSrc}
              controls
            />
          )}
          <div className="clip-editor__trim">
            <TrimBar
              duration={clip.durationSeconds ?? 0}
              start={startSec}
              end={endSec}
              currentTime={currentTime}
              onChangeStart={setStartSec}
              onChangeEnd={setEndSec}
              onSeek={seekTo}
            />
            <div className="clip-editor__trim-summary">
              <span>{formatTime(startSec)}</span>
              <span className="clip-editor__trim-selected">
                selected {formatTime(endSec - startSec)}
              </span>
              <span>{formatTime(endSec)}</span>
            </div>
          </div>
        </div>

        <div className="clip-editor__rail">
          <div
            className={
              "clip-editor__step" + (openStep === 1 ? " clip-editor__step--open" : "")
            }
          >
            <div
              className="clip-editor__step-header"
              onClick={() => setOpenStep(1)}
            >
              <span className="clip-editor__step-num">1</span>
              <div>
                <div className="clip-editor__step-title">Framing</div>
                <div className="clip-editor__step-summary">
                  Static-center 9:16 crop
                </div>
              </div>
              <div className="clip-editor__spacer" />
              <span className="clip-editor__step-tag">auto</span>
            </div>
            {openStep === 1 && (
              <div className="clip-editor__step-body">
                <div className="clip-editor__row">
                  <span>Mode</span>
                  <span className="clip-editor__row-value">
                    Static centre
                  </span>
                </div>
                <div className="clip-editor__row">
                  <span>Output</span>
                  <span className="clip-editor__row-value">1080×1920</span>
                </div>
                <p className="clip-editor__note">
                  Subject tracking needs real face/object detection - out of
                  scope for now. This takes a horizontally-centered vertical
                  strip of the full-height frame.
                </p>
              </div>
            )}
          </div>

          <div
            className={
              "clip-editor__step" + (openStep === 2 ? " clip-editor__step--open" : "")
            }
          >
            <div
              className="clip-editor__step-header"
              onClick={() => setOpenStep(2)}
            >
              <span className="clip-editor__step-num">2</span>
              <div>
                <div className="clip-editor__step-title">Export</div>
                <div className="clip-editor__step-summary">
                  1080×1920 · H.264 (NVENC) · saved next to the source
                </div>
              </div>
              <div className="clip-editor__spacer" />
              <span className="clip-editor__step-tag">ready</span>
            </div>
            {openStep === 2 && (
              <div className="clip-editor__step-body">
                <div className="clip-editor__row">
                  <span>Container</span>
                  <span className="clip-editor__row-value">MP4 / H.264</span>
                </div>
                <div className="clip-editor__row">
                  <span>Encoder</span>
                  <span className="clip-editor__row-value">
                    NVENC · 18 Mb/s
                  </span>
                </div>
                <div className="clip-editor__row">
                  <span>Destination</span>
                  <span className="clip-editor__row-value">
                    {outputPath ? filename(outputPath) : "—"}
                  </span>
                </div>
              </div>
            )}
          </div>

          <button
            className="clip-editor__render"
            disabled={render.status === "rendering"}
            onClick={doRender}
          >
            {render.status === "rendering" ? "Rendering…" : "Render to folder"}
          </button>

          {render.status === "done" && (
            <div className="clip-editor__result clip-editor__result--ok">
              Rendered.{" "}
              <button
                className="clip-editor__reveal-link"
                onClick={() => revealItemInDir(render.outputPath)}
              >
                Reveal in folder
              </button>
            </div>
          )}
          {render.status === "error" && (
            <div className="clip-editor__result clip-editor__result--error">
              Render failed — {render.message || "see console"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
