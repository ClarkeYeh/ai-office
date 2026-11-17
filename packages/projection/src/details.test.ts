import { expect, test } from 'vitest';
import { WorkflowReadModelSchema } from '@ai-office/contracts/api';
import { evolve, replay } from './index.js';
import { event, payloads, at } from './test-support/events.js';
import { prepared, scenario } from './test-support/scenario.js';

const exception = (extra: Record<string, unknown> = {}) => ({
  gateId: 'ex',
  stageId: 'implement',
  kind: 'exception',
  exceptionKind: 'question-escalation',
  title: 'Choose',
  options: [{ optionId: 'yes', label: 'Yes' }],
  content: { type: 'exception', summary: 'Need input', questionId: 'msg1' },
  version: 1,
  ...extra,
});

test('gate exception options, answers, revisions and missing references', () => {
  const s = prepared();
  s.push('message.escalated', {
    questionId: 'msg1',
    reason: 'timeout',
    gateId: 'ex',
  });
  s.push('gate.opened', exception());
  expect(s.model.questions[0]?.escalation?.options).toHaveLength(1);
  expect(s.model.gates.at(-1)?.questionId).toBe('msg1');
  s.push('gate.decided', {
    gateId: 'ex',
    decision: 'answer',
    by: 'user',
    version: 1,
    optionId: 'yes',
    comment: 'Proceed',
  });
  expect(s.model.gates.at(-1)).toMatchObject({
    status: 'approved',
    decision: { decision: 'answer', optionId: 'yes', comment: 'Proceed' },
  });
  s.push('message.answered', {
    questionId: 'msg1',
    by: 'user',
    body: 'Yes',
    optionId: 'yes',
  });
  expect(s.model.questions[0]?.answer?.optionId).toBe('yes');
  s.push('gate.decided', {
    gateId: 'g1',
    decision: 'revise',
    by: 'user',
    version: 2,
    edits: {
      type: 'conclusion',
      conclusion: {
        ...payloads['submission.accepted'].submission.payload,
        summary: 'Revised',
      },
    },
  });
  expect(s.model.gates[0]?.conclusion?.original?.summary).toBe('Revised');
  expect(s.model.gates[0]?.status).toBe('revised');
  s.push('gate.decided', {
    gateId: 'g1',
    decision: 'reject',
    by: 'user',
    version: 3,
  });
  expect(s.model.gates[0]?.status).toBe('rejected');
  s.push('gate.content_updated', {
    gateId: 'g1',
    source: 'github',
    version: 2,
    bodyHash: 'c'.repeat(64),
    githubUpdatedAt: at,
  });
  expect(s.model.gates[0]?.version).toBe(3);
  s.push('gate.content_updated', { gateId: 'g1', source: 'user', version: 4 });
  s.push('gate.content_updated', {
    gateId: 'ex',
    source: 'github',
    version: 2,
    bodyHash: 'c'.repeat(64),
    githubUpdatedAt: at,
  });
  s.push('gate.content_updated', {
    gateId: 'ex',
    source: 'agent',
    version: 3,
    artifactId: 'ignored',
  });
  s.push(
    'gate.opened',
    exception({
      gateId: 'unknown-stage',
      stageId: 'missing',
      content: { type: 'exception', summary: 'Other' },
    }),
  );
  s.push(
    'gate.opened',
    exception({
      gateId: 'missing-question',
      content: { type: 'exception', summary: 'Other', questionId: 'missing' },
    }),
  );
  s.push('gate.opened', {
    ...payloads['gate.opened'],
    gateId: 'plan',
    stageId: 'planning',
    templateGateId: 'plan',
    stageKind: 'planning',
    content: { type: 'work-items', artifactId: 'missing' },
  });
  expect(s.model.gates.at(-1)?.workItems).toEqual([]);
  s.push('gate.decided', {
    gateId: 'plan',
    decision: 'revise',
    by: 'user',
    version: 2,
    edits: { type: 'work-items', items: payloads['workitem.proposed'].items },
  });
  expect(s.model.gates.at(-1)?.workItems).toHaveLength(1);
  s.push('gate.decided', {
    ...payloads['gate.decided'],
    approvedSnapshot: {
      ...payloads['gate.decided'].approvedSnapshot,
      source: 'ai-office',
      structured: payloads['submission.accepted'].submission.payload,
    },
  });
  expect(s.model.gates[0]?.conclusion?.original?.summary).toBe('Build it');
});

test('conclusion drift is based only on body hash; timestamps are display-only', () => {
  const s = prepared();
  s.push('gate.content_updated', {
    ...payloads['gate.content_updated'],
    bodyHash: 'c'.repeat(64),
  });
  expect(s.model.gates[0]?.conclusion?.changedOnGithub).toBe(true);
  s.push('scm.issue_drift', {
    ...payloads['scm.issue_drift'],
    gateId: 'g1',
    githubUpdatedAt: '2026-11-18T00:00:00Z',
  });
  expect(s.model.gates[0]?.conclusion?.changedOnGithub).toBe(false);
  expect(s.model.gates[0]?.version).toBe(2);
  s.push('gate.decided', {
    ...payloads['gate.decided'],
    approvedSnapshot: {
      ...payloads['gate.decided'].approvedSnapshot,
      githubUpdatedAt: at,
      bodyHash: 'c'.repeat(64),
    },
  });
  expect(s.model.gates[0]?.conclusion?.changedOnGithub).toBe(true);
  s.push('gate.opened', {
    ...payloads['gate.opened'],
    gateId: 'no-content',
    content: {
      type: 'conclusion',
      artifactId: 'missing',
      renderedHash: 'b'.repeat(64),
    },
  });
  expect(s.model.gates.at(-1)?.conclusion?.original).toBeNull();
  s.push('submission.accepted', {
    ...payloads['submission.accepted'],
    artifactId: undefined,
  });
  expect(Object.keys(s.model.acceptedSubmissions)).toEqual(['art1']);
});

test('artifacts link issues, branches, PR status and final gate views', () => {
  const s = prepared();
  s.push('artifact.created', {
    artifactId: 'issue',
    kind: 'issue',
    number: 4,
    url: 'https://github.com/octo/demo/issues/4',
    purpose: 'work-item',
    itemKey: 'w1',
  });
  expect(s.model.workItems[0]?.issue?.url).toContain('/issues/4');
  s.push('artifact.created', {
    artifactId: 'branch',
    kind: 'branch',
    name: 'ai-office/abcd/w1',
    purpose: 'worker',
    itemKey: 'w1',
  });
  expect(s.model.workItems[0]?.branch).toBe('ai-office/abcd/w1');
  s.push('artifact.created', {
    artifactId: 'sub-art',
    kind: 'conclusion',
    attemptId: 'a1',
    submissionId: 's1',
  });
  expect(s.model.artifacts.at(-1)?.stageId).toBe('implement');
  s.push(
    'artifact.created',
    {
      artifactId: 'orphan-art',
      kind: 'conclusion',
      attemptId: 'missing',
      submissionId: 's2',
    },
    { stageId: 'meeting' },
  );
  s.push('artifact.created');
  s.push('artifact.created');
  s.push('pr.status');
  expect(s.model.workItems[0]?.pr?.number).toBe(5);
  s.push('gate.opened', {
    ...payloads['gate.opened'],
    gateId: 'final',
    stageId: 'final-pr',
    stageKind: 'final-pr',
    content: { type: 'final-pr', artifactId: 'art4', pr: 5 },
  });
  expect(s.model.gates.at(-1)?.pr?.state).toBe('merged');
  s.push('pr.status', {
    ...payloads['pr.status'],
    state: 'open',
    mergeable: true,
  });
  expect(s.model.prs).toHaveLength(1);
  expect(s.model.gates.at(-1)?.pr?.state).toBe('open');
  s.push('gate.opened', {
    ...payloads['gate.opened'],
    gateId: 'final-ref',
    stageId: 'final-pr',
    stageKind: 'final-pr',
    content: { type: 'final-pr', artifactId: 'art4' },
  });
  expect(s.model.gates.at(-1)?.pr?.number).toBe(5);
  s.push('gate.opened', {
    ...payloads['gate.opened'],
    gateId: 'final-missing',
    stageId: 'final-pr',
    stageKind: 'final-pr',
    content: { type: 'final-pr', artifactId: 'none' },
  });
  s.push('pr.status', { ...payloads['pr.status'], state: 'closed' });
  s.push('workitem.status', {
    ...payloads['workitem.status'],
    issue: 4,
    headSha: 'a'.repeat(40),
    reason: 'Review',
  });
  expect(s.model.workItems[0]).toMatchObject({
    issue: { number: 4 },
    reason: 'Review',
    headSha: 'a'.repeat(40),
    pr: { state: 'closed' },
  });
  expect(WorkflowReadModelSchema.parse(s.model)).toEqual(s.model);
});

test('usage deltas accumulate across retries, seats, agents and stages without double counting', () => {
  const s = prepared();
  s.push('usage.tokens');
  s.push('usage.tokens');
  s.push('usage.turns');
  s.push('usage.tokens', {
    ...payloads['usage.tokens'],
    attemptId: 'a4',
    reasoning: 7,
  });
  s.push('usage.turns', { attemptId: 'a4', turns: 2 });
  const m = s.model;
  expect(m.usage.total).toMatchObject({
    budgetTokens: 105,
    reasoning: 7,
    turns: 3,
  });
  expect(m.usage.byStage.implement).toEqual(m.usage.total);
  expect(m.usage.byAgent['claude-code']).toEqual(m.usage.total);
  expect(m.usage.bySeat['wf1:lead']?.budgetTokens).toBe(70);
  expect(m.workItems[0]?.usage).toMatchObject({ budgetTokens: 35, turns: 2 });
  expect(m.seats[0]?.attempts[0]?.usage.budgetTokens).toBe(70);
  expect(evolve(m, event('usage.tokens', m.lastSeq))).toBe(m);
});

test('latest attempts drive seat presentation, with bounded recent metadata and preserved history', () => {
  const s = prepared();
  for (let i = 0; i < 25; i++)
    s.push('seat.activity', {
      attemptId: 'a1',
      activity: [
        { ...payloads['seat.activity'].activity[0], messageId: `m${i}` },
      ],
    });
  expect(s.model.seats[0]?.recentActivity).toHaveLength(20);
  expect(s.model.seats[0]?.recentActivity[0]?.messageId).toBe('m5');
  s.push('seat.degraded');
  expect(s.model.seats[0]?.degraded).toBe(false); // a1 is historical; a5 owns the shared lead seat.
  s.push('seat.spawned', {
    ...payloads['seat.spawned'],
    attemptId: 'a7',
    attempt: 3,
    retryOf: 'a5',
    itemKey: 'w1',
  });
  s.push('seat.status', {
    attemptId: 'a7',
    state: 'waiting_input',
    waitingSince: at,
  });
  s.push('seat.status', { attemptId: 'a7', state: 'working' });
  expect(s.model.seats[0]?.attempts.at(-1)?.waitingSince).toBeUndefined();
  s.push('seat.degraded', { attemptId: 'a7', reason: 'no_transcript_source' });
  expect(s.model.seats[0]?.degraded).toBe(true);
  s.push('error.recorded', undefined, { attemptId: 'a7' });
  s.push('command.failed', undefined, { attemptId: 'a7' });
  expect(s.model.seats[0]?.errors).toHaveLength(2);
  s.push('error.recorded', undefined, { attemptId: 'missing' });
  s.push('command.failed', undefined, { attemptId: 'missing' });
  expect(s.model.errors).toHaveLength(4);
});

test('stage reruns preserve history and question routing never invents missing entities', () => {
  const s = prepared();
  s.push('stage.started', {
    ...payloads['stage.started'],
    attempt: 2,
    mode: 'rerun',
    feedback: 'Improve',
    agentOverride: 'codex',
  });
  s.push('stage.completed', { stageId: 'meeting', attempt: 1 });
  expect(s.model.stages[0]?.status).toBe('running');
  s.push('stage.failed', { stageId: 'meeting', attempt: 2, reason: 'timeout' });
  expect(s.model.stages[0]?.runs.at(-1)).toMatchObject({
    failReason: 'timeout',
    feedback: 'Improve',
    agentOverride: 'codex',
  });
  s.push('oncall.queue_changed');
  s.push('oncall.queue_changed', { stageId: 'implement', queue: [] });
  expect(s.model.stages[2]?.oncall?.current).toBeUndefined();
  s.push('oncall.stopped', {
    ...payloads['oncall.stopped'],
    attemptId: 'different',
  });
  expect(s.model.stages[2]?.oncall?.active).toBe(true);
  s.push('workflow.failed', { reason: 'other', detail: 'Reason' });
  expect(s.model.outcome?.detail).toBe('Reason');
  s.push('workitem.dispatched', {
    ...payloads['workitem.dispatched'],
    attemptId: 'absent',
  });
  expect(s.model.workItems[0]?.currentAttemptId).toBe('absent');
  expect(replay(s.events)).toEqual(s.model);
});

test('missing entities are total across all reference-bearing events', () => {
  const s = scenario();
  for (const [type, payload] of Object.entries(payloads)) {
    if (type === 'workflow.started') continue;
    const p = { ...payload } as Record<string, unknown>;
    for (const key of [
      'stageId',
      'gateId',
      'attemptId',
      'questionId',
      'itemKey',
    ])
      if (key in p) p[key] = 'missing';
    s.push(type as Parameters<typeof event>[0], p);
  }
  expect(s.model.lastSeq).toBe(Object.keys(payloads).length);
});
