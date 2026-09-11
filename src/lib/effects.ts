// Auto-applied "smart effects" - a flash and a brief zoom-in punch at each
// detected impact moment. Built as ffmpeg filter fragments rather than a
// manual effects timeline, so the app keeps doing this for you instead of
// turning the editor into a full effects tool.

const FLASH_HALF_WINDOW = 0.06;

const ZOOM_WINDOW = 0.15;
const ZOOM_AMPLITUDE = 0.12;

/** A hard flash to white at each impact time, gated by `enable` rather than
 * built from `fade`. `fade` ramps to its color and then HOLDS that state
 * for every subsequent frame forever (it's built for a one-time fade at
 * the start/end of a clip, not a momentary flash) - chaining a fade-out
 * then fade-in looked right in isolation but actually left the entire
 * rest of the video solid white from the first impact onward. Confirmed
 * by extracting frames before/during/after the window: `lut` gated with
 * `enable` correctly releases back to the original frame afterward, since
 * enable-gated filters are stateless (a disabled frame just passes
 * through unchanged) where `fade` is not. */
export function buildFlashFilter(impacts: number[]): string | null {
  if (impacts.length === 0) return null;
  const windows = impacts
    .map(
      (t) =>
        `between(t\\,${(t - FLASH_HALF_WINDOW).toFixed(3)}\\,${(t + FLASH_HALF_WINDOW).toFixed(3)})`,
    )
    .join("+");
  return `lut=c0=255:c1=255:c2=255:enable='${windows}'`;
}

/** A brief punch-in zoom centered on each impact time. ffmpeg's crop filter
 * only evaluates w/h once at init (not per-frame - only x/y track per
 * frame), so a naive time-varying crop size fails with "Error when
 * evaluating the expression" the moment it references `t`. scale, unlike
 * crop, has an explicit eval=frame mode for exactly this - scale up by a
 * time-varying factor, then crop back down to the fixed output size. */
export function buildZoomPunchFilter(impacts: number[]): string | null {
  if (impacts.length === 0) return null;
  const bumpSum = impacts
    .map((t) => `max(0,1-abs(t-${t.toFixed(3)})/${ZOOM_WINDOW})`)
    .join("+");
  const zoom = `(1+${ZOOM_AMPLITUDE}*(${bumpSum}))`;
  return `scale=w='1080*${zoom}':h='1920*${zoom}':eval=frame,crop=1080:1920`;
}
