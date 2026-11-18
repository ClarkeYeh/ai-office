import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeEvent } from '../ports/runtime-events.js';
import { closeAll, office, until } from './test-support/harness.js';
import type { Json, Office } from './test-support/harness.js';

afterEach(async () => {
  vi.useRealTimers();
  await closeAll();
});

const MINUTE_MS = 60_000;
const itemTimeout = (e: Json) =>
  String(e.payload.timerId).includes('/item-timeout/');
// Other safety nets (e.g. spawn stall) may nudge too; follow the deadline's.
const deadlineNudge = (e: Json) =>
  e.type === 'message.nudge' && e.payload.reason === 'item-timeout';

describe(
  'FX8 acceptance: timers held through a pause',
  { timeout: 60_000 },
  () => {
    it('fires a worker deadline that elapsed during a hijack pause once the owner reclaims', async () => {
      let hijack = false;
      let workflowId = '';
      const o: Office = await office({
        // The worker never finishes, so only its item deadline can catch it.
        roles: { worker: { spawn: [] } },
        intercept: async (operation, _args, call) => {
          const delivery = (await call()) as { events: RuntimeEvent[] };
          if (operation === 'observe' && hijack) {
            hijack = false;
            delivery.events.push({
              type: 'runtime.identity_hijacked',
              externalKey: 'hijack-fx8',
              occurredAt: new Date().toISOString(),
              run: 'run-1',
              coordinatorHandle: 'term_other',
              consumerGeneration: 2,
            });
          }
          return delivery;
        },
      });
      workflowId = await o.start();
      await o.drive(workflowId, async () =>
        (await o.events(workflowId)).some(
          (e) => e.type === 'timer.scheduled' && itemTimeout(e),
        ),
      );
      hijack = true;
      await until(
        () => o.readModel(workflowId),
        (model) => (model.pausedReasons as string[]).includes('hijacked'),
        'hijack pause',
      );

      // The pause outlasts the 45-minute item deadline; a restart re-arms the
      // overdue timer, which the Scheduler delivers at once while still paused.
      vi.useFakeTimers({
        toFake: ['Date'],
        shouldAdvanceTime: true,
        now: Date.now() + 50 * MINUTE_MS,
      });
      await o.restart();
      await o.server.runners.idle();
      let events = await o.events(workflowId);
      expect(
        events.filter((e) => e.type === 'timer.fired' && itemTimeout(e)),
      ).toEqual([]);
      expect(events.some((e) => e.type === 'budget.exceeded')).toBe(false);

      const gate = (await o.gates(workflowId)).find(
        (g) => g.status === 'open' && g.exceptionKind === 'hijacked',
      )!;
      const decided = await o.decide(gate, {
        decision: 'option',
        optionId: 'reclaim',
      });
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);
      events = await until(
        () => o.events(workflowId),
        (all) => all.some(deadlineNudge),
        'the item-timeout nudge after the reclaim',
      );
      const resumed = events.findLast((e) => e.type === 'workflow.resumed')!;
      const fired = events.filter(
        (e) => e.type === 'timer.fired' && itemTimeout(e),
      );
      expect(fired).toHaveLength(1);
      expect(fired[0]!.seq).toBeGreaterThan(resumed.seq);
      expect(
        events.find((e) => e.type === 'budget.exceeded')?.payload,
      ).toMatchObject({ scope: 'item', metric: 'wallclock' });
      expect(events.filter(deadlineNudge)).toHaveLength(1);
    });
  },
);
