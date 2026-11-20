import { expect, it } from 'vitest';
import { realGithubSuite } from '../../test-support/github/gating.js';
import { withLiveRun } from './test-support/live-binding.js';
import { mixedOffice, type MixedOffice } from './test-support/mixed-office.js';
import { runFaults } from './test-support/scenario.js';
import { faultHttpPath } from './test-support/tapes.js';

/*
 * M3-T15 step 12, live once: the first createIssue's real response is
 * recorded, then lost below scm-github while new rows list late; later every
 * request fails (network outage) until the SCM breaker opens and the workflow
 * is cancelled. Cleanup and scan run as in step 13.
 */
realGithubSuite('M3-T15 step 12 fault injection (live spike)', () => {
  it('keeps one Issue and reaches the runtime during an SCM outage', async () => {
    const run = await withLiveRun(
      'faults',
      async (binding, steps) => {
        let office: MixedOffice | undefined;
        try {
          office = await mixedOffice(binding);
          const value = await runFaults(office, steps);
          return { value, steps: value.steps };
        } finally {
          await office?.close();
        }
      },
      async (recorder) => recorder.save(faultHttpPath),
    );
    console.info(JSON.stringify(run.steps));
    expect(run.steps.every((s) => s.ok)).toBe(true);
  }, 1_800_000);
});
