import { afterEach, describe, expect, it } from 'vitest';
import type {
  RoleBehavior,
  RuntimeScenario,
  ScenarioContext,
  ScenarioScript,
  ScenarioStep,
} from '../../adapters/runtime-fake/index.js';
import { mainlineScenario } from '../../adapters/runtime-fake/mainline.js';
import { closeAll, isEnded, office } from '../test-support/harness.js';
import type { Json } from '../test-support/harness.js';

/*
 * M2-T17 defect D5 regression (hybrid #5 trace): on real Orca a keep-open
 * worker is observed `idle` a few seconds after worker_done (pm done→idle
 * before the engineer reported done). The engine waits for every participant
 * to be `done` at once, so a downgrade to `idle` stalled every meeting before
 * round 1. Idle after done must never downgrade the attempt.
 */
afterEach(closeAll);

const IDLE_AFTER_MS = 5;

const steps = (script: ScenarioScript | undefined, context: ScenarioContext) =>
  script === undefined
    ? undefined
    : typeof script === 'function'
      ? script(context)
      : script;

/** Every `done` is followed by a real-Orca `idle`; `delayMs` staggers a role. */
function idleAfterDone(behavior: RoleBehavior, delayMs = 0): RoleBehavior {
  const wrap =
    (script: ScenarioScript | undefined) =>
    (context: ScenarioContext): readonly ScenarioStep[] =>
      (steps(script, context) ?? []).map((s) => ({
        ...s,
        afterMs: (s.afterMs ?? 0) + delayMs,
        ...(s.type === 'done' ? { idleAfterMs: IDLE_AFTER_MS } : {}),
      }));
  return {
    ...behavior,
    ...(behavior.spawn === undefined ? {} : { spawn: wrap(behavior.spawn) }),
    ...(behavior.send === undefined ? {} : { send: wrap(behavior.send) }),
    ...(behavior.answer === undefined ? {} : { answer: wrap(behavior.answer) }),
  };
}

const realOrcaIdle: RuntimeScenario = {
  ...mainlineScenario,
  roles: Object.fromEntries(
    Object.entries(mainlineScenario.roles).map(([role, behavior]) => [
      role,
      // The engineer reports ready last, after pm/architect already went idle.
      idleAfterDone(behavior, role === 'engineer' ? 200 : 0),
    ]),
  ),
};

describe(
  'M2-T17 D5: idle after done (composed fake)',
  { timeout: 60_000 },
  () => {
    it('starts meeting rounds and completes when finished workers turn idle', async () => {
      const o = await office({ scenario: realOrcaIdle });
      const workflowId = await o.start();
      const final = await o.drive(workflowId, isEnded, { timeoutMs: 10_000 });
      expect(final.status).toBe('completed');
      const events = await o.events(workflowId);
      const rounds = events
        .filter((e: Json) => e.type === 'meeting.round_completed')
        .map((e: Json) => e.payload.round);
      expect(rounds.length).toBeGreaterThan(0);
      // The fake did report idle after done; observation dropped the downgrade.
      const states = events
        .filter((e: Json) => e.type === 'seat.status')
        .map((e: Json) => e.payload.state);
      expect(states).toContain('done');
      expect(states).not.toContain('idle');
    });
  },
);
