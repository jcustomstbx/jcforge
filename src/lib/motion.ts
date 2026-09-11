/**
 * Frame-to-frame mean absolute pixel difference on downscaled OBS
 * screenshots, decoded via the browser's own image/canvas support - no
 * extra image library needed.
 */
export class MotionDiffer {
  private previous: Uint8ClampedArray | null = null;

  /** Discard the held frame so the next diff() is skipped once - used to
   * suppress a false motion spike right after an OBS scene transition. */
  reset(): void {
    this.previous = null;
  }

  async diff(dataUri: string): Promise<number> {
    const pixels = await decodeToPixels(dataUri);
    const previous = this.previous;
    this.previous = pixels;
    if (!previous || previous.length !== pixels.length) return 0;

    let sum = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      sum += Math.abs(pixels[i] - previous[i]);
      sum += Math.abs(pixels[i + 1] - previous[i + 1]);
      sum += Math.abs(pixels[i + 2] - previous[i + 2]);
    }
    const sampleCount = (pixels.length / 4) * 3;
    return sampleCount > 0 ? sum / sampleCount / 255 : 0;
  }
}

function decodeToPixels(dataUri: string): Promise<Uint8ClampedArray> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("2D canvas context unavailable"));
        return;
      }
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
    };
    img.onerror = () => reject(new Error("Failed to decode OBS screenshot"));
    img.src = dataUri;
  });
}
