// Auto-applied "smart effects" - a flash and a brief zoom-in punch at each
// detected impact moment. Built as ffmpeg filter fragments rather than a
// manual effects timeline, so the app keeps doing this for you instead of
// turning the editor into a full effects tool.

export const DEFAULT_FLASH_DURATION_SEC = 0.5;
export const DEFAULT_ZOOM_DURATION_SEC = 0.4;
const ZOOM_AMPLITUDE = 0.12;
// How much to boost brightness at a flash's peak, once desaturated to gray -
// found by testing against a synthetic clip: below this, saturated colours
// (pure red/blue/etc） still show through at the "peak" instead of reading
// as a clean white flash.
const FLASH_BRIGHTNESS = 10;

function raisedCosineBumpSumExpr(impacts: number[], halfWindow: number): string {
  return impacts
    .map(
      (t) =>
        `(0.5*(1+cos(PI*min(abs(t-${t.toFixed(3)})/${halfWindow.toFixed(3)},1))))`,
    )
    .join("+");
}

/** A flash to white at each impact time that actually fades in and out,
 * rather than cutting hard - `hue`'s saturation and brightness both accept
 * per-frame time-varying expressions, so driving saturation down to 0 and
 * brightness up together at the peak desaturates-and-blows-out to white,
 * then eases back to the original frame. Confirmed by extracting frames
 * before/during/after: unlike `fade` (which permanently holds its end
 * colour for every frame afterward - it's built for a one-time fade at a
 * clip's start/end, not a momentary pulse), this cleanly reverts once the
 * bump decays, since at bump=0 both saturation and brightness are no-ops.
 * Multiple overlapping impacts sum their bumps, clamped to 1 so saturation
 * never goes negative (which reads as a colour-inverted glitch rather than
 * white). */
export function buildFlashFilter(
  impacts: number[],
  durationSec: number = DEFAULT_FLASH_DURATION_SEC,
): string | null {
  if (impacts.length === 0) return null;
  const halfWindow = durationSec / 2;
  const bump = `min((${raisedCosineBumpSumExpr(impacts, halfWindow)}),1)`;
  return `hue=s='1-${bump}':b='${FLASH_BRIGHTNESS}*${bump}'`;
}

/** A brief punch-in zoom centered on each impact time. ffmpeg's crop filter
 * only evaluates w/h once at init (not per-frame - only x/y track per
 * frame), so a naive time-varying crop size fails with "Error when
 * evaluating the expression" the moment it references `t`. scale, unlike
 * crop, has an explicit eval=frame mode for exactly this - scale up by a
 * time-varying factor, then crop back down to the fixed output size.
 *
 * The bump uses a raised-cosine falloff (smooth derivative throughout,
 * peaking at the impact and easing to 0 at the window edge) rather than a
 * linear ramp, which has a sharp, mechanical-looking corner right at the
 * peak - the cosine curve is what reads as a deliberate "punch" instead of
 * a linear zoom. */
export function buildZoomPunchFilter(
  impacts: number[],
  durationSec: number = DEFAULT_ZOOM_DURATION_SEC,
): string | null {
  if (impacts.length === 0) return null;
  const halfWindow = durationSec / 2;
  const bumpSum = raisedCosineBumpSumExpr(impacts, halfWindow);
  const zoom = `(1+${ZOOM_AMPLITUDE}*(${bumpSum}))`;
  return `scale=w='1080*${zoom}':h='1920*${zoom}':eval=frame,crop=1080:1920`;
}

/** JS-side equivalents of the same math above, for the editor's live
 * preview (a CSS transform/opacity, not an ffmpeg render) - built from the
 * same constants and formulas so the preview can't silently drift from
 * what actually gets rendered. */
export function previewZoomFactor(
  t: number,
  impacts: number[],
  durationSec: number = DEFAULT_ZOOM_DURATION_SEC,
): number {
  const halfWindow = durationSec / 2;
  let bump = 0;
  for (const impactT of impacts) {
    const d = Math.abs(t - impactT);
    if (d < halfWindow) bump += 0.5 * (1 + Math.cos((Math.PI * d) / halfWindow));
  }
  return 1 + ZOOM_AMPLITUDE * bump;
}

/** 0..1 "how much white" - the CSS preview uses a plain white overlay with
 * this as its opacity, a reasonable stand-in for the render's actual
 * desaturate+brighten approach (both reach solid white at the peak). */
export function previewFlashOpacity(
  t: number,
  impacts: number[],
  durationSec: number = DEFAULT_FLASH_DURATION_SEC,
): number {
  const halfWindow = durationSec / 2;
  let bump = 0;
  for (const impactT of impacts) {
    const d = Math.abs(t - impactT);
    if (d < halfWindow) bump += 0.5 * (1 + Math.cos((Math.PI * d) / halfWindow));
  }
  return Math.min(1, bump);
}
