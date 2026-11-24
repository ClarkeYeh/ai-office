import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { expectM3Replay } from '../../test-support/acceptance-check/replay-assertions.js';
import { fakeBinding } from './test-support/fake-binding.js';
import { mixedOffice } from './test-support/mixed-office.js';
import {
  runMixedMainline,
  semantics,
  type MixedRun,
} from './test-support/scenario.js';
import { liveTracePath, type LiveTrace } from './test-support/tapes.js';

/*
 * M3-T15 CI replay: steps 1–11 of the mixed acceptance through the composed
 * `--dev --fake github-mainline` server with `testOnly.scm`, on scm-fake behind
 * the same T7 scoping and push bridge as the live spike run
 * (`mainline.github.test.ts`). A full workflow cannot be replayed call by call
 * (the observation loop's timing decides the HTTP order), so the live run's
 * recording is checked here by event-sequence semantics.
 */
describe('M3-T15 mixed acceptance (CI replay)', { timeout: 30_000 }, () => {
  let run: MixedRun;
  beforeAll(async () => {
    // Keep the production 15 s SCM cadence and all scenario assertions. Only
    // scenario waits advance time; HTTP requests finish before the next tick,
    // preserving the stale-screen/owner-edit race and avoiding a clock pump.
    vi.useFakeTimers({
      toFake: [
        'Date',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
      ],
    });
    vi.setSystemTime(new Date('2026-11-24T00:00:00.000Z'));
    let office;
    try {
      office = await mixedOffice(fakeBinding(), async (ms) => {
        await vi.advanceTimersByTimeAsync(Math.max(ms, 250));
      });
      run = await runMixedMainline(office);
    } finally {
      try {
        await office?.close();
      } finally {
        vi.useRealTimers();
      }
    }
  }, 30_000);

  it('runs steps 1–11 and matches the recorded live event semantics', () => {
    expect(run.steps.every((s) => s.ok)).toBe(true);
    expect(run.steps.map((s) => s.step)).toEqual([
      1, 2, 3, 2, 1, 4, 5, 6, 7, 8, 9, 10, 11, 13,
    ]);
    if (!existsSync(liveTracePath)) return;
    const recorded = JSON.parse(
      readFileSync(liveTracePath, 'utf8'),
    ) as LiveTrace;
    expect(recorded.steps.every((s) => s.ok)).toBe(true);
    expect(semantics(run.events)).toEqual(recorded.semantics);
  });

  // Vitest isolates test files. Keeping both consumers here shares one actual
  // replay without a stale generated fixture or cross-process cache files.
  it('M3 mixed acceptance replay: on-call, rework and waiting_input; the final PR stays unmerged', () => {
    expectM3Replay(run.events);
  });
});
