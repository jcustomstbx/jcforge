import { convertFileSrc } from "@tauri-apps/api/core";
import { tempDir, join } from "@tauri-apps/api/path";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useRef, useState } from "react";
import { useClips } from "../lib/clips";
import { useNavigation } from "../lib/navigation";
import { renderVertical, summarizeFfmpegError } from "../lib/ffmpeg";
import {
  adjustCaptionsForTrim,
  linesToSrt,
  transcribeClip,
  writeTextFile,
  type CaptionLine,
} from "../lib/captions";
import { detectImpactMoments } from "../lib/impactDetection";
import { previewFlashOpacity, previewZoomFactor } from "../lib/effects";
import { formatTime } from "../lib/format";
import { TrimBar, type TrimBarMarker } from "../components/TrimBar";
import { FramingPreview } from "../components/FramingPreview";
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

// Manual and auto-detected effect points close enough together would just
// double up the same flash/zoom - collapse anything within this window.
const IMPACT_DEDUPE_SEC = 0.3;
const NEW_CAPTION_DURATION_SEC = 2.5;

type EffectType = "flash" | "zoom" | "both";

const EFFECT_TYPE_LABEL: Record<EffectType, string> = {
  flash: "Flash",
  zoom: "Zoom",
  both: "Flash + zoom",
};

interface ManualImpact {
  time: number;
  type: EffectType;
}

interface CombinedImpact {
  time: number;
  type: EffectType;
}

type RenderState =
  | { status: "idle" }
  | { status: "rendering" }
  | { status: "done"; outputPath: string }
  | { status: "error"; message: string };

type TranscribeState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done" }
  | { status: "error"; message: string };

type ImpactState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; impacts: number[] }
  | { status: "error"; message: string };

function dedupeByTime(impacts: CombinedImpact[]): CombinedImpact[] {
  return [...impacts]
    .sort((a, b) => a.time - b.time)
    .filter((p, i, arr) => i === 0 || p.time - arr[i - 1].time >= IMPACT_DEDUPE_SEC);
}

export function ClipEditor() {
  const nav = useNavigation();
  const { clips } = useClips();
  const clip = clips.find((c) => c.id === nav.editingClipId) ?? null;

  const videoRef = useRef<HTMLVideoElement>(null);
  const [openStep, setOpenStep] = useState<1 | 2 | 3 | 4>(1);
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(clip?.durationSeconds ?? 0);
  const [currentTime, setCurrentTime] = useState(0);
  const [render, setRender] = useState<RenderState>({ status: "idle" });
  const [captionLines, setCaptionLines] = useState<CaptionLine[] | null>(
    null,
  );
  const [transcribe, setTranscribe] = useState<TranscribeState>({
    status: "idle",
  });
  const [impactState, setImpactState] = useState<ImpactState>({
    status: "idle",
  });
  const [applyEffects, setApplyEffects] = useState(true);
  // Manual effect points, in absolute source-clip time (same axis as
  // currentTime/caption lines) - unlike auto-detected impacts, which are
  // relative to the trim window, these don't need invalidating when the
  // trim changes, just filtering to whatever's still inside it at render
  // time.
  const [manualImpacts, setManualImpacts] = useState<ManualImpact[]>([]);
  const [pendingEffectType, setPendingEffectType] = useState<EffectType>("both");
  const [framingPan, setFramingPan] = useState(0);
  const [nativeSize, setNativeSize] = useState<{ w: number; h: number } | null>(
    null,
  );

  useEffect(() => {
    setStartSec(0);
    setEndSec(clip?.durationSeconds ?? 0);
    setCurrentTime(0);
    setRender({ status: "idle" });
    setCaptionLines(null);
    setTranscribe({ status: "idle" });
    setImpactState({ status: "idle" });
    setManualImpacts([]);
    setFramingPan(0);
    setNativeSize(null);
  }, [clip?.id]);

  // Detected impacts are relative to the current trim window - invalidate
  // them if the trim changes so a stale set never gets rendered.
  useEffect(() => {
    setImpactState({ status: "idle" });
  }, [startSec, endSec]);

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

  // The caption/flash/zoom preview overlays are keyed off currentTime -
  // native "timeupdate" events are too coarse (browser-throttled, often
  // ~250ms) to make a 120ms flash window or the zoom's easing read smoothly
  // during playback, so poll every frame while playing instead. Scrubbing
  // (paused) is already covered by the timeupdate listener above, which
  // still fires once per seek.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let raf = 0;
    const loop = () => {
      setCurrentTime(video.currentTime);
      raf = requestAnimationFrame(loop);
    };
    const onPlay = () => {
      raf = requestAnimationFrame(loop);
    };
    const onPause = () => cancelAnimationFrame(raf);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      cancelAnimationFrame(raf);
    };
  }, [clip?.id]);

  // Track the source's native pixel size so the framing preview's overlay
  // can be sized to exactly match the displayed video frame (see the
  // video-wrap's aspect-ratio below) - without that, the crop-box drag math
  // would be off any time the preview area doesn't match the video's ratio.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onMeta = () => {
      if (video.videoWidth && video.videoHeight) {
        setNativeSize({ w: video.videoWidth, h: video.videoHeight });
      }
    };
    video.addEventListener("loadedmetadata", onMeta);
    if (video.readyState >= 1) onMeta();
    return () => video.removeEventListener("loadedmetadata", onMeta);
  }, [clip?.id]);

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

  const doTranscribe = async () => {
    setTranscribe({ status: "running" });
    try {
      const lines = await transcribeClip(clip.path);
      setCaptionLines(lines);
      setTranscribe({ status: "done" });
    } catch (err) {
      console.error("[editor] transcribe failed:", err);
      setTranscribe({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const doDetectImpacts = async () => {
    setImpactState({ status: "running" });
    try {
      const impacts = await detectImpactMoments(clip.path, startSec, endSec);
      setImpactState({ status: "done", impacts });
    } catch (err) {
      console.error("[editor] impact detection failed:", err);
      setImpactState({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Auto-detected points are always "both" (flash+zoom) - that's the
  // existing detection behaviour; only manually-added points can pick a
  // single effect type.
  const autoImpacts: CombinedImpact[] =
    impactState.status === "done"
      ? impactState.impacts.map((t) => ({ time: t + startSec, type: "both" as const }))
      : [];

  // All placed effect points regardless of the current trim window - used
  // for the timeline markers, so moving the trim handles doesn't make a
  // point you placed seem to vanish.
  const allImpacts: CombinedImpact[] = [
    ...(applyEffects ? autoImpacts : []),
    ...manualImpacts,
  ];

  // What will actually end up in the render (subject to the trim range) -
  // shared by the live preview overlay and the Effects/Export summaries so
  // they can't disagree with each other.
  const impactsInRange = dedupeByTime(
    allImpacts.filter((p) => p.time >= startSec && p.time <= endSec),
  );
  const flashTimesAbsolute = impactsInRange
    .filter((p) => p.type === "flash" || p.type === "both")
    .map((p) => p.time);
  const zoomTimesAbsolute = impactsInRange
    .filter((p) => p.type === "zoom" || p.type === "both")
    .map((p) => p.time);
  const effectiveEffectCount = impactsInRange.length;

  const addManualImpactAtPlayhead = () => {
    const t = currentTime;
    const tooClose = allImpacts.some(
      (existing) => Math.abs(existing.time - t) < IMPACT_DEDUPE_SEC,
    );
    if (tooClose) return;
    setManualImpacts((m) =>
      [...m, { time: t, type: pendingEffectType }].sort((a, b) => a.time - b.time),
    );
  };

  const removeManualImpact = (t: number) => {
    setManualImpacts((m) => m.filter((x) => x.time !== t));
  };

  const updateCaptionText = (id: number, text: string) => {
    setCaptionLines((lines) =>
      lines ? lines.map((l) => (l.id === id ? { ...l, text } : l)) : lines,
    );
  };

  const updateCaptionTiming = (
    id: number,
    field: "start" | "end",
    value: number,
  ) => {
    setCaptionLines((lines) =>
      lines
        ? lines
            .map((l) => (l.id === id ? { ...l, [field]: value } : l))
            .sort((a, b) => a.start - b.start)
        : lines,
    );
  };

  const removeCaptionLine = (id: number) => {
    setCaptionLines((lines) => (lines ? lines.filter((l) => l.id !== id) : lines));
  };

  const addCaptionAtPlayhead = () => {
    const duration = clip.durationSeconds ?? currentTime + NEW_CAPTION_DURATION_SEC;
    const start = currentTime;
    const end = Math.min(duration, start + NEW_CAPTION_DURATION_SEC);
    setCaptionLines((lines) => {
      const nextId = (lines ?? []).reduce((max, l) => Math.max(max, l.id), 0) + 1;
      const next = [...(lines ?? []), { id: nextId, start, end, text: "" }];
      return next.sort((a, b) => a.start - b.start);
    });
  };

  const doRender = async () => {
    if (!outputPath) return;
    setRender({ status: "rendering" });

    let captionsSrtPath: string | undefined;
    if (captionLines && captionLines.length > 0) {
      const adjusted = adjustCaptionsForTrim(captionLines, startSec, endSec);
      if (adjusted.length > 0) {
        const dir = await tempDir();
        captionsSrtPath = await join(dir, `jcforge_render_${Date.now()}.srt`);
        await writeTextFile(captionsSrtPath, linesToSrt(adjusted));
      }
    }

    const flashSeconds = flashTimesAbsolute.map((t) => t - startSec);
    const zoomSeconds = zoomTimesAbsolute.map((t) => t - startSec);

    const result = await renderVertical({
      sourcePath: clip.path,
      outputPath,
      startSeconds: startSec,
      endSeconds: endSec,
      captionsSrtPath,
      flashSeconds: flashSeconds.length > 0 ? flashSeconds : undefined,
      zoomSeconds: zoomSeconds.length > 0 ? zoomSeconds : undefined,
      framingPan,
    });
    if (result.ok) {
      setRender({ status: "done", outputPath });
    } else {
      console.error("[editor] render failed:", result.log);
      setRender({ status: "error", message: summarizeFfmpegError(result.log) });
    }
  };

  const panLabel =
    Math.abs(framingPan) < 0.03
      ? "Centered"
      : `${Math.round(Math.abs(framingPan) * 100)}% ${framingPan < 0 ? "left" : "right"}`;

  // Live preview overlays - a CSS approximation of what the render will
  // actually burn in, so you can judge caption/effect timing while
  // scrubbing instead of only finding out after a full ffmpeg pass.
  const activeCaption =
    captionLines?.find(
      (l) => currentTime >= l.start && currentTime < l.end,
    ) ?? null;
  const zoomFactor = previewZoomFactor(currentTime, zoomTimesAbsolute);
  const flashOpacity = previewFlashOpacity(currentTime, flashTimesAbsolute);

  const trimMarkers: TrimBarMarker[] = allImpacts.map((p) => ({
    time: p.time,
    variant: p.type,
    onClick: () => seekTo(p.time),
  }));

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
          <div
            className="clip-editor__video-wrap"
            style={
              nativeSize
                ? { aspectRatio: `${nativeSize.w} / ${nativeSize.h}` }
                : undefined
            }
          >
            <div
              className="clip-editor__zoom-layer"
              style={{ transform: `scale(${zoomFactor})` }}
            >
              {videoSrc && (
                <video
                  ref={videoRef}
                  className="clip-editor__video"
                  src={videoSrc}
                  controls
                />
              )}
            </div>
            {flashOpacity > 0 && (
              <div
                className="clip-editor__flash-overlay"
                style={{ opacity: flashOpacity }}
              />
            )}
            {activeCaption && activeCaption.text && (
              <div className="clip-editor__caption-overlay">
                {activeCaption.text}
              </div>
            )}
            {openStep === 1 && (
              <FramingPreview
                nativeSize={nativeSize}
                pan={framingPan}
                onPanChange={setFramingPan}
              />
            )}
          </div>
          <div className="clip-editor__trim">
            <TrimBar
              duration={clip.durationSeconds ?? 0}
              start={startSec}
              end={endSec}
              currentTime={currentTime}
              onChangeStart={setStartSec}
              onChangeEnd={setEndSec}
              onSeek={seekTo}
              markers={trimMarkers}
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
              "clip-editor__step" +
              (openStep === 1 ? " clip-editor__step--open" : "")
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
                  9:16 crop · {panLabel}
                </div>
              </div>
              <div className="clip-editor__spacer" />
              <span className="clip-editor__step-tag">manual</span>
            </div>
            {openStep === 1 && (
              <div className="clip-editor__step-body">
                <div className="clip-editor__row">
                  <span>Position</span>
                  <span className="clip-editor__row-value">{panLabel}</span>
                </div>
                <div className="clip-editor__row">
                  <span>Output</span>
                  <span className="clip-editor__row-value">1080×1920</span>
                </div>
                <p className="clip-editor__note">
                  Drag the highlighted box on the preview above to choose
                  what stays in frame - useful for keeping an off-center
                  facecam or action in the vertical crop. Subject tracking
                  would need real face/object detection, so this is a fixed
                  position for the whole clip rather than a tracked one.
                </p>
                <button
                  className="clip-editor__transcribe"
                  onClick={() => setFramingPan(0)}
                  disabled={Math.abs(framingPan) < 0.001}
                >
                  Center
                </button>
              </div>
            )}
          </div>

          <div
            className={
              "clip-editor__step" +
              (openStep === 2 ? " clip-editor__step--open" : "")
            }
          >
            <div
              className="clip-editor__step-header"
              onClick={() => setOpenStep(2)}
            >
              <span className="clip-editor__step-num">2</span>
              <div>
                <div className="clip-editor__step-title">Captions</div>
                <div className="clip-editor__step-summary">
                  {captionLines
                    ? `${captionLines.length} lines`
                    : "Not transcribed yet"}
                </div>
              </div>
              <div className="clip-editor__spacer" />
              <span className="clip-editor__step-tag">
                {captionLines ? captionLines.length : "—"}
              </span>
            </div>
            {openStep === 2 && (
              <div className="clip-editor__step-body">
                <div className="clip-editor__button-row">
                  <button
                    className="clip-editor__transcribe"
                    disabled={transcribe.status === "running"}
                    onClick={doTranscribe}
                  >
                    {transcribe.status === "running"
                      ? "Transcribing…"
                      : captionLines
                        ? "Re-transcribe"
                        : "Transcribe with Whisper"}
                  </button>
                  <button
                    className="clip-editor__add-button"
                    onClick={addCaptionAtPlayhead}
                    title="Add a caption line starting at the playhead"
                  >
                    + Add at {formatTime(currentTime)}
                  </button>
                </div>
                {transcribe.status === "error" && (
                  <p className="clip-editor__note clip-editor__note--error">
                    {transcribe.message}
                  </p>
                )}
                {captionLines && captionLines.length === 0 && (
                  <p className="clip-editor__note">
                    No speech detected in this clip.
                  </p>
                )}
                {captionLines && captionLines.length > 0 && (
                  <div className="clip-editor__captions">
                    {captionLines.map((line) => (
                      <div key={line.id} className="clip-editor__caption">
                        <div className="clip-editor__caption-row">
                          <input
                            className="clip-editor__caption-input"
                            value={line.text}
                            placeholder="caption text"
                            onChange={(e) =>
                              updateCaptionText(line.id, e.target.value)
                            }
                          />
                          <button
                            className="clip-editor__caption-delete"
                            title="Delete line"
                            onClick={() => removeCaptionLine(line.id)}
                          >
                            ×
                          </button>
                        </div>
                        <div className="clip-editor__caption-row">
                          <input
                            type="number"
                            step={0.1}
                            className="clip-editor__caption-time-input"
                            value={line.start.toFixed(1)}
                            onChange={(e) =>
                              updateCaptionTiming(
                                line.id,
                                "start",
                                Number(e.target.value),
                              )
                            }
                          />
                          <span className="clip-editor__caption-time-sep">
                            →
                          </span>
                          <input
                            type="number"
                            step={0.1}
                            className="clip-editor__caption-time-input"
                            value={line.end.toFixed(1)}
                            onChange={(e) =>
                              updateCaptionTiming(
                                line.id,
                                "end",
                                Number(e.target.value),
                              )
                            }
                          />
                          <button
                            className="clip-editor__caption-seek"
                            title="Seek to this line"
                            onClick={() => seekTo(line.start)}
                          >
                            seek
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div
            className={
              "clip-editor__step" +
              (openStep === 3 ? " clip-editor__step--open" : "")
            }
          >
            <div
              className="clip-editor__step-header"
              onClick={() => setOpenStep(3)}
            >
              <span className="clip-editor__step-num">3</span>
              <div>
                <div className="clip-editor__step-title">Effects</div>
                <div className="clip-editor__step-summary">
                  {effectiveEffectCount > 0
                    ? `${effectiveEffectCount} hype moment${effectiveEffectCount === 1 ? "" : "s"}`
                    : "Auto flash + zoom, or add your own"}
                </div>
              </div>
              <div className="clip-editor__spacer" />
              <span className="clip-editor__step-tag">
                {effectiveEffectCount > 0 ? effectiveEffectCount : "—"}
              </span>
            </div>
            {openStep === 3 && (
              <div className="clip-editor__step-body">
                <button
                  className="clip-editor__transcribe"
                  disabled={impactState.status === "running"}
                  onClick={doDetectImpacts}
                >
                  {impactState.status === "running"
                    ? "Analyzing…"
                    : impactState.status === "done"
                      ? "Re-detect moments"
                      : "Detect hype moments"}
                </button>
                {impactState.status === "error" && (
                  <p className="clip-editor__note clip-editor__note--error">
                    {impactState.message}
                  </p>
                )}
                {impactState.status === "done" &&
                  impactState.impacts.length === 0 &&
                  manualImpacts.length === 0 && (
                    <p className="clip-editor__note">
                      No standout moments detected in this range.
                    </p>
                  )}
                {impactState.status === "done" &&
                  impactState.impacts.length > 0 && (
                    <label className="clip-editor__checkbox-row">
                      <input
                        type="checkbox"
                        checked={applyEffects}
                        onChange={(e) => setApplyEffects(e.target.checked)}
                      />
                      Auto-detected at{" "}
                      {impactState.impacts.map((t) => formatTime(t)).join(", ")}
                    </label>
                  )}

                <div className="clip-editor__effect-type-row">
                  {(["flash", "zoom", "both"] as EffectType[]).map((type) => (
                    <button
                      key={type}
                      type="button"
                      className={
                        "clip-editor__effect-type" +
                        (pendingEffectType === type
                          ? " clip-editor__effect-type--active"
                          : "")
                      }
                      onClick={() => setPendingEffectType(type)}
                    >
                      {EFFECT_TYPE_LABEL[type]}
                    </button>
                  ))}
                </div>
                <button
                  className="clip-editor__add-button clip-editor__add-button--wide"
                  onClick={addManualImpactAtPlayhead}
                  title={`Add ${EFFECT_TYPE_LABEL[pendingEffectType]} at the playhead`}
                >
                  + Add {EFFECT_TYPE_LABEL[pendingEffectType].toLowerCase()} at{" "}
                  {formatTime(currentTime)}
                </button>

                {manualImpacts.length > 0 && (
                  <div className="clip-editor__impact-list">
                    {manualImpacts.map((p) => (
                      <div key={p.time} className="clip-editor__impact-chip">
                        <span
                          className={`clip-editor__impact-dot clip-editor__impact-dot--${p.type}`}
                        />
                        <span>{formatTime(p.time - startSec)}</span>
                        <button
                          className="clip-editor__caption-delete"
                          title="Remove"
                          onClick={() => removeManualImpact(p.time)}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <p className="clip-editor__note">
                  Auto-detect finds the loudest moments in the clip's audio
                  and always applies both effects. Pick a type above, then
                  play or scrub to the spot you want and add it there - or
                  click a dot on the timeline to jump back to a point you've
                  already placed. The preview shows timing and intensity
                  live, though it zooms the full source frame rather than
                  the cropped 9:16 output.
                </p>
              </div>
            )}
          </div>

          <div
            className={
              "clip-editor__step" +
              (openStep === 4 ? " clip-editor__step--open" : "")
            }
          >
            <div
              className="clip-editor__step-header"
              onClick={() => setOpenStep(4)}
            >
              <span className="clip-editor__step-num">4</span>
              <div>
                <div className="clip-editor__step-title">Export</div>
                <div className="clip-editor__step-summary">
                  1080×1920 · H.264 (NVENC) · saved next to the source
                </div>
              </div>
              <div className="clip-editor__spacer" />
              <span className="clip-editor__step-tag">ready</span>
            </div>
            {openStep === 4 && (
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
                  <span>Framing</span>
                  <span className="clip-editor__row-value">{panLabel}</span>
                </div>
                <div className="clip-editor__row">
                  <span>Captions</span>
                  <span className="clip-editor__row-value">
                    {captionLines && captionLines.length > 0
                      ? "burned in"
                      : "none"}
                  </span>
                </div>
                <div className="clip-editor__row">
                  <span>Effects</span>
                  <span className="clip-editor__row-value">
                    {effectiveEffectCount > 0
                      ? `${flashTimesAbsolute.length} flash · ${zoomTimesAbsolute.length} zoom`
                      : "none"}
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
