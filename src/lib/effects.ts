// Auto-applied "smart effects" - a flash and a brief zoom-in punch at each
// detected impact moment. Built as ffmpeg filter fragments rather than a
// manual effects timeline, so the app keeps doing this for you instead of
// turning the editor into a full effects tool.

const FLASH_OUT_DURATION = 0.04;
const FLASH_IN_DURATION = 0.1;

const ZOOM_WINDOW = 0.15;
const ZOOM_AMPLITUDE = 0.12;

/** A quick fade-to-white-and-back at each impact time. Chained fade filters
 * are no-ops outside their own [st, st+d] window, so pairs can be
 * concatenated freely for multiple impacts. */
export function buildFlashFilter(impacts: number[]): string | null {
  if (impacts.length === 0) return null;
  return impacts
    .map((t) => {
      const outStart = Math.max(0, t - FLASH_OUT_DURATION);
      return `fade=t=out:st=${outStart.toFixed(3)}:d=${FLASH_OUT_DURATION}:color=white,fade=t=in:st=${t.toFixed(3)}:d=${FLASH_IN_DURATION}:color=white`;
    })
    .join(",");
}

/** A brief punch-in zoom centered on each impact time, expressed as a
 * dynamic crop (in pixels of a 1080x1920 frame) re-scaled back up -
 * operates after the main crop+scale so it doesn't interact with the
 * static framing crop. */
export function buildZoomPunchFilter(impacts: number[]): string | null {
  if (impacts.length === 0) return null;
  const bumpSum = impacts
    .map((t) => `max(0,1-abs(t-${t.toFixed(3)})/${ZOOM_WINDOW})`)
    .join("+");
  const zoom = `(1+${ZOOM_AMPLITUDE}*(${bumpSum}))`;
  const w = `1080/${zoom}`;
  const h = `1920/${zoom}`;
  const x = `(1080-(${w}))/2`;
  const y = `(1920-(${h}))/2`;
  return `crop=w='${w}':h='${h}':x='${x}':y='${y}',scale=1080:1920`;
}
