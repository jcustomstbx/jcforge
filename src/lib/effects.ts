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

export interface WeightedImpact {
  time: number;
  /** Multiplier on this impact's bump strength/window - 1 = normal. Lets a
   * single render mix low/medium/high intensity effects instead of every
   * impact using the same fixed duration and amplitude. */
  strength?: number;
}

/** Either a bare timestamp (strength 1, the manual editor's case) or a
 * timestamp with its own strength (AI-suggested effects with an
 * intensity). */
export type ImpactInput = number | WeightedImpact;

function normalizeImpact(impact: ImpactInput): Required<WeightedImpact> {
  return typeof impact === "number"
    ? { time: impact, strength: 1 }
    : { time: impact.time, strength: impact.strength ?? 1 };
}

// Each impact's own strength widens its window AND raises its bump height,
// so "high" intensity reads as both longer-lasting and more pronounced
// rather than only one or the other.
// geq's per-pixel expressions use their own variable namespace where time
// is the uppercase `T` (confirmed live: lowercase `t` errors as an
// "undefined constant" there) - every other filter used in this file
// (hue, scale, crop) takes lowercase `t`, so the time variable name has to
// be a parameter rather than hardcoded.
function raisedCosineBumpSumExpr(
  impacts: ImpactInput[],
  baseHalfWindow: number,
  timeVar: string = "t",
): string {
  return impacts
    .map(normalizeImpact)
    .map(({ time, strength }) => {
      const halfWindow = baseHalfWindow * strength;
      return `(${strength.toFixed(3)}*0.5*(1+cos(PI*min(abs(${timeVar}-${time.toFixed(3)})/${halfWindow.toFixed(3)},1))))`;
    })
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
  impacts: ImpactInput[],
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
  impacts: ImpactInput[],
  durationSec: number = DEFAULT_ZOOM_DURATION_SEC,
): string | null {
  if (impacts.length === 0) return null;
  const halfWindow = durationSec / 2;
  const bumpSum = raisedCosineBumpSumExpr(impacts, halfWindow);
  const zoom = `(1+${ZOOM_AMPLITUDE}*(${bumpSum}))`;
  return `scale=w='1080*${zoom}':h='1920*${zoom}':eval=frame,crop=1080:1920`;
}

export const DEFAULT_SHAKE_DURATION_SEC = 0.5;
const SHAKE_MARGIN_FRAC = 0.1; // headroom the jitter is allowed to move into
const SHAKE_AMPLITUDE_PX = 16;

/** A brief camera-shake jitter centered on each impact time. crop's x/y
 * (unlike its w/h) evaluate per-frame, so the jitter itself is a plain
 * crop with a time-varying offset - the same "scale up first for headroom,
 * then crop back down" trick as the zoom punch, just shifting position
 * instead of shifting scale. Two different jitter frequencies on x vs y
 * (9 Hz / 13 Hz, deliberately not a common multiple) avoid the motion
 * tracing a repeating circle, which reads as an obvious loop rather than
 * a shake. */
export function buildShakeFilter(
  impacts: ImpactInput[],
  durationSec: number = DEFAULT_SHAKE_DURATION_SEC,
): string | null {
  if (impacts.length === 0) return null;
  const halfWindow = durationSec / 2;
  const bumpSum = raisedCosineBumpSumExpr(impacts, halfWindow);
  const bump = `min((${bumpSum}),1)`;
  const amp = SHAKE_AMPLITUDE_PX;
  const jitterX = `${amp}*${bump}*sin(2*PI*9*t)`;
  const jitterY = `${amp}*${bump}*cos(2*PI*13*t)`;
  return (
    `scale=w='1080*${1 + SHAKE_MARGIN_FRAC}':h='1920*${1 + SHAKE_MARGIN_FRAC}',` +
    `crop=1080:1920:x='(iw-1080)/2+${jitterX}':y='(ih-1920)/2+${jitterY}'`
  );
}

export const DEFAULT_GLITCH_DURATION_SEC = 0.3;
const GLITCH_SHIFT_PX = 8;

/** A brief RGB channel-split (chromatic aberration) glitch. rgbashift's
 * shift amounts are plain ints with no per-frame expression support
 * (confirmed via `ffmpeg -h filter=rgbashift` - unlike hue/scale/crop,
 * its options aren't expression strings), so instead of a smooth
 * cosine envelope this uses the filter's `enable` timeline option to
 * hard-toggle a fixed shift on for each impact's window - which also
 * suits a "glitch" better than a smooth fade would. */
export function buildGlitchFilter(
  impacts: ImpactInput[],
  durationSec: number = DEFAULT_GLITCH_DURATION_SEC,
): string | null {
  if (impacts.length === 0) return null;
  const halfWindow = durationSec / 2;
  const enable = impacts
    .map(normalizeImpact)
    .map(({ time, strength }) => {
      const w = halfWindow * strength;
      return `between(t,${(time - w).toFixed(3)},${(time + w).toFixed(3)})`;
    })
    .join("+");
  return `rgbashift=rh=${GLITCH_SHIFT_PX}:bh=-${GLITCH_SHIFT_PX}:edge=smear:enable='${enable}'`;
}

export const DEFAULT_MOSAIC_DURATION_SEC = 0.35;
const MOSAIC_BLOCK_PX = 24;

/** A brief pixelation burst - same `enable`-window approach as the glitch
 * filter, since pixelize's block size is likewise a plain int with no
 * per-frame expression support. */
export function buildMosaicFilter(
  impacts: ImpactInput[],
  durationSec: number = DEFAULT_MOSAIC_DURATION_SEC,
): string | null {
  if (impacts.length === 0) return null;
  const halfWindow = durationSec / 2;
  const enable = impacts
    .map(normalizeImpact)
    .map(({ time, strength }) => {
      const w = halfWindow * strength;
      return `between(t,${(time - w).toFixed(3)},${(time + w).toFixed(3)})`;
    })
    .join("+");
  return `pixelize=w=${MOSAIC_BLOCK_PX}:h=${MOSAIC_BLOCK_PX}:enable='${enable}'`;
}

export const DEFAULT_INVERT_DURATION_SEC = 0.35;

/** A brief colour-invert pulse, the same smooth cosine-envelope shape as
 * the white flash but blending toward inverted colour instead of white.
 * geq's r/g/b are true per-pixel-per-frame expressions (unlike
 * rgbashift/pixelize above), so this can fade smoothly like buildFlashFilter
 * rather than hard-toggle: blending a channel value v toward its inverse
 * (255-v) by fraction `bump` simplifies to v*(1-2*bump) + 255*bump. */
export function buildInvertFilter(
  impacts: ImpactInput[],
  durationSec: number = DEFAULT_INVERT_DURATION_SEC,
): string | null {
  if (impacts.length === 0) return null;
  const halfWindow = durationSec / 2;
  const bump = `min((${raisedCosineBumpSumExpr(impacts, halfWindow, "T")}),1)`;
  const blend = (channel: string) => `${channel}(X,Y)*(1-2*${bump})+255*${bump}`;
  return `geq=r='${blend("r")}':g='${blend("g")}':b='${blend("b")}'`;
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
