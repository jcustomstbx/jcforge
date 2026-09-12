import { useEffect, useRef } from "react";
import "./FramingPreview.css";

interface FramingPreviewProps {
  /** Native pixel size of the source video - the overlay's own box must
   * exactly match the video's displayed frame for the drag math to line up,
   * which the parent guarantees by setting the wrapper's aspect-ratio to
   * this same size. */
  nativeSize: { w: number; h: number } | null;
  pan: number;
  onPanChange: (pan: number) => void;
}

export function FramingPreview({
  nativeSize,
  pan,
  onPanChange,
}: FramingPreviewProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startPan: number } | null>(null);

  const cropWidthFrac = nativeSize
    ? Math.min(1, (nativeSize.h * 9) / 16 / nativeSize.w)
    : 1;
  const maxOffsetFrac = 1 - cropWidthFrac;
  const canPan = maxOffsetFrac > 0.001;

  useEffect(() => {
    if (!canPan) return;
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      const rect = overlayRef.current?.getBoundingClientRect();
      if (!drag || !rect) return;
      const deltaXFrac = (e.clientX - drag.startX) / rect.width;
      const deltaPan = (deltaXFrac / maxOffsetFrac) * 2;
      onPanChange(Math.max(-1, Math.min(1, drag.startPan + deltaPan)));
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [canPan, maxOffsetFrac, onPanChange]);

  if (!nativeSize) return null;

  const leftFrac = canPan ? (maxOffsetFrac / 2) * (1 + pan) : 0;
  const rightFrac = 1 - leftFrac - cropWidthFrac;

  return (
    <div className="framing-preview" ref={overlayRef}>
      <div
        className="framing-preview__mask"
        style={{ left: 0, width: `${leftFrac * 100}%` }}
      />
      {/* Visual-only - the actual crop boundary, full height to match what
       * really gets cropped. Not draggable itself: it would otherwise sit
       * on top of the video's native control bar at the bottom and eat
       * clicks meant for play/pause/scrub while this step is open. */}
      <div
        className="framing-preview__box"
        style={{ left: `${leftFrac * 100}%`, width: `${cropWidthFrac * 100}%` }}
      />
      {/* The actual drag target - a fixed-size handle kept well clear of
       * the bottom control-bar band regardless of frame height. */}
      {canPan && (
        <div
          className="framing-preview__handle"
          style={{ left: `${(leftFrac + cropWidthFrac / 2) * 100}%` }}
          onPointerDown={(e) => {
            dragRef.current = { startX: e.clientX, startPan: pan };
          }}
        />
      )}
      <div
        className="framing-preview__mask"
        style={{ right: 0, width: `${Math.max(0, rightFrac) * 100}%` }}
      />
    </div>
  );
}
