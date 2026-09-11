/**
 * Normalises a raw signal reading to 0-1 against its own rolling session
 * baseline, per the detection model: a quiet streamer's raised voice should
 * score the same as a loud streamer's. Tracks a slow-moving "ambient"
 * baseline and a faster-rising, slow-decaying "ceiling" and reports how far
 * the current reading sits between the two.
 */
export class RollingNormalizer {
  private baseline: number;
  private ceiling: number;

  constructor(initial = 0) {
    this.baseline = initial;
    this.ceiling = initial + 1e-4;
  }

  push(value: number): number {
    this.baseline += (value - this.baseline) * 0.01;
    if (value > this.ceiling) {
      this.ceiling += (value - this.ceiling) * 0.3;
    } else {
      this.ceiling += (value - this.ceiling) * 0.002;
    }
    const range = Math.max(this.ceiling - this.baseline, 1e-4);
    return Math.min(1, Math.max(0, (value - this.baseline) / range));
  }
}
