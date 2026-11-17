import { describe, expect, test } from 'vitest';
import type {
  ApproveWorkItems,
  ProposeWorkItems,
  DecideGate,
} from '../commands.js';
import type { WorkItemDraft } from '../state/index.js';
import {
  Harness,
  completeStage,
  meta,
  spawn,
  startStage,
  throughStage,
} from '../test-support/fixtures.js';
import { validateWorkItemDrafts } from './workitem-drafts.js';
const item = (key = 'w1', deps: string[] = []): WorkItemDraft => ({
  key,
  title: 'Title',
  body: 'Body',
  acceptance: ['works'],
  role: 'engineer',
  deps,
});
const planning = () =>
  throughStage(new Harness(), 'meeting').given(
    startStage('breakdown'),
    spawn('a', 'lead', 'breakdown', { purpose: 'planner' }),
  );
const proposal = (h = planning(), items = [item()]) =>
  h.given(
    {
      type: 'AcceptSubmission',
      meta: meta(),
      attemptId: 'a',
      submissionId: 's',
      submission: { kind: 'work-items', payload: { items } },
    },
    {
      type: 'ProposeWorkItems',
      meta: meta(),
      stageId: 'breakdown',
      submissionId: 's',
      items,
    },
  );
const opened = () =>
  proposal().given(
    {
      type: 'ReleaseAttempt',
      meta: meta(),
      attemptId: 'a',
      removeWorkspace: false,
    },
    completeStage('breakdown'),
    {
      type: 'OpenGate',
      meta: meta(),
      noLiveAttempts: true,
      gate: {
        kind: 'stage',
        gateId: 'g',
        stageId: 'breakdown',
        stageKind: 'planning',
        templateGateId: 'task-split',
        optional: true,
        title: 'Split',
        options: [],
        content: { type: 'work-items', artifactId: 'art' },
      },
    },
  );
const decide: DecideGate = {
  type: 'DecideGate',
  meta: meta(),
  gateId: 'g',
  expectedVersion: 1,
  by: 'user',
  decision: 'approve',
};
const approve: ApproveWorkItems = {
  type: 'ApproveWorkItems',
  meta: meta(),
  gateId: 'g',
  items: [{ ...item(), agent: 'codex' as const }],
};
const error = (h: Harness, c: Parameters<Harness['run']>[0], code: string) =>
  expect(h.run(c)).toMatchObject({ ok: false, error: { code } });
describe('work-item proposals and gate revisions', () => {
  test.each([
    [[item(), item()], 'duplicate_key'],
    [[{ ...item(), role: 'ghost' }], 'unknown_role'],
    [[item('w1', ['absent'])], 'unknown_dependency'],
    [[item('w1', ['w1'])], 'dependency_cycle'],
    [[item('w1', ['w2']), item('w2', ['w1'])], 'dependency_cycle'],
  ] as const)('invalid work-item graph %#', (items, code) => {
    expect(validateWorkItemDrafts(planning().state, [...items])).toMatchObject({
      code,
    });
  });
  test('forward refs and diamond dependencies are accepted', () => {
    expect(
      validateWorkItemDrafts(planning().state, [
        item('w1', ['w2', 'w3']),
        item('w2', ['w4']),
        item('w3', ['w4']),
        item('w4'),
      ]),
    ).toBeUndefined();
  });
  test('proposal, approval, default agent and idempotent approval', () => {
    const h = opened().given(decide, approve, approve);
    expect(h.state.workItems.w1).toMatchObject({
      status: 'approved',
      agent: 'codex',
      approvedGateId: 'g',
    });
    expect(h.events.filter((e) => e.type === 'workitem.approved')).toHaveLength(
      1,
    );
  });
  test('revise editable fields, add/delete items, then approve edited list', () => {
    const items = [{ ...item('new'), title: 'Changed' }];
    const h = opened().given(
      { ...decide, decision: 'revise', edits: { type: 'work-items', items } },
      { ...approve, items: items.map((i) => ({ ...i, agent: 'codex' })) },
    );
    expect(Object.keys(h.state.workItems)).toEqual(['new']);
  });
  test('revision refuses locked fields, malformed graph and mismatching edit type', () => {
    const h = opened();
    const config = h.state.workflow!.template.stages.find(
      (s) => s.kind === 'planning',
    )!;
    if (config.kind === 'planning') config.gate.editable = ['title'];
    error(
      h,
      {
        ...decide,
        decision: 'revise',
        edits: { type: 'work-items', items: [{ ...item(), body: 'changed' }] },
      },
      'field_not_editable',
    );
    h.given({
      ...decide,
      decision: 'revise',
      edits: { type: 'work-items', items: [{ ...item(), title: 'changed' }] },
    });
    error(
      opened(),
      {
        ...decide,
        decision: 'revise',
        edits: { type: 'work-items', items: [item('w1', ['w1'])] },
      },
      'dependency_cycle',
    );
    error(
      opened(),
      {
        ...decide,
        decision: 'revise',
        edits: {
          type: 'conclusion',
          conclusion: {
            summary: 'x',
            decisions: [],
            techDecisions: [],
            openQuestions: [],
          },
        },
      },
      'edits_required',
    );
  });
  test('reject missing, stale and mismatching proposals and unauthorized approvals', () => {
    const propose: ProposeWorkItems = {
      type: 'ProposeWorkItems',
      meta: meta(),
      stageId: 'breakdown',
      submissionId: 's',
      items: [item()],
    };
    error(new Harness(), propose, 'workflow_not_started');
    error(planning(), { ...propose, stageId: 'meeting' }, 'stage_not_planning');
    error(planning(), propose, 'invalid_proposal');
    error(proposal(), { ...propose, items: [] }, 'invalid_proposal');
    error(planning(), { ...propose, items: [item(), item()] }, 'duplicate_key');
    error(planning(), approve, 'gate_not_approved');
    error(opened(), approve, 'gate_not_approved');
    error(
      opened().given(decide),
      { ...approve, items: [] },
      'approval_mismatch',
    );
    const h = proposal();
    h.state.gates.g = {
      kind: 'exception',
      exceptionKind: 'anomaly',
      gateId: 'g',
      stageId: 'breakdown',
      title: 'g',
      content: { type: 'exception', summary: 's' },
      options: [],
      version: 1,
      status: 'open',
      openedAt: meta().occurredAt,
    };
    error(h, propose, 'gate_open');
  });
});
