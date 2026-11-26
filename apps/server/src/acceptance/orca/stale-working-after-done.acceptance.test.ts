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
 * M5-T12 rerun #2 regression: on real Orca the pm seat reported worker_done,
 * then its finished turn still read `working`, then `idle` (done → working →
 * idle, no new turn). The `working` downgraded done, and the meeting never
 * reached round 1 once the last member reported done. Only a turn the backend
 * gives (send / answer, §7.1) may return a done attempt to work.
 */
afterEach(closeAll);

const STALE_WORKING_AFTER_MS = 3;
const IDLE_AFTER_MS = 6;

const steps = (script: ScenarioScript | undefined, context: ScenarioContext) =>
  script === undefined
    ? undefined
    : typeof script === 'function'
      ? script(context)
      : script;

/** Every `done` is followed by a stale `working`, then `idle`; `delayMs` staggers a role. */
function flickerAfterDone(behavior: RoleBehavior, delayMs = 0): RoleBehavior {
  const wrap =
    (script: ScenarioScript | undefined) =>
    (context: ScenarioContext): readonly ScenarioStep[] =>
      (steps(script, context) ?? []).map((s) => ({
        ...s,
        afterMs: (s.afterMs ?? 0) + delayMs,
        ...(s.type === 'done'
          ? {
              staleWorkingAfterMs: STALE_WORKING_AFTER_MS,
              idleAfterMs: IDLE_AFTER_MS,
            }
          : {}),
      }));
  return {
    ...behavior,
    ...(behavior.spawn === undefined ? {} : { spawn: wrap(behavior.spawn) }),
    ...(behavior.send === undefined ? {} : { send: wrap(behavior.send) }),
    ...(behavior.answer === undefined ? {} : { answer: wrap(behavior.answer) }),
  };
}

const realOrcaFlicker: RuntimeScenario = {
  ...mainlineScenario,
  roles: Object.fromEntries(
    Object.entries(mainlineScenario.roles).map(([role, behavior]) => [
      role,
      // The engineer reports ready last, after pm/architect already flickered.
      flickerAfterDone(behavior, role === 'engineer' ? 200 : 0),
    ]),
  ),
};

describe(
  'M5-T12: stale working after done (composed fake)',
  { timeout: 60_000 },
  () => {
    it('starts meeting rounds and completes when finished workers flicker working then idle', async () => {
      const o = await office({ scenario: realOrcaFlicker });
      const workflowId = await o.start();
      const final = await o.drive(workflowId, isEnded, { timeoutMs: 10_000 });
      expect(final.status).toBe('completed');
      const events = await o.events(workflowId);
      expect(
        events.filter((e: Json) => e.type === 'meeting.round_started'),
      ).not.toHaveLength(0);
      // No done attempt went back to work without a new turn from the backend.
      const done = new Set<string>();
      const downgrades: string[] = [];
      for (const e of events) {
        const attemptId = (e.payload?.attemptId ?? e.attemptId) as string;
        if (
          e.type === 'command.issued' &&
          ['runtime.send', 'runtime.answer'].includes(e.payload.kind)
        )
          done.delete(e.attemptId as string);
        if (e.type !== 'seat.status') continue;
        if (e.payload.state === 'done') done.add(attemptId);
        else if (done.has(attemptId)) {
          if (e.payload.state === 'working' || e.payload.state === 'idle')
            downgrades.push(`${attemptId} → ${e.payload.state}`);
          done.delete(attemptId);
        }
      }
      expect(downgrades).toEqual([]);
    });
  },
);
