import type { DomainEvent } from '@ai-office/contracts/events';
import { initialState } from '@ai-office/domain';
import { describe, expect, test } from 'vitest';
import { sessionRef } from './context.js';
import { startableStage } from './lifecycle.js';
import { createReact, DEFAULT_MODULES, react } from './react.js';
import {
  startWorkflow,
  WORKFLOW_ID,
  withMeeting,
} from './test-support/fixtures.js';
import { Simulator } from './test-support/simulator.js';

const started = () =>
  new Simulator({
    react: createReact(withMeeting({ react: () => [] })),
  }).dispatch(startWorkflow());

describe('simulator: start → stage started', () => {
  test('opens the session, ensures the integration branch, starts the first stage', () => {
    const sim = started();
    expect(sim.trace()).toEqual([
      '2026-11-17T00:00:00.000Z workflow.started',
      `2026-11-17T00:00:00.000Z command.issued runtime.openSession ${WORKFLOW_ID}/open-session`,
      `2026-11-17T00:00:00.000Z command.issued scm.ensureBranch ${WORKFLOW_ID}/ensure-branch`,
      `2026-11-17T00:00:00.000Z command.succeeded runtime.openSession ${WORKFLOW_ID}/open-session`,
      `2026-11-17T00:00:00.000Z command.succeeded scm.ensureBranch ${WORKFLOW_ID}/ensure-branch`,
      '2026-11-17T00:00:00.000Z stage.started meeting#1',
    ]);
    expect(sim.state.stages.meeting?.status).toBe('running');
    expect(sessionRef(sim.state)).toBe('session-1');
    expect(sim.rejections).toEqual([]);
    expect(sim.warnings).toEqual([]);
    const branch = sim.issued[1]?.command;
    expect(branch).toEqual({
      kind: 'scm.ensureBranch',
      args: {
        repo: { owner: 'octo', name: 'demo' },
        name: sim.state.workflow?.integrationBranch,
        from: 'main',
      },
    });
  });

  test('is deterministic: the same inputs produce the same events', () => {
    expect(started().events).toEqual(started().events);
  });
});

describe('react dispatcher', () => {
  test('state is the pre-event state; skipped events yield no effects', () => {
    const sim = started();
    const first = sim.events[0] as DomainEvent;
    // Redelivered (seq already applied) → evolve skips → nothing.
    expect(react(sim.state, first)).toEqual([]);
    // No workflow yet and the event is not a start → skipped.
    expect(react(initialState(), sim.events[1] as DomainEvent)).toEqual([]);
  });

  test('every stage module and policy sees every event, in a fixed order', () => {
    const seen: string[] = [];
    const probe = (name: string) => () => {
      seen.push(name);
      return [];
    };
    const sim = new Simulator({
      react: createReact({
        stages: {
          meeting: { react: probe('meeting') },
          planning: { react: probe('planning') },
          implement: { react: probe('implement') },
          oncall: { react: probe('oncall') },
          integrate: { react: probe('integrate') },
          'final-pr': { react: probe('final-pr') },
        },
        policies: [probe('policy')],
      }),
    });
    sim.dispatch(startWorkflow());
    expect(seen.slice(0, 7)).toEqual([
      'meeting',
      'planning',
      'implement',
      'oncall',
      'integrate',
      'final-pr',
      'policy',
    ]);
    expect(seen).toHaveLength(7 * sim.events.length);
  });

  test('default module factory matches the exported react function', () => {
    const sim = new Simulator().dispatch(startWorkflow());
    const stub = new Simulator({ react: createReact(DEFAULT_MODULES) });
    stub.dispatch(startWorkflow());
    expect(stub.events).toEqual(sim.events);
  });

  test('the fired timer is handed to modules even though evolve drops it', () => {
    const fired: (string | undefined)[] = [];
    const sim = new Simulator({
      react: createReact(
        withMeeting({
          react: (ctx) => {
            if (ctx.event.type === 'timer.fired') fired.push(ctx.timer?.id);
            if (ctx.event.type !== 'stage.started') return [];
            return [
              {
                kind: 'timer',
                timer: {
                  id: 't-1',
                  fireAt: '2026-11-17T00:01:00.000Z',
                  payload: {
                    purpose: 'stage-timeout',
                    stageId: 'meeting',
                    attempt: 1,
                  },
                },
              },
            ];
          },
        }),
      ),
    });
    sim.dispatch(startWorkflow()).advance(60_000);
    expect(fired).toEqual(['t-1']);
    expect(sim.state.timers).toEqual({});
  });
});

describe('lifecycle', () => {
  test('starts the next stage on the edge where it becomes startable', () => {
    const sim = started();
    sim.dispatch(
      { type: 'CompleteStage', stageId: 'meeting', attempt: 1 },
      'engine',
    );
    expect(sim.state.stages.meeting?.status).toBe('awaiting_gate');
    expect(startableStage(sim.state)).toBeUndefined();
    sim.inject('gate.opened', {
      kind: 'stage',
      gateId: 'g-1',
      stageId: 'meeting',
      templateGateId: 'conclusion',
      stageKind: 'meeting',
      optional: true,
      title: '結論定案',
      options: [],
      content: { type: 'work-items', artifactId: 'a-1' },
      version: 1,
    });
    sim.inject('gate.decided', {
      gateId: 'g-1',
      decision: 'approve',
      by: 'user',
      version: 1,
    });
    expect(sim.state.stages.breakdown?.status).toBe('running');
    // Rerun of a completed stage → started again in rerun mode.
    sim.dispatch(
      { type: 'CompleteStage', stageId: 'breakdown', attempt: 1 },
      'engine',
    );
    sim.dispatch(
      {
        type: 'RequestStageRerun',
        stageId: 'breakdown',
        mode: 'rerun',
        by: 'user',
        feedback: 'again',
      },
      'user',
    );
    expect(sim.state.stages.breakdown).toMatchObject({
      status: 'running',
      attempt: 2,
      mode: 'rerun',
    });
    expect(sim.rejections).toEqual([]);
  });

  test('nothing starts while paused; resuming starts the waiting stage', () => {
    const sim = started();
    sim.dispatch(
      { type: 'PauseWorkflow', reason: 'runtime_unhealthy' },
      'system',
    );
    sim.dispatch(
      { type: 'CompleteStage', stageId: 'meeting', attempt: 1 },
      'engine',
    );
    sim.dispatch(
      {
        type: 'RequestStageRerun',
        stageId: 'meeting',
        mode: 'rerun',
        by: 'auto',
      },
      'engine',
    );
    expect(sim.state.stages.meeting?.status).toBe('awaiting_gate');
    sim.dispatch(
      { type: 'ResumeWorkflow', reason: 'runtime_unhealthy' },
      'system',
    );
    expect(sim.state.stages.meeting).toMatchObject({
      status: 'running',
      attempt: 2,
    });
  });

  test('startableStage: none while cancelling, after the last stage, or before start', () => {
    expect(startableStage(initialState())).toBeUndefined();
    const sim = started();
    sim.dispatch({ type: 'RequestCancel', by: 'user' }, 'user');
    expect(startableStage(sim.state)).toBeUndefined();
    const done = started();
    const state = {
      ...done.state,
      stages: Object.fromEntries(
        Object.entries(done.state.stages).map(([id, stage]) => [
          id,
          { ...stage, status: 'done' as const },
        ]),
      ),
    };
    expect(startableStage(state)).toBeUndefined();
  });

  test('a successful runtime.release is recorded as seat.released', () => {
    const sim = new Simulator({
      react: createReact(
        withMeeting({
          react: (ctx) => {
            if (ctx.event.type === 'stage.started')
              return [
                {
                  kind: 'internal',
                  command: {
                    type: 'SpawnAttempt',
                    meta: {
                      occurredAt: ctx.event.occurredAt,
                      source: 'engine',
                    },
                    stageId: 'meeting',
                    role: 'lead',
                    attemptId: 'att-1',
                    purpose: 'facilitator',
                    keepOpen: true,
                    spawnCommandId: 'spawn-1',
                  },
                },
              ];
            if (ctx.event.type === 'seat.spawned')
              return [
                {
                  kind: 'external',
                  commandId: 'rel-1',
                  command: {
                    kind: 'runtime.release',
                    args: { agent: 'a', removeWorkspace: true },
                  },
                  attemptId: 'att-1',
                },
                // Unscoped release: nothing to record.
                {
                  kind: 'external',
                  commandId: 'rel-2',
                  command: {
                    kind: 'runtime.release',
                    args: { agent: 'b', removeWorkspace: false },
                  },
                },
              ];
            return [];
          },
        }),
      ),
    });
    sim.dispatch(startWorkflow());
    expect(sim.state.attempts['att-1']).toMatchObject({
      released: true,
      removeWorkspace: true,
    });
    expect(sim.eventsOf('seat.released')).toHaveLength(1);
    expect(sim.eventsOf('seat.released')[0]?.source).toBe('runtime');
  });
});
