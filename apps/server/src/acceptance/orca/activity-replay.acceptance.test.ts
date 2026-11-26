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
 * M5-T12 FX-ACTIVITY-DUP regression: on real Orca a keep-open seat gets a new
 * dispatch per turn on the same transcript, and each read reported every
 * earlier message again (same messageId and time, new externalKey). The T12
 * merge agent's activity came back up to 4 times, recorded ~20 min late,
 * which inflated nf.latency. Each transcript message must be one fact.
 */
afterEach(closeAll);

const steps = (script: ScenarioScript | undefined, context: ScenarioContext) =>
  script === undefined
    ? undefined
    : typeof script === 'function'
      ? script(context)
      : script;

/** Every turn first re-reads the transcript, then says something new. */
function replaying(behavior: RoleBehavior): RoleBehavior {
  const wrap =
    (script: ScenarioScript | undefined) =>
    (context: ScenarioContext): readonly ScenarioStep[] => [
      { type: 'replay-transcript' },
      {
        type: 'output',
        blocks: [{ type: 'text', text: `turn ${context.turn}` }],
      },
      ...(steps(script, context) ?? []),
    ];
  return {
    ...behavior,
    ...(behavior.spawn === undefined ? {} : { spawn: wrap(behavior.spawn) }),
    ...(behavior.send === undefined ? {} : { send: wrap(behavior.send) }),
    ...(behavior.answer === undefined ? {} : { answer: wrap(behavior.answer) }),
  };
}

const rereading: RuntimeScenario = {
  ...mainlineScenario,
  roles: Object.fromEntries(
    Object.entries(mainlineScenario.roles).map(([role, behavior]) => [
      role,
      replaying(behavior),
    ]),
  ),
};

describe(
  'M5-T12 FX-ACTIVITY-DUP: transcript re-reads (composed fake)',
  { timeout: 60_000 },
  () => {
    it('records each transcript message once as activity and once as a turn', async () => {
      const o = await office({ scenario: rereading });
      const workflowId = await o.start();
      const final = await o.drive(workflowId, isEnded, { timeoutMs: 10_000 });
      expect(final.status).toBe('completed');
      const events = await o.events(workflowId);
      const facts = (type: string) =>
        events
          .filter((e: Json) => e.type === type)
          .flatMap((e: Json) =>
            type === 'seat.activity'
              ? (e.payload.activity as Json[]).map(
                  (a) => `${e.payload.attemptId}:${a.messageId}`,
                )
              : [`${e.payload.attemptId}:${e.externalKey}`],
          );
      const activity = facts('seat.activity');
      // Later turns re-read earlier ones, so a duplicate would show here.
      expect(
        events.filter(
          (e: Json) =>
            e.type === 'command.issued' && e.payload.kind === 'runtime.send',
        ).length,
      ).toBeGreaterThan(0);
      expect(activity.length).toBeGreaterThan(0);
      expect(activity.length - new Set(activity).size).toBe(0);
      const turns = events.filter((e: Json) => e.type === 'usage.turns');
      expect(turns.length).toBe(new Set(activity).size);
    });
  },
);
