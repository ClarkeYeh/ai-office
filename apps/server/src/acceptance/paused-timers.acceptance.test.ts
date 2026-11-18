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
  'FX8 / FX8b acceptance: pause time does not count toward timers',
  { timeout: 60_000 },
  () => {
    it('gives a worker deadline its remaining time back after a hijack pause', async () => {
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
      // FX8b: the pause did not count, so the deadline is rescheduled under
      // its own id with the time it had left, not fired at once.
      events = await until(
        () => o.events(workflowId),
        (all) =>
          all.filter((e) => e.type === 'timer.scheduled' && itemTimeout(e))
            .length === 2,
        'the item deadline rescheduled after the reclaim',
      );
      const resumed = events.findLast((e) => e.type === 'workflow.resumed')!;
      const [armed, shifted] = events.filter(
        (e) => e.type === 'timer.scheduled' && itemTimeout(e),
      );
      expect(shifted!.payload.timerId).toBe(armed!.payload.timerId);
      expect(shifted!.seq).toBeGreaterThan(resumed.seq);
      const left =
        Date.parse(String(shifted!.payload.fireAt)) -
        Date.parse(String(resumed.occurredAt));
      expect(left).toBeGreaterThan(40 * MINUTE_MS);
      expect(left).toBeLessThanOrEqual(45 * MINUTE_MS);
      expect(
        events.filter((e) => e.type === 'timer.fired' && itemTimeout(e)),
      ).toEqual([]);
      expect(events.some((e) => e.type === 'budget.exceeded')).toBe(false);

      // Once the remaining time has passed, it fires once, counting work only.
      vi.setSystemTime(Date.now() + 46 * MINUTE_MS);
      await o.restart();
      events = await until(
        () => o.events(workflowId),
        (all) => all.some(deadlineNudge),
        'the item-timeout nudge after the remaining time',
      );
      expect(
        events.filter((e) => e.type === 'timer.fired' && itemTimeout(e)),
      ).toHaveLength(1);
      const exceeded = events.find((e) => e.type === 'budget.exceeded');
      expect(exceeded?.payload).toMatchObject({
        scope: 'item',
        metric: 'wallclock',
      });
      expect(Number(exceeded?.payload.used)).toBeLessThan(50);
      expect(events.filter(deadlineNudge)).toHaveLength(1);
    });
  },
);
