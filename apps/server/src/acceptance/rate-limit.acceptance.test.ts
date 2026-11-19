import { afterEach, describe, expect, it } from 'vitest';
import type { ScenarioStep } from '../adapters/runtime-fake/index.js';
import { implementation } from '../adapters/runtime-fake/mainline-actions.js';
import { closeAll, isEnded, office } from './test-support/harness.js';

afterEach(closeAll);

const RESET_MS = 600;

describe(
  'M2-T19 acceptance: provider rate limit (S26, provisional)',
  { timeout: 60_000 },
  () => {
    it('pauses the rate-limited worker, lifts at resetsAt and finishes without an error or exception gate', async () => {
      const o = await office({
        roles: {
          // Rate-limited right after spawn; resumes once the window resets.
          worker: {
            spawn: (): ScenarioStep[] => [
              {
                type: 'rate-limited',
                afterMs: 5,
                evidence: 'worker-show',
                resetsAt: new Date(Date.now() + RESET_MS).toISOString(),
              },
              ...implementation.map((step) => ({
                ...step,
                afterMs: (step.afterMs ?? 0) + RESET_MS + 200,
              })),
            ],
          },
        },
      });
      const workflowId = await o.start();
      // `drive` fails on any exception gate.
      const workflow = await o.drive(workflowId, isEnded);
      expect(workflow.status).toBe('completed');

      const events = await o.events(workflowId);
      const worker = events.find(
        (e) => e.type === 'seat.spawned' && e.payload.purpose === 'worker',
      )!.payload.attemptId as string;
      const statuses = events.filter(
        (e) =>
          e.type === 'seat.status' &&
          e.payload.attemptId === worker &&
          'rateLimited' in e.payload,
      );
      expect(statuses.map((e) => e.payload.rateLimited)).toEqual([
        expect.objectContaining({ evidence: 'worker-show' }),
        null,
      ]);
      // Its engine timers were paused, not counted, then resumed.
      const paused = events.filter(
        (e) =>
          e.type === 'timer.cancelled' && e.payload.reason === 'rate_limited',
      );
      expect(paused.length).toBeGreaterThan(0);
      for (const pause of paused)
        expect(
          events.some(
            (e) =>
              e.type === 'timer.scheduled' &&
              e.seq > pause.seq &&
              e.payload.timerId === pause.payload.timerId,
          ),
        ).toBe(true);
      expect(events.some((e) => e.type === 'error.recorded')).toBe(false);
      expect(
        events.some(
          (e) => e.type === 'seat.status' && e.payload.state === 'error',
        ),
      ).toBe(false);

      const view = (await o.readModel(workflowId)).seats
        .flatMap((s: { attempts: { attemptId: string }[] }) => s.attempts)
        .find((a: { attemptId: string }) => a.attemptId === worker);
      expect(view.rateLimited).toBeNull();
    });
  },
);
