import { convertFileSrc } from "@tauri-apps/api/core";
import { tempDir, join } from "@tauri-apps/api/path";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useRef, useState } from "react";
import { useClips } from "../lib/clips";
import { useNavigation } from "../lib/navigation";
import {
  renderVertical,
  summarizeFfmpegError,
  DEFAULT_CAPTION_FONT_SIZE,
  DEFAULT_CAPTION_MARGIN_V,
} from "../lib/ffmpeg";
import {
  adjustCaptionsForTrim,
  linesToSrt,
  transcribeClip,
  writeTextFile,
  type CaptionLine,
} from "../lib/captions";
import { detectImpactMoments } from "../lib/impactDetection";
import {
  previewFlashOpacity,
  previewZoomFactor,
  DEFAULT_FLASH_DURATION_SEC,
  DEFAULT_ZOOM_DURATION_SEC,
} from "../lib/effects";
import { formatTime } from "../lib/format";
import { TrimBar, type TrimBarMarker } from "../components/TrimBar";
import { FramingPreview } from "../components/FramingPreview";
import { TuningSlider } from "../components/TuningSlider";
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

/** A plain controlled `<input type="number">` re-renders with its
 * `.toFixed(1)`-formatted value on every keystroke, which fights in-place
 * editing (deleting a trailing digit gets immediately overwritten back by
 * the reformatted value). Free-typing into local draft state and only
 * parsing/clamping/committing on blur avoids that, and validates the value
 * exactly once instead of on every partial keystroke. */
function CaptionTimeInput({
  value,
  min,
  max,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(value.toFixed(1));

  useEffect(() => {
    setDraft(value.toFixed(1));
  }, [value]);

  const commit = () => {
    const parsed = Number(draft);
    // Guard against an inverted range (e.g. a sub-0.1s line, where
    // end - 0.1 < 0) rather than clamping below min or above max.
    const safeMax = Math.max(min, max);
    const clamped = Number.isFinite(parsed)
      ? Math.min(safeMax, Math.max(min, parsed))
      : value;
    onCommit(clamped);
    setDraft(clamped.toFixed(1));
  };

  return (
    <input
      type="number"
      step={0.1}
      className="clip-editor__caption-time-input"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

export function ClipEditor() {
  const nav = useNavigation();
  const { clips } = useClips();
  const clip = clips.find((c) => c.id === nav.editingClipId) ?? null;

  const videoRef = useRef<HTMLVideoElement>(null);
  // The zoom/flash/caption preview overlays are driven imperatively (see
  // the rAF effect below) rather than through React state, so a playing
  // video doesn't force a full re-render of the whole editor - steps rail,
  // caption list and all - on every single animation frame.
  const zoomLayerRef = useRef<HTMLDivElement>(null);
  const flashOverlayRef = useRef<HTMLDivElement>(null);
  const captionOverlayRef = useRef<HTMLDivElement>(null);
  const flashTimesRef = useRef<number[]>([]);
  const zoomTimesRef = useRef<number[]>([]);
  const flashDurationRef = useRef(DEFAULT_FLASH_DURATION_SEC);
  const zoomDurationRef = useRef(DEFAULT_ZOOM_DURATION_SEC);
  const captionLinesRef = useRef<CaptionLine[] | null>(null);
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
  const [addImpactWarning, setAddImpactWarning] = useState<string | null>(null);
  const [flashDurationSec, setFlashDurationSec] = useState(DEFAULT_FLASH_DURATION_SEC);
  const [zoomDurationSec, setZoomDurationSec] = useState(DEFAULT_ZOOM_DURATION_SEC);
  const [captionFontSize, setCaptionFontSize] = useState(DEFAULT_CAPTION_FONT_SIZE);
  const [captionMarginV, setCaptionMarginV] = useState(DEFAULT_CAPTION_MARGIN_V);
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
    setAddImpactWarning(null);
    setFlashDurationSec(DEFAULT_FLASH_DURATION_SEC);
    setZoomDurationSec(DEFAULT_ZOOM_DURATION_SEC);
    setCaptionFontSize(DEFAULT_CAPTION_FONT_SIZE);
    setCaptionMarginV(DEFAULT_CAPTION_MARGIN_V);
    setFramingPan(0);
    setNativeSize(null);
    if (zoomLayerRef.current) zoomLayerRef.current.style.transform = "scale(1)";
    if (flashOverlayRef.current) flashOverlayRef.current.style.opacity = "0";
    if (captionOverlayRef.current) captionOverlayRef.current.textContent = "";
  }, [clip?.id]);

  // Detected impacts are relative to the current trim window - invalidate
  // them if the trim changes so a stale set never gets rendered.
  useEffect(() => {
    setImpactState({ status: "idle" });
  }, [startSec, endSec]);

  // Writes the zoom/flash/caption preview directly to the DOM instead of
  // through React state - called up to 60x/sec while playing, which would
  // otherwise re-render the entire editor (steps rail, caption list, all of
  // it) that often. Reads the *Ref mirrors below rather than closing over
  // the render's own values, so it stays correct without needing to be
  // recreated every time an effect/caption is added or edited.
  const updateOverlay = (t: number) => {
    if (zoomLayerRef.current) {
      zoomLayerRef.current.style.transform = `scale(${previewZoomFactor(t, zoomTimesRef.current, zoomDurationRef.current)})`;
    }
    if (flashOverlayRef.current) {
      flashOverlayRef.current.style.opacity = String(
        previewFlashOpacity(t, flashTimesRef.current, flashDurationRef.current),
      );
    }
    if (captionOverlayRef.current) {
      const line =
        captionLinesRef.current?.find((l) => t >= l.start && t < l.end) ?? null;
      captionOverlayRef.current.textContent = line?.text ?? "";
    }
  };

  // Loop playback within the selected trim range, so scrubbing the handles
  // doubles as an in/out preview instead of needing to play the whole clip.
  // Also the coarse (browser-throttled, often ~250ms) path for updating
  // currentTime and the preview overlay while paused/scrubbing.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      updateOverlay(video.currentTime);
      if (video.currentTime >= endSec) {
        video.currentTime = startSec;
        if (video.paused) video.pause();
      }
    };
    video.addEventListener("timeupdate", onTimeUpdate);
    return () => video.removeEventListener("timeupdate", onTimeUpdate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startSec, endSec]);

  // The overlay needs finer granularity than "timeupdate" gives during
  // playback - too coarse to make a 120ms flash window or the zoom's
  // easing read smoothly - so poll every frame while playing instead.
  // currentTime (React state, for the trim bar/markers/button labels) still
  // only updates at timeupdate's native rate, since those don't need
  // per-frame smoothness and re-render more of the tree.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let raf = 0;
    const loop = () => {
      updateOverlay(video.currentTime);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      const impacts = await detectImpactMoments(
        clip.path,
        startSec,
        endSec,
        captionLines,
      );
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

  // Keep the imperative preview loop's inputs current without making it
  // depend on (and re-subscribe over) values that change on every edit.
  flashTimesRef.current = flashTimesAbsolute;
  zoomTimesRef.current = zoomTimesAbsolute;
  flashDurationRef.current = flashDurationSec;
  zoomDurationRef.current = zoomDurationSec;
  captionLinesRef.current = captionLines;

  const addManualImpactAtPlayhead = () => {
    const t = currentTime;
    const tooClose = allImpacts.some(
      (existing) => Math.abs(existing.time - t) < IMPACT_DEDUPE_SEC,
    );
    if (tooClose) {
      setAddImpactWarning(
        `Already an effect within ${IMPACT_DEDUPE_SEC}s of ${formatTime(t)} - move the playhead further away.`,
      );
      return;
    }
    setAddImpactWarning(null);
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
      flashDurationSec,
      zoomDurationSec,
      captionFontSize,
      captionMarginV,
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

  // Where the actual 9:16 crop sits within the full preview frame - the
  // caption overlay needs this so it previews inside the region that will
  // actually survive the crop, not the full uncropped frame (which made
  // captions look like they'd fall outside frame even when the real
  // render already centers them correctly post-crop).
  const cropWidthFrac = nativeSize
    ? Math.min(1, (nativeSize.h * 9) / 16 / nativeSize.w)
    : 1;
  const cropMaxOffsetFrac = 1 - cropWidthFrac;
  const cropLeftFrac =
    cropMaxOffsetFrac > 0.001 ? (cropMaxOffsetFrac / 2) * (1 + framingPan) : 0;

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
            <div className="clip-editor__zoom-layer" ref={zoomLayerRef}>
              {videoSrc && (
                <video
                  ref={videoRef}
                  className="clip-editor__video"
                  src={videoSrc}
                  controls
                />
              )}
            </div>
            <div
              className="clip-editor__flash-overlay"
              ref={flashOverlayRef}
              style={{ opacity: 0 }}
            />
            <div
              className="clip-editor__caption-overlay"
              ref={captionOverlayRef}
              style={{
                left: `${(cropLeftFrac + cropWidthFrac / 2) * 100}%`,
                width: `${cropWidthFrac * 92}%`,
                bottom: `${(captionMarginV / 1920) * 100}%`,
                fontSize: `${captionFontSize / 19.2}cqh`,
              }}
            />
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
                <div className="clip-editor__duration-sliders">
                  <TuningSlider
                    label="Caption size"
                    value={captionFontSize}
                    min={16}
                    max={96}
                    step={2}
                    format={(v) => `${v.toFixed(0)}px`}
                    onCommit={setCaptionFontSize}
                  />
                  <TuningSlider
                    label="Caption position"
                    value={captionMarginV}
                    min={20}
                    max={500}
                    step={10}
                    format={(v) => `${v.toFixed(0)}px from bottom`}
                    onCommit={setCaptionMarginV}
                  />
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
                          <CaptionTimeInput
                            value={line.start}
                            min={0}
                            max={line.end - 0.1}
                            onCommit={(v) =>
                              updateCaptionTiming(line.id, "start", v)
                            }
                          />
                          <span className="clip-editor__caption-time-sep">
                            →
                          </span>
                          <CaptionTimeInput
                            value={line.end}
                            min={line.start + 0.1}
                            max={clip.durationSeconds ?? line.start + 3600}
                            onCommit={(v) =>
                              updateCaptionTiming(line.id, "end", v)
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
                <div className="clip-editor__duration-sliders">
                  <TuningSlider
                    label="Flash duration"
                    value={flashDurationSec}
                    min={0.1}
                    max={1.5}
                    step={0.05}
                    format={(v) => `${v.toFixed(2)}s`}
                    onCommit={setFlashDurationSec}
                  />
                  <TuningSlider
                    label="Zoom duration"
                    value={zoomDurationSec}
                    min={0.2}
                    max={2}
                    step={0.1}
                    format={(v) => `${v.toFixed(1)}s`}
                    onCommit={setZoomDurationSec}
                  />
                </div>
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
                      {impactState.impacts
                        .map((t) => formatTime(t + startSec))
                        .join(", ")}
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
                {addImpactWarning && (
                  <p className="clip-editor__note clip-editor__note--error">
                    {addImpactWarning}
                  </p>
                )}

                {manualImpacts.length > 0 && (
                  <div className="clip-editor__impact-list">
                    {manualImpacts.map((p) => (
                      <div key={p.time} className="clip-editor__impact-chip">
                        <span
                          className={`clip-editor__impact-dot clip-editor__impact-dot--${p.type}`}
                        />
                        <span>{formatTime(p.time)}</span>
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
                  Both effects fade in and back out rather than cutting hard
                  - the durations above set how long that takes, for every
                  flash/zoom in this render. Auto-detect combines loud audio
                  peaks with excited language in the transcript ("let's go",
                  laughing, swearing) when one exists, so a loud but
                  unremarkable noise doesn't win purely on volume, and a
                  quiet reaction can still surface. Transcribe first (step
                  2) for the best results - it still works without one,
                  just audio-only. Pick a type above, then play or scrub to
                  the spot you want and add it there - or click a dot on
                  the timeline to jump back to a point you've already
                  placed. The preview shows timing and intensity live,
                  though it zooms the full source frame rather than the
                  cropped 9:16 output.
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
