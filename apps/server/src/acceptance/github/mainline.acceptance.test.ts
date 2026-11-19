import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeBinding } from './test-support/fake-binding.js';
import { mixedOffice, type MixedOffice } from './test-support/mixed-office.js';
import { runMixedMainline, semantics } from './test-support/scenario.js';
import { liveTracePath, type LiveTrace } from './test-support/tapes.js';

let office: MixedOffice | undefined;
afterEach(async () => {
  await office?.close();
  office = undefined;
});

/*
 * M3-T15 CI replay: steps 1–11 of the mixed acceptance through the composed
 * `--dev --fake github-mainline` server with `testOnly.scm`, on scm-fake behind
 * the same T7 scoping and push bridge as the live spike run
 * (`mainline.github.test.ts`). A full workflow cannot be replayed call by call
 * (the observation loop's timing decides the HTTP order), so the live run's
 * recording is checked here by event-sequence semantics.
 */
describe('M3-T15 mixed acceptance (CI replay)', { timeout: 300_000 }, () => {
  it('runs steps 1–11 and matches the recorded live event semantics', async () => {
    office = await mixedOffice(fakeBinding());
    const run = await runMixedMainline(office);
    expect(run.steps.every((s) => s.ok)).toBe(true);
    expect(run.steps.map((s) => s.step)).toEqual([
      1, 2, 3, 2, 1, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    if (!existsSync(liveTracePath)) return;
    const recorded = JSON.parse(
      readFileSync(liveTracePath, 'utf8'),
    ) as LiveTrace;
    expect(recorded.steps.every((s) => s.ok)).toBe(true);
    expect(semantics(run.events)).toEqual(recorded.semantics);
  });
});
