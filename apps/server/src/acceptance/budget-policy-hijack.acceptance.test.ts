import { afterEach, describe, expect, it } from 'vitest';
import type { ScenarioContext } from '../adapters/runtime-fake/index.js';
import { implementation } from '../adapters/runtime-fake/mainline-actions.js';
import type { RuntimeEvent } from '../ports/runtime-events.js';
import {
  chargeUsage,
  closeAll,
  isEnded,
  liveAgents,
  office,
  until,
} from './test-support/harness.js';
import type { Json, Office } from './test-support/harness.js';

afterEach(closeAll);

const has = (events: Json[], type: string) =>
  events.some((e) => e.type === type);
const eventsUntil = (o: Office, workflowId: string, type: string) =>
  until(
    () => o.events(workflowId),
    (events) => has(events, type),
    type,
  );

describe(
  'M1 acceptance: budget, policy and hijack',
  { timeout: 60_000 },
  () => {
    it('opens the budget gate at 1x, then hard-stops every live agent of the stage (on-demand included) at 2x', async () => {
      const o = await office({
        roles: {
          // The worker asks once, then keeps working without pushing.
          worker: {
            spawn: [{ type: 'ask', afterMs: 5, body: 'Which flag name?' }],
            answer: [],
          },
          oncall: {
            spawn: [{ type: 'done', afterMs: 5 }],
            // Questions are JSON; budget reminders are prose and need no reply.
            send: (context: ScenarioContext) => {
              const body = context.message?.body ?? '';
              if (!body.startsWith('{')) return [];
              return [
                {
                  type: 'submit',
                  afterMs: 5,
                  submission: {
                    kind: 'answer-question',
                    payload: {
                      questionId: (JSON.parse(body) as Json).questionId,
                      body: 'Use darkMode',
                    },
                  },
                },
              ];
            },
          },
        },
      });
      const workflowId = await o.start({
        budgetOverrides: { stages: { implement: { tokens: 1000 } } },
      });
      await o.drive(workflowId, async () =>
        has(await o.events(workflowId), 'message.answered'),
      );
      const events = await o.events(workflowId);
      const worker = events.find(
        (e) => e.type === 'seat.spawned' && e.payload.itemKey === 'feature',
      )!.payload.attemptId as string;
      const oncall = events.find(
        (e) => e.type === 'ondemand.started' && e.payload.purpose === 'oncall',
      )!.payload.attemptId as string;
      // The worker and the on-call lead (on-demand) are both alive.
      expect(liveAgents(o.world)).toBe(2);

      await chargeUsage(o, workflowId, worker, 1100);
      await eventsUntil(o, workflowId, 'budget.exceeded');
      const exceeded = (await o.gates(workflowId)).filter(
        (g) => g.status === 'open',
      );
      expect(
        exceeded.map((g) => [
          g.exceptionKind,
          g.options.map((x: Json) => x.optionId),
        ]),
      ).toEqual([['budget-exceeded', ['top-up', 'finish', 'abort']]]);
      // An exception gate does not stop agents.
      expect(liveAgents(o.world)).toBe(2);

      // More usage past 1x does not open a second budget gate (dedupe).
      await chargeUsage(o, workflowId, oncall, 200);
      await until(
        () => o.events(workflowId),
        (e) => e.filter((x) => x.type === 'usage.tokens').length === 2,
        'the on-call usage',
      );
      expect(
        (await o.gates(workflowId)).filter((g) => g.status === 'open'),
      ).toHaveLength(1);

      await chargeUsage(o, workflowId, worker, 800); // 2100 > 2 x 1000
      const hard = await eventsUntil(o, workflowId, 'budget.hard_limit');
      expect(
        hard.find((e) => e.type === 'budget.hard_limit')!.payload,
      ).toMatchObject({ scope: 'stage', used: 2100, threshold: 2000 });
      await until(
        async () => liveAgents(o.world),
        (n) => n === 0,
        'the hard stop',
      );
      const after = await o.events(workflowId);
      // The 1x gate is superseded by the hard-limit gate (the stopped worker's
      // item may also need attention).
      const gates = await o.gates(workflowId);
      const open = gates
        .filter((g) => g.status === 'open')
        .map((g) => g.exceptionKind);
      expect(open).toContain('budget-hard-limit');
      expect(open).not.toContain('budget-exceeded');
      expect(
        after.some(
          (e) => e.type === 'gate.closed' && e.payload.reason === 'superseded',
        ),
      ).toBe(true);
      // Both the worker and the on-demand instance were stopped.
      const stopped = after
        .filter(
          (e) =>
            e.type === 'command.issued' && e.payload.kind === 'runtime.stop',
        )
        .map((e) => e.payload.commandId as string);
      expect(stopped.some((id) => id.includes(worker))).toBe(true);
      expect(stopped.some((id) => id.includes(oncall))).toBe(true);
      await until(
        () => o.events(workflowId),
        (e) =>
          e.some(
            (x) =>
              x.type === 'ondemand.stopped' && x.payload.attemptId === oncall,
          ),
        'the on-call instance to be recorded as stopped',
      );

      // The owner aborts at the hard limit.
      const decided = await o.decide(
        gates.find((g) => g.exceptionKind === 'budget-hard-limit')!,
        { decision: 'option', optionId: 'abort' },
      );
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);
      const final = await until(
        () => o.readModel(workflowId),
        isEnded,
        'the cancellation',
      );
      expect(final.status).toBe('cancelled');
    });

    it('stops the agent and pauses on a high-severity policy hit, then continues when the owner allows it', async () => {
      let flagged = false;
      const o = await office({
        roles: {
          worker: {
            spawn: () =>
              flagged
                ? implementation
                : ((flagged = true),
                  [
                    {
                      type: 'policy',
                      afterMs: 5,
                      command: 'git push --force origin main',
                    },
                  ]),
          },
        },
      });
      const workflowId = await o.start();
      const seen: Json[] = [];
      const final = await o.drive(workflowId, isEnded, {
        onException: async (gate) => {
          seen.push(gate);
          if (gate.exceptionKind === 'anomaly') {
            const model = await o.readModel(workflowId);
            expect(model.pausedReasons).toContain('anomaly');
            const events = await o.events(workflowId);
            const violation = events.find(
              (e) => e.type === 'seat.policy_violation',
            )!;
            expect(violation.payload.hits).toEqual([
              expect.objectContaining({
                rule: 'push-default-branch',
                severity: 'high',
              }),
            ]);
            expect(
              events.some(
                (e) =>
                  e.type === 'command.issued' &&
                  e.payload.kind === 'runtime.stop' &&
                  e.payload.commandId.includes('/policy/'),
              ),
            ).toBe(true);
            await o.decide(gate, { decision: 'option', optionId: 'continue' });
          } else {
            // The stopped worker's item fails; retry it.
            await o.decide(gate, { decision: 'option', optionId: 'retry' });
          }
          return true;
        },
      });
      expect(final.status).toBe('completed');
      expect(seen[0]!.exceptionKind).toBe('anomaly');
      // The raw command never reached the event log, only rule metadata.
      expect(JSON.stringify(await o.events(workflowId))).not.toContain(
        'push --force',
      );
    });

    it('stops a worker that run-uses another run once, then reclaims through the hijack gate', async () => {
      let flagged = false;
      let hijack = false;
      const runUse = {
        type: 'policy' as const,
        afterMs: 5,
        command: 'orca orchestration run-use run-1',
      };
      const o = await office({
        roles: {
          worker: {
            spawn: () =>
              flagged
                ? implementation
                : ((flagged = true), [runUse, { ...runUse, afterMs: 10 }]),
          },
        },
        // Ownership observation reports the takeover the worker caused (P4).
        intercept: async (operation, args, call) => {
          const delivery = (await call()) as { events: RuntimeEvent[] };
          if (
            operation === 'observe' &&
            !hijack &&
            delivery.events.some((e) => e.type === 'agent.output')
          ) {
            hijack = true;
            delivery.events.push({
              type: 'runtime.identity_hijacked',
              externalKey: 'hijack-run-use',
              occurredAt: new Date().toISOString(),
              run: 'run-1',
              coordinatorHandle: 'term_worker',
              consumerGeneration: 2,
            });
          }
          return delivery;
        },
      });
      const workflowId = await o.start();
      const seen: string[] = [];
      const final = await o.drive(workflowId, isEnded, {
        onException: async (gate) => {
          seen.push(gate.exceptionKind as string);
          const optionId =
            gate.exceptionKind === 'hijacked'
              ? 'reclaim'
              : gate.exceptionKind === 'anomaly'
                ? 'continue'
                : // The stopped worker's item fails; retry it.
                  'retry';
          const decided = await o.decide(gate, {
            decision: 'option',
            optionId,
          });
          expect(decided.status, JSON.stringify(decided.body)).toBe(200);
          return true;
        },
      });
      expect(final.status).toBe('completed');
      expect(seen).toContain('hijacked');
      const events = await o.events(workflowId);
      const stops = events.filter(
        (e) =>
          e.type === 'command.issued' &&
          e.payload.kind === 'runtime.stop' &&
          e.payload.commandId.endsWith('/run-use'),
      );
      expect(stops).toHaveLength(1);
      const violations = events.filter(
        (e) => e.type === 'seat.policy_violation',
      );
      expect(violations.length).toBeGreaterThan(0);
      expect(stops[0]!.payload.commandId).toContain(
        `/stop/${violations[0]!.payload.attemptId}/`,
      );
      expect(
        events.find(
          (e) =>
            e.type === 'command.succeeded' &&
            e.payload.kind === 'runtime.reclaimSession',
        )?.payload.result,
      ).toEqual({ reclaimed: true });
      expect(JSON.stringify(events)).not.toContain('run-use run-1');
    });

    it.each(['reclaim', 'abort'] as const)(
      'pauses on run hijack and lets the owner %s',
      async (choice) => {
        let hijack = false;
        const o = await office({
          // Orca's observation reports another coordinator owning the run.
          intercept: async (operation, args, call) => {
            // Hijack during wrap-up: the integrator's report then races the
            // pause, which once stranded the integrate stage after resume.
            if (
              operation === 'spawnAgent' &&
              JSON.stringify(args).includes('integrator')
            )
              hijack = true;
            const delivery = (await call()) as { events: RuntimeEvent[] };
            if (operation === 'observe' && hijack) {
              hijack = false;
              delivery.events.push({
                type: 'runtime.identity_hijacked',
                externalKey: `hijack-${choice}`,
                occurredAt: new Date().toISOString(),
                run: 'run-1',
                coordinatorHandle: 'term_other',
                consumerGeneration: 2,
              });
            }
            return delivery;
          },
        });
        const workflowId = await o.start();
        await o.drive(workflowId, async () =>
          has(await o.events(workflowId), 'workitem.merged'),
        );
        const reclaims: unknown[] = [];
        const final = await o.drive(workflowId, isEnded, {
          onException: async (gate) => {
            expect(gate.exceptionKind).toBe('hijacked');
            expect(gate.options.map((x: Json) => x.optionId)).toEqual([
              'reclaim',
              'abort',
            ]);
            expect((await o.readModel(workflowId)).pausedReasons).toContain(
              'hijacked',
            );
            reclaims.push(choice);
            const decided = await o.decide(gate, {
              decision: 'option',
              optionId: choice,
            });
            expect(decided.status, JSON.stringify(decided.body)).toBe(200);
            return true;
          },
        });
        expect(reclaims).toEqual([choice]);
        const events = await o.events(workflowId);
        if (choice === 'reclaim') {
          expect(final.status).toBe('completed');
          expect(final.pausedReasons).toEqual([]);
          expect(
            events.find(
              (e) =>
                e.type === 'command.succeeded' &&
                e.payload.kind === 'runtime.reclaimSession',
            )?.payload.result,
          ).toEqual({ reclaimed: true });
        } else {
          expect(final.status).toBe('cancelled');
          expect(liveAgents(o.world)).toBe(0);
        }
      },
    );
  },
);
