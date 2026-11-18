import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  RoleBehavior,
  RuntimeScenario,
  ScenarioStep,
} from '../../adapters/runtime-fake/index.js';
import { mainlineScenario } from '../../adapters/runtime-fake/mainline.js';
import { implementation } from '../../adapters/runtime-fake/mainline-actions.js';
import {
  closeAll,
  isEnded,
  office,
  tempHome,
} from '../test-support/harness.js';
import type { Json } from '../test-support/harness.js';

/*
 * M2-T17 spawn-stall acceptance (a): the composed backend in fake mode with a
 * short `engine.spawnStallMs` (SPEC rev2.11.1 §7.1/§8.3, §27). A worker that
 * is silent after spawn gets exactly one nudge after one period and a
 * `spawn-stall` exception gate after the second; nothing ever becomes `error`.
 */
afterEach(closeAll);

const STALL_MS = 1500;

/** The `worker` role is silent on its first spawn only (later spawns behave). */
function firstWorkerSilent(first: RoleBehavior): RuntimeScenario {
  let spawns = 0;
  const roles = new Proxy(mainlineScenario.roles, {
    get(target, property, receiver) {
      if (property !== 'worker') return Reflect.get(target, property, receiver);
      return spawns++ === 0 ? first : target.worker;
    },
  });
  return { ...mainlineScenario, roles };
}

async function stalledOffice(first: RoleBehavior) {
  const home = tempHome();
  writeFileSync(
    join(home, 'config.toml'),
    `[engine]\nspawnStallMs = ${STALL_MS}\n`,
  );
  return office({ home, scenario: firstWorkerSilent(first) });
}

const of = (events: Json[], type: string) =>
  events.filter((e) => e.type === type);
const stallNudges = (events: Json[]) =>
  of(events, 'message.nudge').filter((e) => e.payload.reason === 'spawn-stall');
const stallGates = (events: Json[]) =>
  of(events, 'gate.opened').filter(
    (e) => e.payload.exceptionKind === 'spawn-stall',
  );
const errors = (events: Json[]) =>
  of(events, 'seat.status').filter((e) => e.payload.state === 'error');

describe(
  'M2-T17 spawn stall (a): composed fake backend',
  { timeout: 60_000 },
  () => {
    for (const choice of [
      { decision: 'option', optionId: 'retry' },
      { decision: 'option', optionId: 'reassign', agent: 'claude-code' },
    ] as const)
      it(`nudges once, opens spawn-stall after 2× and recovers by ${choice.optionId}`, async () => {
        const o = await stalledOffice({ silent: true });
        const workflowId = await o.start();
        const gates: Json[] = [];
        const final = await o.drive(workflowId, isEnded, {
          onException: async (gate) => {
            expect(gate.exceptionKind).toBe('spawn-stall');
            gates.push(gate);
            const decided = await o.decide(gate, choice);
            expect(decided.status, JSON.stringify(decided.body)).toBe(200);
            return true;
          },
        });
        expect(final.status).toBe('completed');
        const events = await o.events(workflowId);
        const stalled = stallGates(events);
        expect(stalled).toHaveLength(1);
        expect(gates).toHaveLength(1);
        expect(gates[0]!.options.map((x: Json) => x.optionId)).toEqual([
          'retry',
          'reassign',
          'abort',
        ]);
        // Exactly one nudge for the stalled attempt, before its gate.
        const attemptId = stallNudges(events)[0]?.payload.attemptId;
        expect(stallNudges(events)).toHaveLength(1);
        expect(stallNudges(events)[0]!.seq).toBeLessThan(stalled[0]!.seq);
        // The stalled attempt was stopped before the gate opened.
        expect(
          of(events, 'command.issued').some(
            (e) =>
              e.payload.kind === 'runtime.stop' &&
              e.attemptId === attemptId &&
              e.seq < stalled[0]!.seq,
          ),
        ).toBe(true);
        expect(errors(events)).toEqual([]);
        const dispatched = of(events, 'workitem.dispatched')
          .filter((e) => e.payload.itemKey === 'feature')
          .map((e) => [e.payload.attempt, e.payload.agent]);
        expect(dispatched).toEqual([
          [1, 'codex'],
          [2, choice.optionId === 'reassign' ? 'claude-code' : 'codex'],
        ]);
      });

    it('never opens the gate when activity arrives between 1× and 2×', async () => {
      // Idle after spawn; the 1× nudge wakes it, and it shows activity (a
      // tool call) at 1.5×, then finishes normally.
      const woken: ScenarioStep[] = [
        {
          type: 'output',
          afterMs: STALL_MS / 2,
          blocks: [{ type: 'tool_use', id: 'tool-1', name: 'Edit', input: {} }],
        },
        ...implementation.map((s) => ({
          ...s,
          afterMs: (s.afterMs ?? 0) + STALL_MS * 0.6,
        })),
      ];
      const o = await stalledOffice({ spawn: [], send: woken });
      const workflowId = await o.start();
      const final = await o.drive(workflowId, isEnded);
      expect(final.status).toBe('completed');
      const events = await o.events(workflowId);
      expect(stallNudges(events)).toHaveLength(1);
      expect(stallGates(events)).toEqual([]);
      expect(errors(events)).toEqual([]);
    });
  },
);
