import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, it } from 'vitest';
import { realGithubSuite } from '../../test-support/github/gating.js';
import { withLiveRun } from './test-support/live-binding.js';
import { mixedOffice, type MixedOffice } from './test-support/mixed-office.js';
import {
  runMixedMainline,
  semantics,
  type MixedRun,
} from './test-support/scenario.js';
import {
  liveHttpPath,
  liveTracePath,
  type LiveTrace,
} from './test-support/tapes.js';

/*
 * M3-T15 main acceptance, live on ClarkeYeh/ai-office-spike: steps 1–11 and
 * 13 (M3_PLAN §6). Serial, spike only, never merges into main: step 11 closes
 * and reopens the final PR, and cleanup closes it. `AIO_GITHUB_RECORD=1`
 * writes the CI replay's event semantics and the sanitized HTTP recording.
 */
realGithubSuite('M3-T15 mixed acceptance (live spike)', () => {
  it('runs steps 1–11 on GitHub and cleans up to zero', async () => {
    const run = await withLiveRun<MixedRun>(
      'mainline',
      async (binding, steps) => {
        let office: MixedOffice | undefined;
        try {
          office = await mixedOffice(binding);
          const value = await runMixedMainline(office, steps);
          return { value, steps: value.steps };
        } finally {
          await office?.close();
        }
      },
      async (recorder, value) => {
        await mkdir(dirname(liveTracePath), { recursive: true });
        const trace: LiveTrace = {
          format: 1,
          source: 'live',
          steps: value.steps,
          semantics: semantics(value.events),
        };
        await writeFile(liveTracePath, JSON.stringify(trace, null, 2) + '\n', {
          flag: 'wx',
        });
        await recorder.save(liveHttpPath);
      },
    );
    console.info(JSON.stringify({ steps: run.steps, objects: run.objects }));
    expect(run.steps.every((s) => s.ok)).toBe(true);
  }, 3_600_000);
});
