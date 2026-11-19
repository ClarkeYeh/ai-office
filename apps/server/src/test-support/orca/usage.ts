import { SessionLogUsage } from '../../adapters/usage-sessionlog/index.js';
import type {
  UsageLocateRef,
  UsagePort,
  UsageSample,
} from '../../ports/usage.js';
import type { UsageCursor } from '../../ports/refs.js';
import type { OrcaHarness } from './harness.js';

/** Read numeric session-log samples for calibration; never impose a usage limit. */
export async function collectDispatchUsage(
  harness: Pick<OrcaHarness, 'collectUsage'>,
  attempts: readonly UsageLocateRef[],
  usage: UsagePort = new SessionLogUsage(),
): Promise<void> {
  await harness.collectUsage(async () => {
    const totals: { provider: string; input: number; output: number }[] = [];
    for (const attempt of attempts) {
      const ref = await usage.locate(attempt);
      if (!ref) continue;
      let cursor: UsageCursor | null = null;
      const samples = new Map<string, UsageSample>();
      // Bound file reads, not tokens: an unexpectedly growing file cannot hang cleanup.
      for (let page = 0; page < 1024; page++) {
        const batch = await usage.read(ref, cursor);
        for (const sample of batch.samples)
          samples.set(sample.externalKey, sample);
        if (batch.cursor === cursor) break;
        cursor = batch.cursor;
      }
      let input = 0,
        output = 0;
      for (const sample of samples.values()) {
        const next =
          sample.inputUncached + sample.cacheRead + sample.cacheWrite;
        if (sample.cumulative) {
          input = Math.max(input, next);
          output = Math.max(output, sample.output);
        } else {
          input += next;
          output += sample.output;
        }
      }
      totals.push({ provider: attempt.agent, input, output });
    }
    return totals;
  });
}
