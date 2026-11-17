import { describe, expect, test } from 'vitest';
import type { AcceptSubmission } from '../commands.js';
import type { AgentSubmission } from '../state/index.js';
import {
  Harness,
  completeStage,
  eventDraft,
  meta,
  spawn,
  startCommand,
  startStage,
  throughStage,
} from '../test-support/fixtures.js';

const agenda: AgentSubmission = {
  kind: 'agenda',
  payload: { topics: [{ id: 't', title: 'Topic', focusByRole: {} }] },
};
const submit = (
  submission: AgentSubmission = agenda,
  submissionId = 's',
): AcceptSubmission => ({
  type: 'AcceptSubmission',
  meta: meta(),
  attemptId: 'a',
  submissionId,
  submission,
  artifactId: 'art',
});
const meeting = (purpose: 'facilitator' | 'participant' = 'facilitator') =>
  new Harness().given(
    startCommand(),
    startStage('meeting'),
    spawn('a', purpose === 'facilitator' ? 'lead' : 'pm', 'meeting', {
      purpose,
    }),
  );
const error = (h: Harness, c: Parameters<Harness['run']>[0], code: string) =>
  expect(h.run(c)).toMatchObject({ ok: false, error: { code } });
const submissions: AgentSubmission[] = [
  agenda,
  {
    kind: 'statement',
    payload: {
      round: 1,
      position: 'yes',
      arguments: [],
      concerns: [],
      readyToConclude: false,
    },
  },
  {
    kind: 'conclusion',
    payload: {
      summary: 's',
      decisions: [],
      techDecisions: [],
      openQuestions: [],
    },
  },
  { kind: 'work-items', payload: { items: [] } },
  { kind: 'answer-question', payload: { questionId: 'q', body: 'answer' } },
  { kind: 'merge-request', payload: { pr: 1, expectedHeadSha: 'abcdef1' } },
  {
    kind: 'decision-request',
    payload: { reason: 'other', question: 'choose', options: ['a'] },
  },
  {
    kind: 'integration-report',
    payload: { summary: 'ok', merged: [], verification: [], risks: [] },
  },
];
describe('submission authorization and replacement', () => {
  test.each([
    [
      'facilitator',
      'meeting',
      'lead',
      ['agenda', 'conclusion', 'answer-question', 'decision-request'],
    ],
    ['participant', 'meeting', 'pm', ['statement']],
    ['planner', 'breakdown', 'lead', ['work-items']],
    ['oncall', 'implement', 'lead', ['answer-question', 'decision-request']],
    [
      'integrator',
      'integrate',
      'integrator',
      ['merge-request', 'decision-request', 'integration-report'],
    ],
  ] as const)(
    '%s has exactly its allowed submission kinds',
    (purpose, stageId, role, allowed) => {
      for (const submission of submissions) {
        const h =
          stageId === 'meeting'
            ? new Harness().given(startCommand())
            : throughStage(
                new Harness(),
                stageId === 'breakdown'
                  ? 'meeting'
                  : stageId === 'implement'
                    ? 'breakdown'
                    : 'implement',
              );
        h.given(startStage(stageId), spawn('a', role, stageId, { purpose }));
        if (stageId === 'integrate')
          h.given(
            eventDraft('workitem.approved', {
              gateId: 'task-split',
              items: [
                {
                  key: 'remaining',
                  title: 'Remaining',
                  body: 'Work',
                  acceptance: [],
                  role: 'engineer',
                  agent: 'codex',
                  deps: [],
                },
              ],
            }),
            eventDraft('workitem.status', {
              itemKey: 'remaining',
              status: 'pr_open',
              pr: 1,
            }),
          );
        const result = h.run(submit(submission));
        expect(result.ok).toBe(
          (allowed as readonly string[]).includes(submission.kind),
        );
        if (result.ok)
          expect(h.state.attempts.a?.submissions[submission.kind]).toBe('s');
        else expect(result.error.code).toBe('not_allowed');
      }
    },
  );
  test('latest same-kind submission wins, retaining immutable history', () => {
    const h = meeting().given(
      submit(),
      submit(
        {
          ...agenda,
          payload: { topics: [{ id: 'new', title: 'New', focusByRole: {} }] },
        },
        's2',
      ),
    );
    expect(h.state.attempts.a?.submissions.agenda).toBe('s2');
    expect(h.state.submissions.s?.submission).toEqual(agenda);
    error(h, submit(), 'duplicate_submission');
  });
  test('statements replace independently per round in the accepted history', () => {
    const statement = (round: number, position: string): AgentSubmission => ({
      kind: 'statement',
      payload: {
        round,
        position,
        arguments: [],
        concerns: [],
        readyToConclude: true,
      },
    });
    const h = meeting('participant').given(
      submit(statement(1, 'first'), 's1'),
      submit(statement(2, 'second'), 's2'),
      submit(statement(1, 'corrected'), 's3'),
    );
    const byRound = new Map(
      Object.values(h.state.submissions).flatMap((s) =>
        s.submission.kind === 'statement'
          ? [
              [
                s.submission.payload.round,
                s.submission.payload.position,
              ] as const,
            ]
          : [],
      ),
    );
    expect([...byRound]).toEqual([
      [1, 'corrected'],
      [2, 'second'],
    ]);
  });
  test('stale, terminal and cancelling attempts are refused', () => {
    error(new Harness(), submit(), 'workflow_not_started');
    error(new Harness().given(startCommand()), submit(), 'unknown_attempt');
    for (const state of ['exited', 'lost', 'error'] as const) {
      const h = meeting();
      h.state.attempts.a!.state = state;
      error(h, submit(), 'not_allowed');
    }
    error(
      meeting().given({
        type: 'ReleaseAttempt',
        meta: meta(),
        attemptId: 'a',
        removeWorkspace: false,
      }),
      submit(),
      'not_allowed',
    );
    error(
      meeting().given({ type: 'RequestCancel', meta: meta(), by: 'user' }),
      submit(),
      'not_allowed',
    );
    error(meeting().given(completeStage('meeting')), submit(), 'not_allowed');
    const stale = meeting();
    stale.state.attempts.a!.stageAttempt = 2;
    error(stale, submit(), 'not_allowed');
  });
  test('stage gates and requester exception gates reject further submissions', () => {
    const h = meeting().given(
      eventDraft('gate.opened', {
        gateId: 'g',
        stageId: 'meeting',
        kind: 'stage',
        stageKind: 'meeting',
        templateGateId: 'conclusion',
        title: 'Gate',
        optional: true,
        options: [],
        content: {
          type: 'conclusion',
          artifactId: 'art',
          renderedHash: 'a'.repeat(64),
        },
        version: 1,
      }),
    );
    error(h, submit(), 'gate_open');
    const e = meeting().given(
      eventDraft('gate.opened', {
        gateId: 'g',
        stageId: 'meeting',
        kind: 'exception',
        exceptionKind: 'decision-request',
        title: 'Gate',
        options: [],
        content: { type: 'exception', summary: 'question', attemptId: 'other' },
        version: 1,
      }),
    );
    e.given(submit());
    const gate = e.state.gates.g!;
    if (gate.content.type === 'exception') gate.content.attemptId = 'a';
    error(e, submit(agenda, 's2'), 'gate_open');
  });
  test('explicit rejection is recorded without submission text', () => {
    const h = meeting().given({
      type: 'RejectSubmission',
      meta: meta(),
      rejection: {
        reason: 'identity_mismatch',
        attemptId: 'a',
        kind: 'agenda',
      },
    });
    expect(h.state.rejectedSubmissions).toBe(1);
  });
  test('work-items semantic validation also applies on submission', () => {
    const h = throughStage(new Harness(), 'meeting').given(
      startStage('breakdown'),
      spawn('a', 'lead', 'breakdown', { purpose: 'planner' }),
    );
    error(
      h,
      submit({
        kind: 'work-items',
        payload: {
          items: [
            {
              key: 'w1',
              title: 't',
              body: 'b',
              acceptance: [],
              role: 'missing',
              deps: [],
            },
          ],
        },
      }),
      'unknown_role',
    );
  });
});

test('purpose does not authorize a different template role', () => {
  const h = new Harness().given(
    startCommand(),
    startStage('meeting'),
    spawn('a', 'engineer', 'meeting', { purpose: 'facilitator' }),
  );
  error(h, submit(), 'not_allowed');
});

test('session metadata is emitted on first report/change and preserved by replay', () => {
  const h = meeting();
  const first = { provider: 'claude' as const, id: 'session-one' };
  const changed = { provider: 'claude' as const, id: 'session-two' };
  h.given({ ...submit(agenda, 'first'), agentSession: first });
  expect(h.events.at(-1)?.payload).toMatchObject({ agentSession: first });
  expect(h.state.attempts.a?.agentSession).toEqual(first);
  h.given({ ...submit(agenda, 'same'), agentSession: first });
  expect(h.events.at(-1)?.payload).not.toHaveProperty('agentSession');
  h.given(submit(agenda, 'omitted'));
  expect(h.state.attempts.a?.agentSession).toEqual(first);
  h.given({ ...submit(agenda, 'changed'), agentSession: changed });
  expect(h.events.at(-1)?.payload).toMatchObject({ agentSession: changed });
  const replayed = new Harness();
  replayed.append(...h.events);
  expect(replayed.state.attempts.a?.agentSession).toEqual(changed);
});
