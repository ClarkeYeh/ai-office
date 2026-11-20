import { describe, expect, test } from 'vitest';
import type {
  DomainEventDraft,
  EventPayload,
} from '@ai-office/contracts/events';
import type { DomainCommand, EvaluateAnomaly } from '../commands.js';
import { decide } from './index.js';
import { initialState } from '../state/index.js';
import { replay } from '../evolve.js';
import { questionWaitMilliseconds } from './question.js';
import {
  Harness,
  startCommand,
  startStage,
  spawn,
  throughStage,
  meta,
  at,
  eventDraft,
} from '../test-support/fixtures.js';

const item = (key = 'T1', deps: string[] = []) => ({
  key,
  title: key,
  body: 'Implement feature',
  acceptance: ['Works'],
  role: 'engineer',
  agent: 'codex' as const,
  deps,
});
const implementation = () =>
  throughStage(new Harness(), 'breakdown').given(
    eventDraft('workitem.approved', {
      gateId: 'task-split',
      items: [item(), item('T2', ['T1'])],
    }),
    startStage('implement'),
  );
const worker = () =>
  implementation().given(
    {
      type: 'DispatchWorkItem',
      meta: meta(),
      itemKey: 'T1',
      attemptId: 'worker',
    },
    spawn('worker', 'engineer', 'implement', {
      purpose: 'worker',
      itemKey: 'T1',
    }),
  );
const meeting = () =>
  new Harness().given(
    startCommand(),
    startStage('meeting'),
    spawn('lead', 'lead', 'meeting', { purpose: 'facilitator' }),
  );
const tokens = (amount: number, attemptId = 'worker'): DomainCommand => ({
  type: 'RecordUsageTokens',
  meta: meta(10),
  usage: {
    attemptId,
    inputUncached: amount,
    output: 0,
    cacheRead: 999999,
    cacheWrite: 0,
    budgetTokens: amount,
  },
});
const turns = (amount: number, attemptId = 'worker'): DomainCommand => ({
  type: 'RecordUsageTurns',
  meta: meta(10),
  usage: { attemptId, turns: amount },
});
const emitted = (h: Harness, command: DomainCommand): DomainEventDraft[] => {
  const result = h.run(command);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result.ok ? result.events : [];
};
const rejected = (h: Harness, command: DomainCommand, code?: string) => {
  const result = h.run(command);
  expect(result.ok).toBe(false);
  if (!result.ok && code !== undefined) expect(result.error.code).toBe(code);
};
const ask = (id = 'q', second = 10): DomainCommand => ({
  type: 'AskQuestion',
  meta: meta(second),
  questionId: id,
  attemptId: 'worker',
  body: 'Which implementation?',
});
const forward = (retry = 0, toAttemptId = 'oncall'): DomainCommand => ({
  type: 'ForwardQuestion',
  meta: meta(11),
  questionId: 'q',
  to: 'on-call',
  toAttemptId,
  retry,
});
const oncall = (h: Harness, id = 'oncall') =>
  h.given(spawn(id, 'lead', 'implement', { purpose: 'oncall' }));
const exit = (h: Harness, id: string) =>
  h.given({
    type: 'RecordAttemptExited',
    meta: meta(20),
    attemptId: id,
    reason: 'exit',
    expected: false,
  });
const escalate = (
  reason: EventPayload<'message.escalated'>['reason'] = 'timeout',
): DomainCommand => ({
  type: 'EscalateQuestion',
  meta: meta(30),
  questionId: 'q',
  reason,
  gateId: 'q-gate',
});
const anomaly = (
  observation: EvaluateAnomaly['observation'],
): DomainCommand => ({ type: 'EvaluateAnomaly', meta: meta(30), observation });
const pr = (
  overrides: Partial<EventPayload<'pr.status'>> = {},
): EventPayload<'pr.status'> => ({
  pr: 12,
  state: 'open',
  base: 'main',
  head: 'worker',
  headSha: 'abcdef1',
  mergeable: true,
  ...overrides,
});

describe('budget rules', () => {
  test('a retry starts a fresh item ledger while preserving stage and workflow usage', () => {
    const h = worker();
    emitted(h, tokens(800000));
    h.given({
      type: 'UpdateWorkItemStatus',
      meta: meta(),
      update: { itemKey: 'T1', status: 'needs_attention' },
    });
    exit(h, 'worker');
    h.given(
      {
        type: 'DispatchWorkItem',
        meta: meta(),
        itemKey: 'T1',
        attemptId: 'retry',
      },
      spawn('retry', 'engineer', 'implement', {
        purpose: 'worker',
        itemKey: 'T1',
        retryOf: 'worker',
      }),
    );
    const events = emitted(h, tokens(400000, 'retry'));
    expect(events[1]).toMatchObject({
      type: 'budget.exceeded',
      payload: { scope: 'item', attemptId: 'retry', used: 400000 },
    });
    expect(h.state.usage.workflow.tokens).toBe(1200000);
    expect(h.state.usage.stages['implement#1']?.tokens).toBe(1200000);
    expect(h.state.usage.attempts.retry?.tokens).toBe(400000);
  });

  test('accumulates deltas independently for stage, item and workflow; emits each level once', () => {
    const h = worker();
    expect(emitted(h, tokens(399999))).toHaveLength(1);
    const first = emitted(h, tokens(1));
    expect(first[1]).toMatchObject({
      type: 'budget.exceeded',
      payload: { scope: 'item', used: 400000 },
    });
    expect(emitted(h, tokens(0))).toHaveLength(1);
    expect(emitted(h, tokens(400000))[1]).toMatchObject({
      type: 'budget.hard_limit',
      payload: { scope: 'item', threshold: 800000 },
    });
    const rest = emitted(h, tokens(5200000));
    expect(
      rest.filter((e) => e.type.startsWith('budget.')).map((e) => e.payload),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'stage', threshold: 1500000 }),
        expect.objectContaining({ scope: 'stage', threshold: 3000000 }),
        expect.objectContaining({ scope: 'workflow', threshold: 3000000 }),
        expect.objectContaining({ scope: 'workflow', threshold: 6000000 }),
      ]),
    );
    expect(emitted(h, tokens(1))).toHaveLength(1);
    expect(h.state.usage.workflow.tokens).toBe(6000001);
    expect(h.state.usage.attempts.worker?.tokens).toBe(6000001);
    expect(h.warnings).toEqual([]);
  });
  test('top-up raises the next threshold without opening the same level again', () => {
    const h = worker();
    const first = emitted(h, tokens(400000));
    const alert = first.find((e) => e.type === 'budget.exceeded');
    if (alert?.type !== 'budget.exceeded') throw Error('missing alert');
    const gateId = alert.payload.gateId!;
    h.given(
      eventDraft('gate.opened', {
        gateId,
        kind: 'exception',
        stageId: 'implement',
        exceptionKind: 'item-budget-exceeded',
        title: 'Budget',
        options: [],
        content: { type: 'exception', summary: 'Budget' },
        version: 1,
      }),
      eventDraft('gate.decided', {
        gateId,
        decision: 'option',
        by: 'user',
        version: 1,
        additionalTokens: 100000,
      }),
    );
    expect(emitted(h, tokens(499999))).toHaveLength(1);
    expect(emitted(h, tokens(100001))[1]).toMatchObject({
      type: 'budget.hard_limit',
      payload: { scope: 'item', budget: 500000, threshold: 1000000 },
    });
  });
  test('turns use the same two levels and share dedupe with tokens', () => {
    const h = worker();
    expect(emitted(h, turns(120))[1]).toMatchObject({
      type: 'budget.exceeded',
      payload: { scope: 'item', metric: 'turns' },
    });
    expect(emitted(h, turns(120))[1]).toMatchObject({
      type: 'budget.hard_limit',
    });
    expect(emitted(h, tokens(800000))).toHaveLength(1);
    const m = meeting();
    expect(
      emitted(m, turns(120, 'lead')).filter((e) =>
        e.type.startsWith('budget.'),
      ),
    ).toHaveLength(2);
    expect(emitted(m, tokens(0, 'lead'))).toHaveLength(1);
  });
  test('wall clock fallback and item question suspension', () => {
    const h = meeting();
    expect(
      emitted(h, {
        type: 'RecordWallclockLimit',
        meta: meta(),
        stageId: 'meeting',
        usedMinutes: 59,
      }),
    ).toEqual([]);
    expect(
      emitted(h, {
        type: 'RecordWallclockLimit',
        meta: meta(),
        stageId: 'meeting',
        usedMinutes: 120,
      }).map((e) => e.type),
    ).toEqual(['budget.exceeded', 'budget.hard_limit']);
    const w = worker().given(ask('q', 60));
    expect(
      emitted(w, {
        type: 'RecordWallclockLimit',
        meta: meta(3600),
        stageId: 'implement',
        itemKey: 'T1',
        attemptId: 'worker',
        usedMinutes: 60,
      }),
    ).toEqual([]);
    const fresh = worker();
    expect(
      emitted(fresh, {
        type: 'RecordWallclockLimit',
        meta: meta(),
        stageId: 'implement',
        itemKey: 'T1',
        attemptId: 'worker',
        usedMinutes: 90,
      }),
    ).toHaveLength(2);
  });
  test('invalid usage and timeout scopes are rejected', () => {
    const h = worker();
    for (const command of [
      tokens(-1),
      tokens(NaN),
      turns(0),
      tokens(1, 'missing'),
      {
        type: 'RecordWallclockLimit',
        meta: meta(),
        stageId: 'implement',
        usedMinutes: -1,
      },
      {
        type: 'RecordWallclockLimit',
        meta: meta(),
        stageId: 'missing',
        usedMinutes: 2,
      },
      {
        type: 'RecordWallclockLimit',
        meta: meta(),
        stageId: 'implement',
        usedMinutes: 2,
      },
      {
        type: 'RecordWallclockLimit',
        meta: meta(),
        stageId: 'meeting',
        itemKey: 'T1',
        usedMinutes: 2,
      },
    ] as DomainCommand[])
      rejected(h, command);
    rejected(new Harness(), tokens(1));
    const f = throughStage(new Harness(), 'integrate').given(
      startStage('final-pr'),
    );
    expect(
      emitted(f, {
        type: 'RecordWallclockLimit',
        meta: meta(),
        stageId: 'final-pr',
        usedMinutes: 999,
      }),
    ).toEqual([]);
  });
});

describe('work item rules', () => {
  test('dependencies wait for merged rather than pr_open', () => {
    const h = worker();
    for (const status of ['in_progress', 'pushed', 'pr_open'] as const)
      h.given({
        type: 'UpdateWorkItemStatus',
        meta: meta(),
        update: { itemKey: 'T1', status },
      });
    rejected(
      h,
      {
        type: 'DispatchWorkItem',
        meta: meta(),
        itemKey: 'T2',
        attemptId: 'dependent',
      },
      'dependencies_not_ready',
    );
    h.given(
      eventDraft('workitem.status', { itemKey: 'T1', status: 'merged' }),
      {
        type: 'DispatchWorkItem',
        meta: meta(),
        itemKey: 'T2',
        attemptId: 'dependent',
      },
    );
    expect(h.state.workItems.T2?.status).toBe('dispatched');
  });

  test('full lifecycle and retry numbering, names, and immutable old-attempt rejection', () => {
    const h = worker();
    expect(h.state.workItems.T1).toMatchObject({
      branch: 'ai-office/ab12/T1',
      attempt: 1,
    });
    for (const status of ['in_progress', 'pushed', 'pr_open'] as const)
      h.given({
        type: 'UpdateWorkItemStatus',
        meta: meta(),
        update: { itemKey: 'T1', attemptId: 'worker', status },
      });
    h.given(eventDraft('workitem.status', { itemKey: 'T1', status: 'merged' }));
    expect(
      emitted(h, {
        type: 'DispatchWorkItem',
        meta: meta(),
        itemKey: 'T2',
        attemptId: 'second',
      }),
    ).toHaveLength(1);
    const r = worker();
    r.given({
      type: 'UpdateWorkItemStatus',
      meta: meta(),
      update: { itemKey: 'T1', status: 'needs_attention' },
    });
    rejected(
      r,
      {
        type: 'DispatchWorkItem',
        meta: meta(),
        itemKey: 'T1',
        attemptId: 'retry',
      },
      'attempt_alive',
    );
    exit(r, 'worker');
    rejected(r, {
      type: 'DispatchWorkItem',
      meta: meta(),
      itemKey: 'T1',
      attemptId: 'retry',
      retryOf: 'wrong',
    });
    r.given({
      type: 'DispatchWorkItem',
      meta: meta(),
      itemKey: 'T1',
      attemptId: 'retry',
      retryOf: 'worker',
      agent: 'claude-code',
    });
    expect(r.state.workItems.T1).toMatchObject({
      branch: 'ai-office/ab12/T1-a2',
      workspaceName: 'aio-ab12-T1-a2',
      attempt: 2,
      agent: 'claude-code',
    });
    rejected(
      r,
      {
        type: 'UpdateWorkItemStatus',
        meta: meta(),
        update: { itemKey: 'T1', attemptId: 'worker', status: 'merged' },
      },
      'stale_attempt',
    );
  });
  test('dispatch guards, terminal states, dependency and status metadata', () => {
    const h = implementation();
    rejected(new Harness(), {
      type: 'DispatchWorkItem',
      meta: meta(),
      itemKey: 'T1',
      attemptId: 'x',
    });
    rejected(h, {
      type: 'DispatchWorkItem',
      meta: meta(),
      itemKey: 'missing',
      attemptId: 'x',
    });
    rejected(
      h,
      { type: 'DispatchWorkItem', meta: meta(), itemKey: 'T2', attemptId: 'x' },
      'dependencies_not_ready',
    );
    h.given({
      type: 'UpdateWorkItemStatus',
      meta: meta(),
      update: {
        itemKey: 'T1',
        status: 'skipped',
        issue: 1,
        pr: 2,
        headSha: 'abcdef1',
        reason: 'user',
      },
    });
    rejected(
      h,
      {
        type: 'DispatchWorkItem',
        meta: meta(),
        itemKey: 'T2',
        attemptId: 'x',
      },
      'dependencies_not_ready',
    );
    rejected(h, {
      type: 'DispatchWorkItem',
      meta: meta(),
      itemKey: 'T1',
      attemptId: 'y',
    });
    rejected(h, {
      type: 'UpdateWorkItemStatus',
      meta: meta(),
      update: { itemKey: 'T1', status: 'merged' },
    });
    const r = worker();
    r.given({
      type: 'UpdateWorkItemStatus',
      meta: meta(),
      update: { itemKey: 'T1', status: 'failed' },
    });
    rejected(
      r,
      {
        type: 'DispatchWorkItem',
        meta: meta(),
        itemKey: 'T1',
        attemptId: 'worker',
      },
      'duplicate_attempt',
    );
    r.given({
      type: 'UpdateWorkItemStatus',
      meta: meta(),
      update: { itemKey: 'T1', status: 'failed' },
    });
    r.state.stages.implement!.status = 'done';
    rejected(r, {
      type: 'DispatchWorkItem',
      meta: meta(),
      itemKey: 'T1',
      attemptId: 'next',
    });
  });
});

describe('questions and replayable timeout accounting', () => {
  test('answers from on-call, overlapping waits, and deterministic replay', () => {
    const h = oncall(worker()).given(ask(), forward(), ask('q2', 15));
    h.given({
      type: 'AnswerQuestion',
      meta: meta(20),
      questionId: 'q',
      by: 'agent',
      attemptId: 'oncall',
      body: 'Use A',
    });
    expect(questionWaitMilliseconds(h.state, 'worker', at(30))).toBe(20000);
    expect(questionWaitMilliseconds(h.state, 'other', at(30))).toBe(0);
    expect(replay(h.events).state).toEqual(h.state);
    expect(
      questionWaitMilliseconds(replay(h.events).state, 'worker', at(30)),
    ).toBe(20000);
    expect(h.state.questions.q?.answeredAt).toBe(at(20));
    rejected(h, forward(), 'question_answered');
  });
  test('one retry per question, then escalate after another failed responder', () => {
    const h = oncall(worker()).given(ask(), forward());
    rejected(h, escalate('oncall-failed'), 'question_retry_available');
    oncall(exit(h, 'oncall'), 'oncall2');
    h.given(forward(1, 'oncall2'));
    rejected(h, forward(2, 'oncall2'), 'question_retry_limit');
    rejected(h, escalate('oncall-failed'));
    exit(h, 'oncall2');
    h.given(escalate('oncall-failed'));
    expect(emitted(h, escalate('oncall-failed'))).toEqual([]);
    rejected(h, forward());
    rejected(h, {
      type: 'AnswerQuestion',
      meta: meta(),
      questionId: 'q',
      by: 'agent',
      attemptId: 'oncall2',
      body: 'A',
    });
    rejected(h, {
      type: 'AnswerQuestion',
      meta: meta(),
      questionId: 'q',
      by: 'user',
      body: 'A',
      gateId: 'wrong',
    });
    h.given({
      type: 'AnswerQuestion',
      meta: meta(40),
      questionId: 'q',
      by: 'user',
      body: 'A',
      gateId: 'q-gate',
      optionId: 'answer',
    });
    expect(h.state.questions.q?.status).toBe('answered');
    expect(questionWaitMilliseconds(h.state, 'worker', at(90))).toBe(30000);
  });
  test.each(['timeout', 'decision-request', 'no-responder'] as const)(
    '%s escalates without expired status',
    (reason) => {
      const h = worker().given(ask(), escalate(reason));
      expect(h.state.questions.q?.status).toBe('escalated');
    },
  );
  test('identity, retry and answer guards', () => {
    const h = oncall(worker()).given(ask());
    rejected(new Harness(), ask());
    rejected(h, ask());
    rejected(h, { ...ask('wrong'), itemKey: 'T2' } as DomainCommand);
    rejected(h, { ...ask('wrong'), attemptId: 'missing' } as DomainCommand);
    rejected(h, { ...forward(), questionId: 'missing' } as DomainCommand);
    rejected(h, forward(0, 'worker'));
    rejected(h, forward(1));
    rejected(h, {
      type: 'AnswerQuestion',
      meta: meta(),
      questionId: 'q',
      by: 'agent',
      body: 'A',
    });
    rejected(h, {
      type: 'AnswerQuestion',
      meta: meta(),
      questionId: 'q',
      by: 'user',
      body: 'A',
    });
    h.given(forward());
    rejected(h, forward(1), 'responder_not_failed');
    rejected(h, {
      type: 'AnswerQuestion',
      meta: meta(),
      questionId: 'q',
      by: 'agent',
      attemptId: 'worker',
      body: 'A',
    });
    exit(h, 'oncall');
    rejected(h, {
      type: 'AnswerQuestion',
      meta: meta(),
      questionId: 'q',
      by: 'agent',
      attemptId: 'oncall',
      body: 'A',
    });
    const m = meeting().given(spawn('participant', 'engineer'));
    m.given({
      type: 'AskQuestion',
      meta: meta(),
      questionId: 'meeting-q',
      attemptId: 'participant',
      body: 'Clarify?',
    });
    m.given({
      type: 'ForwardQuestion',
      meta: meta(),
      questionId: 'meeting-q',
      to: 'facilitator',
      toAttemptId: 'lead',
      retry: 0,
    });
    expect(questionWaitMilliseconds(m.state, 'participant', 'invalid')).toBe(0);
  });
});

describe('anomaly classification', () => {
  test.each(['issue', 'pr'] as const)(
    'unknown owner %s only after start and without marker',
    (kind) => {
      const observation =
        kind === 'issue' ? { kind, number: 12 } : { kind, pr: pr() };
      const h = meeting();
      for (const patch of [
        { managed: true, author: 'octo', createdAt: at(1) },
        { managed: false, author: 'other', createdAt: at(1) },
        { managed: false, author: 'octo', createdAt: at(-1) },
        { managed: false, author: 'octo' },
      ])
        expect(emitted(h, anomaly({ ...observation, ...patch }))).toEqual([]);
      expect(
        emitted(
          h,
          anomaly({
            ...observation,
            managed: false,
            author: 'octo',
            createdAt: at(1),
          }),
        ).map((e) => e.type),
      ).toEqual(['anomaly.detected', 'workflow.paused']);
    },
  );
  test('worker merges must match the command ledger including repo and expected head', () => {
    const h = meeting();
    const merged = pr({
      state: 'merged',
      base: h.state.workflow!.integrationBranch,
    });
    expect(
      emitted(h, anomaly({ kind: 'pr', pr: merged, managed: true }))[0],
    ).toMatchObject({
      type: 'anomaly.detected',
      payload: { kind: 'unmanaged-merge' },
    });
    h.given(
      eventDraft('command.issued', {
        commandId: 'merge',
        kind: 'scm.mergePR',
        args: {
          pr: { repo: { owner: 'octo', name: 'demo' }, number: 12 },
          method: 'merge',
          expectedHeadSha: 'abcdef1',
        },
      }),
    );
    expect(
      emitted(h, anomaly({ kind: 'pr', pr: merged, managed: true })),
    ).toEqual([]);
    expect(
      emitted(
        h,
        anomaly({
          kind: 'pr',
          pr: { ...merged, headSha: 'abcdef2' },
          managed: true,
        }),
      )[0],
    ).toMatchObject({ payload: { kind: 'unmanaged-merge' } });
  });
  test('early final merge vs accepted integration report', () => {
    const h = meeting();
    h.state.workflow!.finalPr = 12;
    const observation = {
      kind: 'pr' as const,
      pr: pr({ state: 'merged' }),
      managed: true,
    };
    expect(emitted(h, anomaly(observation))[0]).toMatchObject({
      payload: { kind: 'early-merge' },
    });
    h.state.submissions.report = {
      id: 'report',
      attemptId: 'lead',
      kind: 'integration-report',
      submission: {
        kind: 'integration-report',
        payload: { summary: 'done', merged: [], verification: [], risks: [] },
      },
      acceptedAt: at(20),
    };
    expect(emitted(h, anomaly(observation))).toEqual([]);
  });
  test('default branch movement excludes final-PR merge and unchanged baseline', () => {
    const h = meeting();
    expect(
      emitted(
        h,
        anomaly({
          kind: 'default-branch',
          sha: 'abcdef1',
          previousSha: 'abcdef1',
        }),
      ),
    ).toEqual([]);
    expect(
      emitted(h, anomaly({ kind: 'default-branch', sha: 'abcdef1' })),
    ).toEqual([]);
    expect(
      emitted(
        h,
        anomaly({
          kind: 'default-branch',
          sha: 'abcdef2',
          previousSha: 'abcdef1',
        }),
      )[0],
    ).toMatchObject({
      payload: { kind: 'default-branch-moved', severity: 'warning' },
    });
    h.state.workflow!.finalPr = 12;
    h.given(
      eventDraft(
        'pr.status',
        pr({ state: 'merged', mergeCommitSha: 'abcdef3' }),
      ),
    );
    expect(
      emitted(
        h,
        anomaly({
          kind: 'default-branch',
          sha: 'abcdef3',
          previousSha: 'abcdef2',
        }),
      ),
    ).toEqual([]);
  });
  const repo = { owner: 'octo', name: 'demo' };
  const issued = (
    h: Harness,
    payload: EventPayload<'command.issued'>,
    result?: EventPayload<'command.succeeded'>,
  ) => {
    h.given(eventDraft('command.issued', payload));
    if (result) h.given(eventDraft('command.succeeded', result));
    return h;
  };
  const createIssue = (h: Harness, result?: number) =>
    issued(
      h,
      {
        commandId: 'wf/issue',
        kind: 'scm.createIssue',
        args: { repo, title: 'T', body: 'B', labels: ['ai-office:item'] },
      },
      result === undefined
        ? undefined
        : {
            commandId: 'wf/issue',
            kind: 'scm.createIssue',
            result: { issue: result, url: `https://github.com/o/r/${result}` },
          },
    );
  const openPr = (h: Harness, number?: number, commandId = 'wf/pr') =>
    issued(
      h,
      {
        commandId,
        kind: 'scm.openPR',
        args: { repo, title: 'T', body: 'B', head: 'worker', base: 'ib' },
      },
      number === undefined
        ? undefined
        : {
            commandId,
            kind: 'scm.openPR',
            result: {
              pr: number,
              url: `https://github.com/o/r/pull/${number}`,
            },
          },
    );
  const payloads = (events: DomainEventDraft[]) =>
    events.map((e) =>
      e.type === 'anomaly.detected'
        ? {
            kind: e.payload.kind,
            severity: e.payload.severity,
            number: e.payload.number,
            commentId: e.payload.commentId,
          }
        : e.type,
    );

  test("duplicates of another run's command are ignored (rule b)", () => {
    const h = createIssue(meeting());
    expect(
      emitted(
        h,
        anomaly({
          kind: 'duplicate',
          commandId: 'other-run/issue',
          objectKind: 'issue',
          numbers: [5, 7],
        }),
      ),
    ).toEqual([]);
  });
  test('duplicate issues: lowest kept without a result, one warning per extra, no pause, reported once', () => {
    const h = createIssue(meeting());
    const observation = {
      kind: 'duplicate' as const,
      commandId: 'wf/issue',
      objectKind: 'issue' as const,
      numbers: [9, 5, 7],
    };
    const first = emitted(h, anomaly(observation));
    expect(payloads(first)).toEqual([
      { kind: 'duplicate-object', severity: 'warning', number: 9 },
      { kind: 'duplicate-object', severity: 'warning', number: 7 },
    ]);
    expect(first.every((e) => e.type === 'anomaly.detected')).toBe(true);
    expect(first[0]!.payload).toMatchObject({ commandId: 'wf/issue' });
    expect(h.state.workflow!.pausedReasons).toEqual([]);
    expect(emitted(h, anomaly(observation))).toEqual([]);
    // A later poll that finds one more copy reports only the new one.
    expect(
      payloads(emitted(h, anomaly({ ...observation, numbers: [5, 7, 11] }))),
    ).toEqual([{ kind: 'duplicate-object', severity: 'warning', number: 11 }]);
  });
  test('duplicate issues keep the copy command.succeeded recorded', () => {
    const h = createIssue(meeting(), 7);
    expect(
      payloads(
        emitted(
          h,
          anomaly({
            kind: 'duplicate',
            commandId: 'wf/issue',
            objectKind: 'issue',
            numbers: [5, 7],
          }),
        ),
      ),
    ).toEqual([{ kind: 'duplicate-object', severity: 'warning', number: 5 }]);
  });
  test('duplicate PRs keep the recorded PR; a kind mismatch is ignored', () => {
    const h = openPr(meeting(), 8);
    expect(
      payloads(
        emitted(
          h,
          anomaly({
            kind: 'duplicate',
            commandId: 'wf/pr',
            objectKind: 'pr',
            numbers: [8, 3],
          }),
        ),
      ),
    ).toEqual([{ kind: 'duplicate-object', severity: 'warning', number: 3 }]);
    expect(
      emitted(
        h,
        anomaly({
          kind: 'duplicate',
          commandId: 'wf/pr',
          objectKind: 'issue',
          numbers: [8, 3],
        }),
      ),
    ).toEqual([]);
  });
  test('duplicate comments keep the lowest numeric id (scm.comment records no id)', () => {
    const target = { type: 'issue' as const, repo, number: 4 };
    const h = issued(meeting(), {
      commandId: 'wf/comment',
      kind: 'scm.comment',
      args: { target, body: 'hi' },
    });
    const observation = {
      kind: 'duplicate' as const,
      commandId: 'wf/comment',
      objectKind: 'comment' as const,
      commentIds: ['900', '1000', '85'],
    };
    expect(payloads(emitted(h, anomaly(observation)))).toEqual([
      { kind: 'duplicate-object', severity: 'warning', commentId: '900' },
      { kind: 'duplicate-object', severity: 'warning', commentId: '1000' },
    ]);
    expect(
      emitted(h, anomaly({ ...observation, target: { repo, number: 5 } })),
    ).toEqual([]);
    expect(emitted(h, anomaly({ ...observation, commentIds: ['85'] }))).toEqual(
      [],
    );
  });
  test('duplicate edge cases: non-numeric ids, matching target, kind and count guards', () => {
    const target = { type: 'issue' as const, repo, number: 4 };
    const h = issued(createIssue(meeting()), {
      commandId: 'wf/comment',
      kind: 'scm.comment',
      args: { target, body: 'hi' },
    });
    expect(
      payloads(
        emitted(
          h,
          anomaly({
            kind: 'duplicate',
            commandId: 'wf/comment',
            objectKind: 'comment',
            target: { repo, number: 4 },
            commentIds: ['c-b', 'c-a', '7'],
          }),
        ),
      ),
    ).toEqual([
      { kind: 'duplicate-object', severity: 'warning', commentId: 'c-b' },
      { kind: 'duplicate-object', severity: 'warning', commentId: 'c-a' },
    ]);
    for (const observation of [
      { objectKind: 'comment' as const, commandId: 'wf/issue' },
      { objectKind: 'pr' as const, commandId: 'wf/issue' },
      { objectKind: 'issue' as const, commandId: 'wf/issue', numbers: [5] },
      { objectKind: 'issue' as const, commandId: 'wf/issue' },
    ])
      expect(
        emitted(
          h,
          anomaly({
            kind: 'duplicate',
            commentIds: ['1', '2'],
            ...observation,
          }),
        ),
      ).toEqual([]);
  });
  test('a worker PR auto-closed by the backend deleting its head branch is managed', () => {
    const h = openPr(meeting(), 12);
    issued(h, {
      commandId: 'wf/delete',
      kind: 'scm.deleteBranch',
      args: { repo, name: 'ai-office/worker' },
    });
    expect(
      emitted(
        h,
        anomaly({
          kind: 'pr',
          pr: pr({ state: 'closed', head: 'ai-office/worker' }),
          managed: true,
        }),
      ),
    ).toEqual([]);
  });
  test('merge-base-changed is a high anomaly that pauses, once per command', () => {
    const h = issued(meeting(), {
      commandId: 'wf/merge',
      kind: 'scm.mergePR',
      args: {
        pr: { repo, number: 12 },
        method: 'merge',
        expectedHeadSha: 'abcdef1',
      },
    });
    const observation = {
      kind: 'merge-base-changed' as const,
      commandId: 'wf/merge',
      pr: 12,
    };
    expect(emitted(h, anomaly({ ...observation, commandId: 'nope' }))).toEqual(
      [],
    );
    const events = emitted(h, anomaly(observation));
    expect(payloads(events)).toEqual([
      { kind: 'merge-base-changed', severity: 'high', number: 12 },
      'workflow.paused',
    ]);
    expect(emitted(h, anomaly(observation))).toEqual([]);
  });
  test('integration branch moves warn only during implement, outside backend merges and baselines', () => {
    const moved = {
      kind: 'integration-branch' as const,
      sha: 'abcdef2',
      previousSha: 'abcdef1',
    };
    expect(emitted(meeting(), anomaly(moved))).toEqual([]);
    const h = implementation();
    expect(emitted(h, anomaly({ ...moved, previousSha: null }))).toEqual([]);
    expect(emitted(h, anomaly({ ...moved, previousSha: 'abcdef2' }))).toEqual(
      [],
    );
    issued(
      h,
      {
        commandId: 'wf/merge',
        kind: 'scm.mergePR',
        args: {
          pr: { repo, number: 12 },
          method: 'merge',
          expectedHeadSha: 'abcdef1',
        },
      },
      {
        commandId: 'wf/merge',
        kind: 'scm.mergePR',
        result: { mergeCommitSha: 'abcdef2' },
      },
    );
    expect(emitted(h, anomaly(moved))).toEqual([]);
    // Any known merge result: an observed merged PR (e.g. a human merge).
    h.given(
      eventDraft(
        'pr.status',
        pr({ pr: 13, state: 'merged', mergeCommitSha: 'abcdef4' }),
      ),
    );
    expect(emitted(h, anomaly({ ...moved, sha: 'abcdef4' }))).toEqual([]);
    const events = emitted(h, anomaly({ ...moved, sha: 'abcdef3' }));
    expect(payloads(events)).toEqual([
      {
        kind: 'integration-branch-moved',
        severity: 'warning',
        number: undefined,
        commentId: undefined,
      },
    ]);
    expect(h.state.workflow!.pausedReasons).toEqual([]);
    expect(emitted(h, anomaly({ ...moved, sha: 'abcdef3' }))).toEqual([]);
  });
  test('a first default-branch observation (previousSha null) is a baseline', () => {
    expect(
      emitted(
        meeting(),
        anomaly({ kind: 'default-branch', sha: 'abcdef2', previousSha: null }),
      ),
    ).toEqual([]);
  });
  test('worker PRs closed outside the backend raise unmanaged-close once; backend and final closes do not', () => {
    const closed = {
      kind: 'pr' as const,
      pr: pr({ state: 'closed' }),
      managed: true,
    };
    expect(emitted(meeting(), anomaly(closed))).toEqual([]);
    const h = openPr(meeting(), 12);
    const events = emitted(h, anomaly(closed));
    expect(payloads(events)).toEqual([
      { kind: 'unmanaged-close', severity: 'warning', number: 12 },
    ]);
    expect(h.state.workflow!.pausedReasons).toEqual([]);
    expect(emitted(h, anomaly(closed))).toEqual([]);
    const backend = openPr(meeting(), 12);
    issued(backend, {
      commandId: 'wf/close',
      kind: 'scm.updatePR',
      args: { pr: { repo, number: 12 }, patch: { state: 'closed' } },
    });
    expect(emitted(backend, anomaly(closed))).toEqual([]);
    const final = openPr(meeting(), 12);
    final.state.workflow!.finalPr = 12;
    expect(emitted(final, anomaly(closed))).toEqual([]);
  });
  test('policy hits and unmanaged agents; no hits and repeated unmanaged observations are no-ops', () => {
    const h = meeting();
    expect(
      emitted(h, anomaly({ kind: 'policy-hits', attemptId: 'lead', hits: [] })),
    ).toEqual([]);
    rejected(
      h,
      anomaly({ kind: 'policy-hits', attemptId: 'missing', hits: [] }),
    );
    for (const severity of ['medium', 'high'] as const)
      expect(
        emitted(
          h,
          anomaly({
            kind: 'policy-hits',
            attemptId: 'lead',
            hits: [{ rule: 'gh-merge', messageId: 'msg', severity }],
          }),
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'anomaly.detected',
            payload: expect.objectContaining({ severity }),
          }),
        ]),
      );
    const observation = {
      kind: 'unmanaged-agent' as const,
      agent: { dispatch: 'unknown' },
    };
    expect(emitted(h, anomaly(observation)).map((e) => e.type)).toEqual([
      'agent.unmanaged',
      'anomaly.detected',
    ]);
    expect(emitted(h, anomaly(observation))).toEqual([]);
    rejected(new Harness(), anomaly(observation));
    h.state.workflow!.status = 'cancelled';
    expect(emitted(h, anomaly(observation))).toEqual([]);
    expect(decide(initialState(), tokens(1)).ok).toBe(false);
  });
});
