export const TICK_MS = 30_000;

/** Global wall clock for `now`-based selectors; one interval only while subscribed. */
export interface Ticker {
  now(): number;
  subscribe(listener: () => void): () => void;
}

export function createTicker(
  options: { intervalMs?: number; clock?: () => number } = {},
): Ticker {
  const intervalMs = options.intervalMs ?? TICK_MS;
  const clock = options.clock ?? (() => Date.now());
  const listeners = new Set<() => void>();
  let current = clock();
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    now: () => current,
    subscribe(listener) {
      listeners.add(listener);
      if (!timer) {
        current = clock();
        timer = setInterval(() => {
          current = clock();
          for (const notify of [...listeners]) notify();
        }, intervalMs);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
  };
}
