import { describe, expect, test } from 'vitest';
import type { ReactContext } from '../context.js';
import type { Effect } from '../effects.js';
import { createReact } from '../react.js';
import {
  spawnEffects,
  startWorkflow,
  WORKFLOW_ID,
  withMeeting,
} from '../test-support/fixtures.js';
import { Simulator } from '../test-support/simulator.js';
import type { World } from '../test-support/simulator.js';
import { firedTimer } from '../timers.js';
import {
  cancelNudge,
  escalateNudge,
  hasNudged,
  NUDGE_GRACE_MS,
  nudgeGateId,
  sendNudge,
  STAGE_VIOLATION_OPTIONS,
} from './nudge.js';

const NUDGE = {
  attemptId: 'lead-1',
  reason: 'missing-submission' as const,
  subject: 'conclusion missing',
  body: 'Please submit the conclusion.',
};

/**
 * A planning-like probe: spawns one agent; on `seat.status done` without a
 * submission it nudges (every time it sees `done`); when the grace expires it
 * escalates; `seat.degraded` stands in for the submission arriving.
 */
const probe = (ctx: ReactContext): Effect[] => {
  const { event } = ctx;
  if (event.type === 'stage.started')
    return spawnEffects(ctx, {
      attemptId: 'lead-1',
      role: 'lead',
      stageId: 'meeting',
      purpose: 'planner',
    });
  if (event.type === 'seat.status' && event.payload.state === 'done')
    return sendNudge(ctx, NUDGE);
  if (event.type === 'seat.degraded')
    return cancelNudge(ctx, 'lead-1', 'missing-submission');
  const fired = firedTimer(ctx, 'nudge-grace');
  if (fired !== undefined)
    return escalateNudge(ctx, fired.payload.attemptId, fired.payload.reason, {
      exceptionKind: 'stage-violation',
      title: '階段違約',
      options: STAGE_VIOLATION_OPTIONS,
      summary: 'conclusion missing after nudge',
    });
  return [];
};

const setup = (world?: World) =>
  new Simulator({
    react: createReact(withMeeting({ react: probe })),
    ...(world ? { world } : {}),
  }).dispatch(startWorkflow());

const status = (state: 'working' | 'done') => ({
  type: 'ObserveAttemptStatus' as const,
  attemptId: 'lead-1',
  state,
});

describe('nudge protocol', () => {
  test('sends exactly one nudge, then escalates after the 5-minute grace', () => {
    const sim = setup();
    sim.dispatch(status('done'), 'runtime');
    sim
      .dispatch(status('working'), 'runtime')
      .dispatch(status('done'), 'runtime');
    const sends = sim.issued.filter((c) => c.command.kind === 'runtime.send');
    expect(sends).toEqual([
      {
        commandId: `${WORKFLOW_ID}/nudge/lead-1/missing-submission`,
        command: {
          kind: 'runtime.send',
          args: {
            agent: 'agent:lead-1',
            subject: NUDGE.subject,
            body: NUDGE.body,
          },
        },
        stageId: 'meeting',
        attemptId: 'lead-1',
      },
    ]);
    expect(
      hasNudged(sim.state, WORKFLOW_ID, 'lead-1', 'missing-submission'),
    ).toBe(true);
    expect(hasNudged(sim.state, WORKFLOW_ID, 'lead-1', 'stage-timeout')).toBe(
      false,
    );
    expect(hasNudged(sim.state, WORKFLOW_ID, 'nobody', 'stage-timeout')).toBe(
      false,
    );

    sim.advance(NUDGE_GRACE_MS - 1);
    expect(sim.internal.some((c) => c.type === 'OpenGate')).toBe(false);
    sim.advance(1);
    expect(sim.issued.at(-1)?.command).toEqual({
      kind: 'runtime.stop',
      args: { agent: 'agent:lead-1' },
    });
    const gate = sim.internal.find((c) => c.type === 'OpenGate');
    expect(gate).toMatchObject({
      noLiveAttempts: false,
      gate: {
        kind: 'exception',
        gateId: nudgeGateId(WORKFLOW_ID, 'lead-1', 'missing-submission'),
        stageId: 'meeting',
        exceptionKind: 'stage-violation',
        options: STAGE_VIOLATION_OPTIONS,
        content: {
          type: 'exception',
          summary: 'conclusion missing after nudge',
          attemptId: 'lead-1',
        },
      },
    });
    // The single grace timer fired at exactly +5 min.
    expect(sim.eventsOf('timer.fired').map((e) => e.occurredAt)).toEqual([
      '2026-11-17T00:05:00.000Z',
    ]);
  });

  test('a submission inside the grace cancels the escalation', () => {
    const sim = setup();
    sim.dispatch(status('done'), 'runtime');
    sim.dispatch(
      {
        type: 'MarkAttemptDegraded',
        attemptId: 'lead-1',
        reason: 'source_changed',
      },
      'runtime',
    );
    expect(
      sim.eventsOf('timer.cancelled').map((e) => e.payload.reason),
    ).toEqual(['satisfied']);
    sim.advance(NUDGE_GRACE_MS * 2);
    expect(sim.internal.some((c) => c.type === 'OpenGate')).toBe(false);
    // Cancelling with nothing pending is a no-op; a later trigger never re-nudges.
    const last: ReactContext = {
      workflowId: WORKFLOW_ID,
      event: sim.events.at(-1) as ReactContext['event'],
      before: sim.state,
      state: sim.state,
    };
    expect(cancelNudge(last, 'lead-1', 'missing-submission')).toEqual([]);
    sim
      .dispatch(status('working'), 'runtime')
      .dispatch(status('done'), 'runtime');
    expect(
      sim.issued.filter((c) => c.command.kind === 'runtime.send'),
    ).toHaveLength(1);
  });

  test('cannot nudge an attempt that is gone, unreachable, or exited', () => {
    const sim = setup((issued) =>
      issued.command.kind === 'runtime.spawnAgent'
        ? undefined
        : { ok: true, result: { session: 's' } },
    );
    const ctx: ReactContext = {
      workflowId: WORKFLOW_ID,
      event: sim.events.at(-1) as ReactContext['event'],
      before: sim.state,
      state: sim.state,
    };
    // Spawn never answered → no agent ref.
    expect(sendNudge(ctx, NUDGE)).toEqual([]);
    expect(sendNudge(ctx, { ...NUDGE, attemptId: 'nobody' })).toEqual([]);
    expect(
      escalateNudge(ctx, 'nobody', 'missing-submission', {
        exceptionKind: 'stage-violation',
        title: 't',
        options: [],
        summary: 's',
      }),
    ).toEqual([]);
    const exited = {
      ...ctx,
      state: {
        ...sim.state,
        attempts: {
          'lead-1': {
            ...sim.state.attempts['lead-1']!,
            agentRef: 'x',
            state: 'exited' as const,
          },
        },
      },
    };
    expect(sendNudge(exited, NUDGE)).toEqual([]);
    // Recorded `message.nudge` also counts; item gates carry the item key.
    const nudged = {
      ...exited.state,
      attempts: {
        'lead-1': {
          ...exited.state.attempts['lead-1']!,
          state: 'working' as const,
          nudges: [{ reason: 'missing-submission' as const, subject: 's' }],
        },
      },
    };
    expect(hasNudged(nudged, WORKFLOW_ID, 'lead-1', 'missing-submission')).toBe(
      true,
    );
    expect(sendNudge({ ...exited, state: nudged }, NUDGE)).toEqual([]);
    const [stop, open] = escalateNudge(
      { ...exited, state: nudged },
      'lead-1',
      'item-timeout',
      {
        exceptionKind: 'workitem-failed',
        title: 't',
        options: [],
        summary: 's',
        itemKey: 'item-1',
      },
    );
    expect(stop).toMatchObject({
      kind: 'external',
      command: { kind: 'runtime.stop' },
    });
    expect(open).toMatchObject({
      kind: 'internal',
      command: { gate: { content: { itemKey: 'item-1' } } },
    });
  });
});
