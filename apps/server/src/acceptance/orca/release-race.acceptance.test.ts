import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeScenario } from '../../adapters/runtime-fake/index.js';
import { mainlineScenario } from '../../adapters/runtime-fake/mainline.js';
import {
  closeAll,
  isEnded,
  liveAttemptsAtStageGates,
  office,
  until,
} from '../test-support/harness.js';
import type { Json } from '../test-support/harness.js';

/*
 * M2-T17 defect D8 regression (hybrid #8 trace): when a stage closes on a
 * submission, the engine issues runtime.stop and runtime.release together.
 * On real Orca the release can arrive before the stop settles and is refused;
 * the adapter now reports that transiently and the executor retries, so no
 * attempt is still live when the next stage gate opens.
 */
afterEach(closeAll);

const slowStops: RuntimeScenario = {
  ...mainlineScenario,
  roles: Object.fromEntries(
    Object.entries(mainlineScenario.roles).map(([role, behavior]) => [
      role,
      { ...behavior, stopSettleMs: 50 },
    ]),
  ),
};

describe(
  'M2-T17 D8: release racing a stop (composed fake)',
  { timeout: 60_000 },
  () => {
    it('retries the release and leaves no live attempt at any stage gate', async () => {
      const o = await office({ scenario: slowStops });
      const workflowId = await o.start();
      const final = await o.drive(workflowId, isEnded, { timeoutMs: 15_000 });
      expect(final.status).toBe('completed');
      const events = await o.events(workflowId);
      expect(liveAttemptsAtStageGates(events)).toEqual(
        liveAttemptsAtStageGates(events).map((g: Json) => ({ ...g, live: [] })),
      );
      // Every stopped attempt is released once its retry (≈1 s backoff) runs.
      const unreleased = (log: Json[]) => {
        const released = new Set(
          log
            .filter((e) => e.type === 'seat.released')
            .map((e) => e.payload.attemptId),
        );
        return [
          ...new Set(
            log
              .filter(
                (e) =>
                  e.type === 'command.issued' &&
                  e.payload.kind === 'runtime.stop',
              )
              .map((e) => e.attemptId as string),
          ),
        ].filter((a) => !released.has(a));
      };
      // M2-FX12: stage gates now wait for every close release, so most
      // retries have landed by completion; any left must still land.
      await until(
        () => o.events(workflowId),
        (log) => unreleased(log).length === 0,
        'every stopped attempt released after the retry',
        8_000,
      );
    });
  },
);
