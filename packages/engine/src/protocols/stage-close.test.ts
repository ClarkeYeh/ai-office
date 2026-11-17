import { describe, expect, test } from 'vitest';
import { metaFor } from '../context.js';
import type { ReactContext } from '../context.js';
import { internal } from '../effects.js';
import type { Effect } from '../effects.js';
import { createReact } from '../react.js';
import {
  conclusionGate,
  HASH,
  spawnEffects,
  startWorkflow,
  WORKFLOW_ID,
  withMeeting,
} from '../test-support/fixtures.js';
import { cooperativeWorld, Simulator } from '../test-support/simulator.js';
import type { World } from '../test-support/simulator.js';
import {
  beginStageClose,
  CLOSE_ANOMALY_OPTIONS,
  PRECHECK_RESTOP_MS,
  PRECHECK_WAIT_MS,
  reactStageClose,
} from './stage-close.js';

const ATTEMPTS = ['lead-1', 'pm-1'];

/**
 * A meeting-like probe: spawns two agents; once both are running it completes
 * the stage and, on `stage.completed`, asks for pre-gate clearing. Its stage
 * gate is the conclusion gate, opened through the real OpenGate decide (T9).
 */
const probe = (ctx: ReactContext): Effect[] => {
  const { event } = ctx;
  if (event.type === 'stage.started' && event.payload.stageId === 'meeting')
    return [
      ...spawnEffects(ctx, {
        attemptId: 'lead-1',
        role: 'lead',
        stageId: 'meeting',
        purpose: 'facilitator',
      }),
      ...spawnEffects(ctx, {
        attemptId: 'pm-1',
        role: 'pm',
        stageId: 'meeting',
        purpose: 'participant',
      }),
    ];
  const running = (state: ReactContext['state']) =>
    ATTEMPTS.every((id) => state.attempts[id]?.agentRef !== undefined);
  if (
    event.type === 'command.succeeded' &&
    running(ctx.state) &&
    !running(ctx.before)
  )
    return [
      internal({
        type: 'CompleteStage',
        meta: metaFor(ctx),
        stageId: 'meeting',
        attempt: 1,
      }),
    ];
  if (event.type === 'stage.completed')
    return beginStageClose(ctx, 'meeting', conclusionGate);
  return [];
};

const isClose = (id: string, phase: 'wait' | 'restop') =>
  id.includes(`/close/${phase}/`);

/** Answers like `cooperativeWorld`, except that `ignore` commands are never answered. */
const worldIgnoring =
  (ignore: (commandId: string) => boolean): World =>
  (issued, sim) =>
    ignore(issued.commandId) ? undefined : cooperativeWorld(issued, sim);

const run = (world: World = cooperativeWorld) =>
  new Simulator({
    world,
    react: createReact(
      withMeeting({ react: probe, stageGate: conclusionGate }),
    ),
  }).dispatch(startWorkflow());

const openGates = (sim: Simulator) =>
  sim.internal.filter((c) => c.type === 'OpenGate');
const CONCLUSION = `${WORKFLOW_ID}/gate/conclusion`;
const restopErrors = (sim: Simulator) =>
  sim.eventsOf('error.recorded').map((e) => e.payload.code);

describe('pre-gate clearing (§8.1)', () => {
  test('agents that end in time: the stage gate opens with no live agents', () => {
    const sim = run();
    expect(sim.liveAgents()).toBe(0);
    expect(
      sim.issued
        .filter((c) => isClose(c.commandId, 'wait'))
        .map((c) => c.command.kind),
    ).toEqual([
      'runtime.stop',
      'runtime.release',
      'runtime.stop',
      'runtime.release',
    ]);
    expect(
      sim.eventsOf('timer.cancelled').map((e) => e.payload.reason),
    ).toEqual(['agents_ended']);
    expect(openGates(sim)).toEqual([
      expect.objectContaining({
        noLiveAttempts: true,
        gate: conclusionGate(sim.state, 'meeting'),
      }),
    ]);
    // Nothing ever fires: the precheck timer was cancelled.
    sim.advance(PRECHECK_WAIT_MS + PRECHECK_RESTOP_MS);
    expect(sim.eventsOf('timer.fired')).toEqual([]);
    expect(openGates(sim)).toHaveLength(1);
    expect(sim.issued.some((c) => isClose(c.commandId, 'restop'))).toBe(false);
    expect(restopErrors(sim)).toEqual([]);
    expect(sim.rejections).toEqual([]);
    expect(sim.state.gates[CONCLUSION]?.status).toBe('open');
  });

  test('the opened stage gate is decided through DecideGate and the next stage starts', () => {
    const sim = run();
    sim.dispatch({
      type: 'DecideGate',
      gateId: CONCLUSION,
      decision: 'approve',
      by: 'user',
      expectedVersion: 1,
      // Q1: the hash the user saw equals the one application just read.
      requestedGithubBodyHash: HASH,
      currentGithubBodyHash: HASH,
      approvedSnapshot: {
        source: 'ai-office',
        body: '# Conclusion',
        bodyHash: HASH,
        structured: null,
      },
    });
    expect(sim.rejections).toEqual([]);
    expect(sim.state.gates[CONCLUSION]?.status).toBe('approved');
    expect(sim.state.stages.meeting?.status).toBe('done');
    expect(sim.state.stages.breakdown).toMatchObject({
      status: 'running',
      attempt: 1,
    });
    expect(sim.trace().slice(-3)).toEqual([
      expect.stringContaining(`gate.opened ${CONCLUSION}`),
      expect.stringContaining(`gate.decided ${CONCLUSION}`),
      expect.stringContaining('stage.started breakdown#1'),
    ]);
  });

  test('agents that end after the second stop: the stage gate still opens', () => {
    const sim = run(worldIgnoring((id) => isClose(id, 'wait')));
    expect(sim.liveAgents()).toBe(2);
    expect(openGates(sim)).toEqual([]);
    sim.advance(PRECHECK_WAIT_MS);
    expect(
      sim.issued
        .filter((c) => isClose(c.commandId, 'restop'))
        .map((c) => c.command),
    ).toEqual([
      { kind: 'runtime.stop', args: { agent: 'agent:lead-1' } },
      { kind: 'runtime.stop', args: { agent: 'agent:pm-1' } },
    ]);
    expect(sim.liveAgents()).toBe(0);
    expect(openGates(sim)).toEqual([
      expect.objectContaining({ noLiveAttempts: true }),
    ]);
    expect(
      sim.eventsOf('timer.cancelled').map((e) => e.payload.timerId),
    ).toEqual([expect.stringContaining('/gate-precheck/phase=restop/')]);
    expect(sim.state.workflow?.pausedReasons).toEqual([]);
    expect(restopErrors(sim)).toEqual(['stage_close_restop']);
    expect(sim.eventsOf('error.recorded')[0]?.payload.detail).toBe(
      'lead-1, pm-1',
    );
    expect(sim.state.gates[CONCLUSION]?.status).toBe('open');
    expect(sim.rejections).toEqual([]);
  });

  test('agents still alive after the second stop: anomaly gate and paused, no stage gate', () => {
    const sim = run(worldIgnoring((id) => id.includes('/close/')));
    sim.advance(PRECHECK_WAIT_MS);
    expect(openGates(sim)).toEqual([]);
    sim.advance(PRECHECK_RESTOP_MS);
    expect(sim.liveAgents()).toBe(2);
    const [gate] = openGates(sim);
    expect(gate).toMatchObject({
      noLiveAttempts: false,
      gate: {
        kind: 'exception',
        exceptionKind: 'anomaly',
        stageId: 'meeting',
        options: [
          { optionId: CLOSE_ANOMALY_OPTIONS.restop },
          { optionId: CLOSE_ANOMALY_OPTIONS.abort },
        ],
        content: {
          type: 'exception',
          summary: expect.stringContaining('lead-1, pm-1'),
        },
      },
    });
    expect(openGates(sim)).toHaveLength(1);
    const gateId = gate?.type === 'OpenGate' ? gate.gate.gateId : '';
    expect(sim.eventsOf('workflow.paused').map((e) => e.payload)).toEqual([
      { reason: 'anomaly', gateId, detail: expect.any(String) },
    ]);
    expect(sim.eventsOf('timer.fired').map((e) => e.occurredAt)).toEqual([
      '2026-11-17T00:01:00.000Z',
      '2026-11-17T00:01:30.000Z',
    ]);
    expect(restopErrors(sim)).toEqual(['stage_close_restop']);
    expect(sim.state.gates[gateId]).toMatchObject({
      kind: 'exception',
      status: 'open',
    });
    expect(sim.state.gates[CONCLUSION]).toBeUndefined();
    expect(sim.rejections).toEqual([]);
  });

  test('timer and command ids are stable for the same event sequence', () => {
    const ignoring = worldIgnoring((id) => id.includes('/close/'));
    const a = run(ignoring).advance(PRECHECK_WAIT_MS + PRECHECK_RESTOP_MS);
    const b = run(ignoring).advance(PRECHECK_WAIT_MS + PRECHECK_RESTOP_MS);
    expect(b.events).toEqual(a.events);
    expect(a.eventsOf('timer.scheduled').map((e) => e.payload.timerId)).toEqual(
      [
        `${WORKFLOW_ID}/timer/gate-precheck/phase=wait/stageId=meeting/meeting#1@13`,
        `${WORKFLOW_ID}/timer/gate-precheck/phase=restop/stageId=meeting/meeting#1@19`,
      ],
    );
  });

  test('"再次停止並開啟關卡" resumes and runs the clearing again', () => {
    let stubborn = true;
    const sim = run(worldIgnoring((id) => stubborn && id.includes('/close/')));
    sim.advance(PRECHECK_WAIT_MS + PRECHECK_RESTOP_MS);
    const anomaly = openGates(sim)[0];
    if (anomaly?.type !== 'OpenGate') throw new Error('no anomaly gate');
    stubborn = false;
    sim.dispatch({
      type: 'DecideGate',
      gateId: anomaly.gate.gateId,
      decision: 'option',
      optionId: CLOSE_ANOMALY_OPTIONS.restop,
      by: 'user',
      expectedVersion: 1,
    });
    expect(sim.rejections).toEqual([]);
    expect(sim.state.gates[CONCLUSION]?.status).toBe('open');
    expect(sim.state.workflow?.pausedReasons).toEqual([]);
    expect(sim.liveAgents()).toBe(0);
    expect(openGates(sim).at(-1)).toMatchObject({
      noLiveAttempts: true,
      gate: { kind: 'stage' },
    });
  });

  test('abort is left to the cancel policy (T16): DecideGate requests cancel, clearing does nothing more', () => {
    const sim = run(worldIgnoring((id) => id.includes('/close/')));
    sim.advance(PRECHECK_WAIT_MS + PRECHECK_RESTOP_MS);
    const anomaly = openGates(sim)[0];
    if (anomaly?.type !== 'OpenGate') throw new Error('no anomaly gate');
    const issued = sim.issued.length;
    sim.dispatch({
      type: 'DecideGate',
      gateId: anomaly.gate.gateId,
      decision: 'option',
      optionId: CLOSE_ANOMALY_OPTIONS.abort,
      by: 'user',
      expectedVersion: 1,
    });
    expect(sim.rejections).toEqual([]);
    expect(sim.state.workflow?.cancelRequested).toBe(true);
    expect(sim.issued).toHaveLength(issued);
    expect(sim.state.workflow?.pausedReasons).toEqual(['anomaly']);
  });

  test('a precheck for an unknown stage stops agents but opens no stage gate', () => {
    const ghost = {
      purpose: 'gate-precheck' as const,
      stageId: 'ghost',
      phase: 'wait' as const,
    };
    const idle = run();
    idle
      .inject('timer.scheduled', {
        timerId: 'ghost-1',
        fireAt: idle.clock,
        payload: ghost,
      })
      .advance(0);
    expect(openGates(idle)).toHaveLength(1);
    const busy = run(worldIgnoring((id) => id.includes('/close/')));
    busy
      .inject('timer.scheduled', {
        timerId: 'ghost-1',
        fireAt: busy.clock,
        payload: ghost,
      })
      .advance(0);
    expect(busy.eventsOf('timer.scheduled').at(-1)?.payload.timerId).toContain(
      '/ghost#0@',
    );
  });

  test('with no live agents the gate opens at once; unknown builders open nothing', () => {
    const sim = new Simulator().dispatch(startWorkflow());
    const ctx: ReactContext = {
      workflowId: WORKFLOW_ID,
      event: sim.events.at(-1) as ReactContext['event'],
      before: sim.state,
      state: sim.state,
    };
    expect(beginStageClose(ctx, 'meeting', conclusionGate)).toEqual([
      expect.objectContaining({
        kind: 'internal',
        command: expect.objectContaining({
          type: 'OpenGate',
          noLiveAttempts: true,
        }),
      }),
    ]);
    expect(beginStageClose(ctx, 'meeting', () => undefined)).toEqual([]);
    // A precheck firing when everything already ended opens the gate directly.
    const timer = {
      id: 't',
      fireAt: ctx.event.occurredAt,
      payload: {
        purpose: 'gate-precheck' as const,
        stageId: 'meeting',
        phase: 'restop' as const,
      },
    };
    expect(reactStageClose({ ...ctx, timer }, conclusionGate)).toHaveLength(1);
    // A gate.decided for a gate that is not a close anomaly does nothing.
    expect(
      reactStageClose(
        {
          ...ctx,
          event: {
            ...ctx.event,
            type: 'gate.decided',
            payload: {
              gateId: 'g',
              decision: 'approve',
              by: 'user',
              version: 1,
            },
          } as ReactContext['event'],
        },
        conclusionGate,
      ),
    ).toEqual([]);
  });
});
