import { describe, expect } from 'vitest';
import type { DomainCommand } from '../commands.js';
import {
  eventDraft,
  meta,
  spawn,
  startCommand,
  startStage,
} from '../test-support/fixtures.js';
import type { Step } from '../test-support/fixtures.js';
import { runTransitionRows } from '../test-support/transitions.js';
import type { TransitionRow } from '../test-support/transitions.js';

const nudge = (
  reason: 'missing-submission' | 'stage-timeout' = 'missing-submission',
): DomainCommand => ({
  type: 'RecordNudge',
  meta: meta(9),
  attemptId: 'att-1',
  reason,
  subject: 'conclusion missing',
  body: 'Please submit the conclusion.',
});
const error = (
  extra: Partial<Extract<DomainCommand, { type: 'RecordError' }>> = {},
): DomainCommand => ({
  type: 'RecordError',
  meta: meta(9),
  category: 'transient',
  code: 'stage_close_restop',
  message: 'Agents still alive after 60 s; stopping again',
  ...extra,
});

const withAttempt: Step[] = [
  startCommand(),
  startStage('meeting'),
  spawn('att-1', 'pm'),
];

const ROWS: TransitionRow[] = [
  {
    name: 'record nudge',
    given: withAttempt,
    when: nudge(),
    then: ['message.nudge'],
    check: (h) => {
      expect(h.state.attempts['att-1']?.nudges).toEqual([
        { reason: 'missing-submission', subject: 'conclusion missing' },
      ]);
      expect(h.events.at(-1)).toMatchObject({
        attemptId: 'att-1',
        stageId: 'meeting',
      });
    },
  },
  {
    name: 'record nudge again (same reason)',
    given: [...withAttempt, nudge()],
    when: nudge(),
    then: [],
  },
  {
    name: 'record nudge for another reason',
    given: [...withAttempt, nudge()],
    when: nudge('stage-timeout'),
    then: ['message.nudge'],
  },
  {
    name: 'record nudge for unknown attempt',
    given: [startCommand()],
    when: nudge(),
    then: { error: 'unknown_attempt' },
  },
  {
    name: 'record nudge for exited attempt',
    given: [
      ...withAttempt,
      {
        type: 'RecordAttemptExited',
        meta: meta(5, 'runtime'),
        attemptId: 'att-1',
        reason: 'x',
        expected: false,
      },
    ],
    when: nudge(),
    then: { error: 'attempt_not_alive' },
  },
  {
    name: 'record nudge before start',
    given: [],
    when: nudge(),
    then: { error: 'workflow_not_started' },
  },
  {
    name: 'record error',
    given: [startCommand()],
    when: error({ stageId: 'meeting', commandId: 'cmd-1', detail: 'att-1' }),
    then: ['error.recorded'],
    check: (h) =>
      expect(h.events.at(-1)).toMatchObject({
        stageId: 'meeting',
        payload: {
          category: 'transient',
          code: 'stage_close_restop',
          commandId: 'cmd-1',
          detail: 'att-1',
        },
      }),
  },
  {
    name: 'record error after the workflow ended',
    given: [startCommand(), eventDraft('workflow.cancelled', {})],
    when: error(),
    then: ['error.recorded'],
  },
  {
    name: 'record error for unknown stage',
    given: [startCommand()],
    when: error({ stageId: 'nope' }),
    then: { error: 'unknown_stage' },
  },
  {
    name: 'record error before start',
    given: [],
    when: error(),
    then: { error: 'workflow_not_started' },
  },
];

describe('lifecycle records (M1-T12)', () => {
  runTransitionRows(ROWS);
});
