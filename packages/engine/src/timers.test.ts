import { initialState } from '@ai-office/domain';
import { describe, expect, test } from 'vitest';
import type { ReactContext } from './context.js';
import {
  cancelTimer,
  fireAt,
  firedTimer,
  pendingTimers,
  schedule,
  timerId,
} from './timers.js';

const ctx = (occurredAt: string): ReactContext => {
  const state = initialState();
  return {
    workflowId: 'wf-1',
    before: state,
    state,
    event: { occurredAt, seq: 7 } as ReactContext['event'],
  };
};

describe('timers', () => {
  test('ids are derived from the payload with sorted keys and discriminators', () => {
    expect(
      timerId('wf-1', {
        purpose: 'nudge-grace',
        reason: 'missing-submission',
        attemptId: 'a-1',
      }),
    ).toBe('wf-1/timer/nudge-grace/attemptId=a-1/reason=missing-submission');
    expect(
      timerId(
        'wf-1',
        { purpose: 'gate-precheck', stageId: 's', phase: 'wait' },
        's#1@3',
      ),
    ).toBe('wf-1/timer/gate-precheck/phase=wait/stageId=s/s#1@3');
    // Same input, same id; key order in the payload does not matter.
    expect(
      timerId('wf-1', { purpose: 'stage-timeout', attempt: 1, stageId: 's' }),
    ).toBe(
      timerId('wf-1', { purpose: 'stage-timeout', stageId: 's', attempt: 1 }),
    );
  });

  test('fireAt counts from the triggering event, not a clock', () => {
    expect(fireAt('2026-11-17T00:00:00.000Z', 90_000)).toBe(
      '2026-11-17T00:01:30.000Z',
    );
    expect(
      schedule(
        ctx('2026-11-17T01:00:00+08:00'),
        { purpose: 'question-timeout', questionId: 'q' },
        1000,
      ),
    ).toEqual({
      kind: 'timer',
      timer: {
        id: 'wf-1/timer/question-timeout/questionId=q',
        fireAt: '2026-11-16T17:00:01.000Z',
        payload: { purpose: 'question-timeout', questionId: 'q' },
      },
    });
  });

  test('cancel, pending and fired helpers', () => {
    expect(cancelTimer('t')).toEqual({ kind: 'cancelTimer', id: 't' });
    expect(cancelTimer('t', 'why')).toEqual({
      kind: 'cancelTimer',
      id: 't',
      reason: 'why',
    });
    const c = ctx('2026-11-17T00:00:00.000Z');
    const timers = {
      a: {
        id: 'a',
        fireAt: 'x',
        payload: { purpose: 'question-timeout' as const, questionId: 'r' },
      },
      d: {
        id: 'd',
        fireAt: 'x',
        payload: { purpose: 'question-timeout' as const, questionId: 's' },
      },
      b: {
        id: 'b',
        fireAt: 'x',
        payload: { purpose: 'question-timeout' as const, questionId: 'q' },
      },
      c: {
        id: 'c',
        fireAt: 'x',
        payload: {
          purpose: 'stage-timeout' as const,
          stageId: 's',
          attempt: 1,
        },
      },
    };
    const state = { ...c.state, timers };
    expect(pendingTimers(state, 'question-timeout').map((t) => t.id)).toEqual([
      'a',
      'b',
      'd',
    ]);
    expect(firedTimer(c, 'stage-timeout')).toBeUndefined();
    expect(firedTimer({ ...c, timer: timers.c }, 'stage-timeout')).toBe(
      timers.c,
    );
    expect(
      firedTimer({ ...c, timer: timers.a }, 'stage-timeout'),
    ).toBeUndefined();
  });
});
