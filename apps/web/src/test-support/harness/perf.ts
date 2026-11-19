// Frame-time smoke for the scene harness (M4_PLAN §7.1, review N9): records
// requestAnimationFrame intervals for `ms` and reports percentiles. Run the
// browser with vsync off (`--disable-gpu-vsync --disable-frame-rate-limit`) so an
// interval is the frame's real cost rather than the display's 16.7 ms tick.

export type FrameStats = {
  frames: number;
  p50: number;
  p95: number;
  max: number;
};

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

export function frameStats(intervals: readonly number[]): FrameStats {
  const sorted = [...intervals].sort((a, b) => a - b);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    frames: sorted.length,
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    max: round(sorted.at(-1) ?? 0),
  };
}

export function measureFrames(ms: number): Promise<FrameStats> {
  return new Promise((resolve) => {
    const intervals: number[] = [];
    let start = 0;
    let last = 0;
    const tick = (time: number) => {
      if (start === 0) start = time;
      else intervals.push(time - last);
      last = time;
      if (time - start < ms) requestAnimationFrame(tick);
      else resolve(frameStats(intervals));
    };
    // Skip the first frames after mount (layout, image decode).
    setTimeout(() => requestAnimationFrame(tick), 500);
  });
}
