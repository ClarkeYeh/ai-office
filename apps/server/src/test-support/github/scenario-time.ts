import type { Clock } from '../../ports/services.js';
/** Capture actual clock reads: network latency affects retry windows and cursors. */
export function scenarioTime(
  mode: 'live' | 'replay',
  recorded: number[] = [],
  signal?: AbortSignal,
) {
  const reads: number[] = [];
  let offset = 0;
  const clock: Clock = {
    now: () => {
      if (mode === 'live') {
        const now = Date.now();
        reads.push(now);
        return new Date(now);
      }
      const value = recorded[offset++];
      if (value === undefined)
        throw new Error('Unrecorded scenario clock read');
      return new Date(value);
    },
  };
  return {
    clock,
    reads,
    sleep: async (ms: number) => {
      if (mode === 'live') {
        if (signal?.aborted) throw new Error('GitHub case aborted');
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(new Error('GitHub case aborted'));
          };
          const timer = setTimeout(() => {
            signal?.removeEventListener('abort', abort);
            resolve();
          }, ms);
          signal?.addEventListener('abort', abort, { once: true });
        });
      }
    },
    assertConsumed: () => {
      if (mode === 'replay' && offset !== recorded.length)
        throw new Error('Unconsumed scenario clock reads');
    },
  };
}
