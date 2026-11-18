import type { DomainEvent } from '@ai-office/contracts/events';
import type { WorkflowState } from '@ai-office/domain';
import { describe, expect, it, vi } from 'vitest';
import type { ReactContext } from '../context.js';
import { external, internal } from '../effects.js';
import type { Effect } from '../effects.js';
import type { StageModule } from '../stages/types.js';
import { startWorkflow } from '../test-support/fixtures.js';
import { Simulator } from '../test-support/simulator.js';
import { isResume, missed, missedResult, reactStage } from './resume.js';

/** A started workflow: open-session succeeded, a stage-timeout timer pending. */
const started = (): WorkflowState =>
  new Simulator().dispatch(startWorkflow()).state;

const resumed = (
  state: WorkflowState,
  pausedReasons: string[] = [],
  cancelRequested = false,
): ReactContext => {
  const workflow = state.workflow!;
  const event = {
    seq: 99,
    id: '01000000000000000000000099',
    occurredAt: '2026-11-17T00:01:00.000Z',
    recordedAt: '2026-11-17T00:01:00.000Z',
    workflowId: workflow.id,
    stageId: 'meeting',
    seatId: 'seat',
    attemptId: 'attempt',
    source: 'user',
    provenance: 'decided',
    schemaVersion: 1,
    type: 'workflow.resumed',
    payload: { reason: 'hijacked' },
  } as DomainEvent;
  return {
    workflowId: workflow.id,
    event,
    before: {
      ...state,
      workflow: { ...workflow, pausedReasons: ['hijacked'] },
    },
    state: {
      ...state,
      workflow: {
        ...workflow,
        pausedReasons: pausedReasons as typeof workflow.pausedReasons,
        cancelRequested,
      },
    },
  };
};

const sessionId = (state: WorkflowState) =>
  Object.keys(state.commands).find((id) => id.endsWith('/open-session'))!;

describe('re-evaluation on resume', () => {
  it('replays only once every pause reason is gone and no cancel is pending', () => {
    const state = started();
    expect(isResume(resumed(state))).toBe(true);
    expect(isResume(resumed(state, ['budget']))).toBe(false);
    expect(isResume(resumed(state, [], true))).toBe(false);
    const ctx = resumed(state);
    expect(
      isResume({
        ...ctx,
        event: missed(ctx, 'workflow.paused', { reason: 'hijacked' }),
      }),
    ).toBe(false);
  });

  it('rebuilds a missed event in the given scope, timed and caused as the resume', () => {
    const ctx = resumed(started());
    const event = missed(
      ctx,
      'stage.completed',
      { stageId: 'meeting', attempt: 1 },
      { stageId: 'meeting' },
    );
    expect(event).toMatchObject({
      id: ctx.event.id,
      seq: ctx.event.seq,
      occurredAt: ctx.event.occurredAt,
      type: 'stage.completed',
      stageId: 'meeting',
      payload: { stageId: 'meeting', attempt: 1 },
    });
    expect(event).not.toHaveProperty('attemptId');
    expect(event).not.toHaveProperty('seatId');
  });

  it('rebuilds a command result, success or failure', () => {
    const state = started();
    const id = sessionId(state);
    expect(missedResult(resumed(state), id, 'meeting')).toMatchObject({
      type: 'command.succeeded',
      stageId: 'meeting',
      payload: { commandId: id, kind: 'runtime.openSession' },
    });
    const error = {
      category: 'permanent' as const,
      code: 'gone',
      message: 'Gone',
      retryable: false,
    };
    const record = state.commands[id]!;
    const failed: WorkflowState = {
      ...state,
      commands: {
        ...state.commands,
        [id]: {
          id,
          issued: record.issued,
          issuedAt: record.issuedAt,
          status: 'failed',
          error,
        },
      },
    };
    expect(missedResult(resumed(failed), id)).toMatchObject({
      type: 'command.failed',
      payload: {
        commandId: id,
        kind: 'runtime.openSession',
        error,
        attempts: 1,
      },
    });
    expect(missedResult(resumed(state), 'unknown')).toBeUndefined();
  });

  it('replays the stage on its missed events and drops what was already issued', () => {
    const state = started();
    const timer = Object.values(state.timers)[0]!;
    const issued = sessionId(state);
    const base = internal({
      type: 'ResumeWorkflow',
      meta: { occurredAt: '2026-11-17T00:01:00.000Z', source: 'engine' },
      reason: 'budget',
    });
    const fresh = (id: string): Effect =>
      external(id, {
        kind: 'runtime.send',
        args: { agent: 'a', subject: 's', body: 'b' },
      });
    const replayed: Effect[] = [
      base,
      fresh(issued),
      fresh('new-command'),
      {
        kind: 'timer',
        timer: { id: timer.id, fireAt: timer.fireAt, payload: timer.payload },
      },
      {
        kind: 'timer',
        timer: {
          id: 'new-timer',
          fireAt: timer.fireAt,
          payload: timer.payload,
        },
      },
      { kind: 'cancelTimer', id: 'old-timer' },
      {
        kind: 'spawn',
        commandId: issued,
        stageId: 'meeting',
        seatId: 'seat',
        attemptId: 'attempt',
        spec: { purpose: 'facilitator', stageId: 'meeting' },
        agent: 'claude-code',
        workspace: {
          kind: 'existing-worktree',
          workspace: 'w',
          readOnly: true,
        },
        keepOpen: true,
      } as Effect,
    ];
    const stage: StageModule = {
      react: (ctx) =>
        ctx.event.type === 'workflow.resumed' ? [base] : replayed,
      resume: vi.fn((ctx: ReactContext) => [
        missed(ctx, 'stage.completed', { stageId: 'meeting', attempt: 1 }),
        missed(ctx, 'stage.completed', { stageId: 'meeting', attempt: 1 }),
      ]),
    };
    expect(reactStage(stage, resumed(state))).toEqual([
      base,
      fresh('new-command'),
      replayed[4],
      replayed[5],
    ]);
    // No replay while another reason still pauses the workflow.
    expect(reactStage(stage, resumed(state, ['budget']))).toEqual([base]);
    expect(stage.resume).toHaveBeenCalledTimes(1);
    // Stages without a hook react to the resume alone.
    expect(reactStage({ react: stage.react }, resumed(state))).toEqual([base]);
  });
});
