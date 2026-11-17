import {
  EVENT_PAYLOAD_SCHEMAS,
  EVENT_TYPES,
} from '@ai-office/contracts/events';
import type {
  DomainEvent,
  DomainEventDraft,
  EventType,
} from '@ai-office/contracts/events';
import { describe, expect, test } from 'vitest';
import { evolveWithWarning, HANDLED_EVENT_TYPES, replay } from './evolve.js';
import { initialState } from './state/index.js';
import {
  eventDraft,
  Harness,
  spawn,
  startCommand,
  startStage,
  throughStage,
  toEvent,
} from './test-support/fixtures.js';
import { DEFAULT_IDS, samplePayloads } from './test-support/samples.js';
import type { SampleIds } from './test-support/samples.js';

const sample = <T extends EventType>(
  type: T,
  ids: Partial<SampleIds> = {},
  extra: Parameters<typeof eventDraft>[2] = {},
): DomainEventDraft =>
  eventDraft(
    type,
    samplePayloads({ ...DEFAULT_IDS, ...ids })[type] as never,
    extra,
  );

/** A started workflow in its meeting stage with attempt `att-1` (pm). */
const meeting = (): Harness =>
  new Harness().given(
    startCommand(),
    startStage('meeting'),
    spawn('att-1', 'pm'),
  );

const applyAll = (harness: Harness, ...drafts: DomainEventDraft[]): Harness => {
  harness.append(...drafts);
  return harness;
};

describe('coverage of the event catalogue', () => {
  test('evolve handles exactly the 66 contract event types', () => {
    expect(EVENT_TYPES).toHaveLength(66);
    expect([...HANDLED_EVENT_TYPES].sort()).toEqual([...EVENT_TYPES].sort());
  });

  test.each(EVENT_TYPES.map((type) => [type]))(
    'sample %s is schema-valid',
    (type) => {
      for (const n of [1, 2, 3])
        expect(() =>
          EVENT_PAYLOAD_SCHEMAS[type].parse(
            samplePayloads({ ...DEFAULT_IDS, n })[type],
          ),
        ).not.toThrow();
    },
  );
});

describe('envelope handling', () => {
  const started = (): Harness => new Harness().given(startCommand());

  test('malformed envelopes are skipped without consuming seq', () => {
    const state = initialState();
    for (const raw of [
      null,
      1,
      {},
      { type: 'x', seq: 'a', payload: {} },
      { type: 'workflow.paused', seq: 1, payload: 3 },
      { type: 'workflow.paused', seq: 1, payload: {}, workflowId: 5 },
    ]) {
      const result = evolveWithWarning(state, raw as unknown as DomainEvent);
      expect(result.state).toBe(state);
      expect(result.warning?.code).toBe('malformed_event');
    }
  });

  test('stale seq is skipped', () => {
    const harness = started();
    const result = evolveWithWarning(
      harness.state,
      harness.events[0] as DomainEvent,
    );
    expect(result.warning).toMatchObject({
      code: 'stale_seq',
      seq: 1,
      type: 'workflow.started',
    });
    expect(result.state).toBe(harness.state);
  });

  test('unknown types are consumed with a warning', () => {
    const harness = started();
    const event = {
      ...toEvent(sample('workflow.paused'), 2),
      type: 'workflow.exploded',
    };
    const result = evolveWithWarning(
      harness.state,
      event as unknown as DomainEvent,
    );
    expect(result.warning?.code).toBe('unknown_type');
    expect(result.state.lastSeq).toBe(2);
  });

  test('system events without workflow are no-ops; others warn', () => {
    const harness = started();
    applyAll(
      harness,
      ...(
        [
          'repo.registered',
          'repo.updated',
          'health.changed',
          'runtime.identity_restored',
          'runtime.identity_hijacked',
          'error.recorded',
        ] as const
      ).map((type) => sample(type, {}, { workflowId: null })),
    );
    expect(harness.warnings).toEqual([]);
    expect(harness.state.lastSeq).toBe(7);
    applyAll(harness, sample('workflow.paused', {}, { workflowId: null }));
    expect(harness.warnings.map((w) => w.code)).toEqual(['missing_workflow']);
  });

  test('system events with a workflow id leave state alone', () => {
    const harness = started();
    const before = harness.state;
    applyAll(harness, sample('error.recorded'), sample('message.instruction'));
    expect(harness.warnings).toEqual([]);
    expect({ ...harness.state, lastSeq: 0 }).toEqual({ ...before, lastSeq: 0 });
  });

  test('events before start, foreign events and duplicate starts are skipped', () => {
    const fresh = new Harness();
    applyAll(fresh, sample('workflow.paused'));
    expect(fresh.warnings.map((w) => w.code)).toEqual(['workflow_not_started']);
    const harness = started();
    applyAll(
      harness,
      sample('workflow.paused', {}, { workflowId: 'wf-2' }),
      sample('workflow.started'),
    );
    expect(harness.warnings.map((w) => w.code)).toEqual([
      'foreign_workflow',
      'duplicate_start',
    ]);
  });

  test('handler exceptions become warnings', () => {
    const harness = new Harness();
    const broken = {
      ...sample('workflow.started'),
      payload: { templateSnapshot: {} },
    };
    applyAll(harness, broken as DomainEventDraft);
    expect(harness.warnings.map((w) => w.code)).toEqual(['handler_error']);
    expect(harness.state.workflow).toBeNull();
    expect(harness.state.lastSeq).toBe(1);
  });

  test('replay folds and collects warnings', () => {
    const harness = started();
    const events = [
      ...harness.events,
      toEvent(sample('workflow.resumed'), 2),
      toEvent(sample('workflow.paused'), 3),
    ];
    const { state, warnings } = replay(events);
    expect(warnings.map((w) => w.code)).toEqual(['not_paused']);
    expect(state.workflow?.pausedReasons).toEqual(['budget']);
  });
});

describe('workflow and stage events', () => {
  test('lifecycle events update the workflow', () => {
    const harness = new Harness().given(startCommand());
    expect(harness.state.stageOrder).toEqual([
      'meeting',
      'breakdown',
      'implement',
      'integrate',
      'final-pr',
    ]);
    applyAll(
      harness,
      sample('workflow.paused'),
      sample('workflow.paused'),
      sample('workflow.cancel_requested'),
      sample('workflow.completed'),
    );
    expect(harness.state.workflow).toMatchObject({
      status: 'completed',
      finalPr: 1,
      mergeCommitSha: 'abcdef1',
      cancelRequested: true,
    });
    applyAll(
      harness,
      sample('workflow.failed'),
      sample('workflow.cancelled'),
      sample('workflow.cancel_requested'),
      sample('workflow.paused', { n: 2 }),
    );
    expect(harness.warnings.map((w) => w.code)).toEqual([
      'already_paused',
      'workflow_ended',
      'workflow_ended',
      'workflow_ended',
      'workflow_ended',
    ]);
  });

  test('completion without merge sha', () => {
    const harness = new Harness().given(startCommand());
    applyAll(harness, eventDraft('workflow.completed', { finalPr: 3 }));
    expect(harness.state.workflow).not.toHaveProperty('mergeCommitSha');
  });

  test('stage events check attempt order and status', () => {
    const harness = new Harness().given(startCommand());
    applyAll(
      harness,
      sample('stage.started', { n: 2 }),
      sample('stage.completed'),
      sample('stage.rerun_requested'),
      sample('stage.started', { stageId: 'ghost' }),
      sample('stage.started'),
      sample('stage.started', { n: 2 }),
      sample('stage.rerun_requested'),
      sample('stage.failed', { n: 2 }),
      sample('stage.failed'),
      sample('stage.completed'),
    );
    expect(harness.warnings.map((w) => w.code)).toEqual([
      'attempt_out_of_order',
      'stage_not_running',
      'rerun_not_applicable',
      'unknown_stage',
      'stage_running',
      'rerun_not_applicable',
      'stage_not_running',
      'stage_not_running',
    ]);
    expect(harness.state.stages.meeting).toMatchObject({
      status: 'failed',
      failure: { reason: 'timeout', detail: 'd' },
      feedback: 'f',
      agentOverride: 'codex',
    });
    expect(harness.state.meetings.meeting).toEqual({
      stageId: 'meeting',
      stageAttempt: 1,
      rounds: {},
    });
  });
});

describe('gate events', () => {
  test('open, update, decide, close', () => {
    const harness = new Harness().given(startCommand(), startStage('meeting'));
    applyAll(
      harness,
      sample('gate.content_updated'),
      sample('gate.opened', { stageId: 'ghost' }),
      sample('gate.opened'),
      sample('gate.opened'),
      sample('gate.content_updated', { n: 2 }),
      sample('gate.content_updated', { n: 1 }),
      sample('gate.content_updated', { n: 3 }),
      eventDraft('gate.content_updated', {
        gateId: 'conclusion',
        source: 'user',
        version: 9,
      }),
    );
    expect(harness.state.gates.conclusion).toMatchObject({
      status: 'open',
      version: 9,
      github: { bodyHash: 'a'.repeat(64) },
      contentArtifactId: 'art-1',
    });
    applyAll(
      harness,
      sample('gate.decided'),
      sample('gate.decided'),
      sample('gate.closed'),
      sample('gate.closed'),
    );
    expect(harness.state.gates.conclusion).toMatchObject({
      status: 'closed',
      closedReason: 'merged',
      decision: { decision: 'approve' },
    });
    expect(harness.warnings.map((w) => w.code)).toEqual([
      'gate_not_open',
      'unknown_stage',
      'duplicate_gate',
      'stale_gate_version',
      'gate_not_open',
      'gate_not_closable',
    ]);
    // The meeting was still running, so the decision does not finish it.
    expect(harness.state.stages.meeting?.status).toBe('running');
  });

  test('stage gate decisions finish the stage; rejects keep it waiting', () => {
    const approve = throughStage(new Harness(), 'meeting');
    expect(approve.state.stages.meeting?.status).toBe('done');
    const harness = new Harness().given(startCommand(), startStage('meeting'), {
      type: 'CompleteStage',
      meta: { occurredAt: '2026-11-17T00:00:00Z', source: 'engine' },
      stageId: 'meeting',
      attempt: 1,
    });
    applyAll(harness, sample('gate.opened'), sample('gate.decided', { n: 2 }));
    expect(harness.state.stages.meeting?.status).toBe('awaiting_gate');
    expect(harness.state.gates.conclusion?.status).toBe('rejected');
    applyAll(
      harness,
      eventDraft('gate.opened', {
        kind: 'exception',
        exceptionKind: 'stage-violation',
        gateId: 'exc',
        stageId: 'meeting',
        title: 'x',
        options: [{ optionId: 'rerun', label: 'Rerun' }],
        content: { type: 'exception', summary: 's' },
        version: 1,
      }),
      eventDraft('gate.decided', {
        gateId: 'exc',
        decision: 'option',
        optionId: 'rerun',
        by: 'user',
        version: 1,
      }),
    );
    expect(harness.state.stages.meeting?.status).toBe('awaiting_gate');
    expect(harness.state.gates.exc?.status).toBe('approved');
  });

  test('merged final PR closes the final-pr stage', () => {
    const harness = throughStage(new Harness(), 'integrate').given(
      startStage('final-pr'),
      {
        type: 'CompleteStage',
        meta: { occurredAt: '2026-11-17T00:00:00Z', source: 'engine' },
        stageId: 'final-pr',
        attempt: 1,
      },
    );
    applyAll(
      harness,
      sample('gate.opened', { gateId: 'final-pr', stageId: 'final-pr' }),
      sample('gate.closed', { gateId: 'final-pr' }),
    );
    expect(harness.state.stages['final-pr']?.status).toBe('done');
    applyAll(
      harness,
      sample('gate.opened', { gateId: 'g2' }),
      eventDraft('gate.closed', { gateId: 'g2', reason: 'cancelled' }),
    );
    expect(harness.state.gates.g2?.status).toBe('closed');
  });
});

describe('seat events', () => {
  test('spawn requires a known stage and unique attempt', () => {
    const harness = meeting();
    applyAll(
      harness,
      sample('seat.spawned'),
      sample('seat.spawned', { attemptId: 'att-9', stageId: 'ghost' }),
    );
    expect(harness.warnings.map((w) => w.code)).toEqual([
      'duplicate_attempt',
      'unknown_stage',
    ]);
  });

  test('status, activity, degrade, policy, exit, release', () => {
    const harness = meeting();
    applyAll(
      harness,
      sample('seat.status', { n: 2 }),
      sample('seat.status', { n: 2 }),
      sample('seat.status', { n: 4 }),
      sample('seat.status', { n: 1 }),
      sample('seat.activity'),
      sample('seat.degraded'),
      sample('seat.policy_violation'),
      sample('seat.status', { attemptId: 'ghost' }),
    );
    const attempt = harness.state.attempts['att-1'];
    expect(attempt).toMatchObject({
      state: 'error',
      degraded: true,
      lastActivityAt: '2026-11-17T00:00:00.000Z',
    });
    expect(attempt?.policyHits).toHaveLength(1);
    expect(attempt).not.toHaveProperty('waitingSince');
    expect(harness.warnings.map((w) => w.code)).toEqual([
      'invalid_attempt_transition',
      'unknown_attempt',
    ]);
    applyAll(
      harness,
      sample('seat.exited'),
      sample('seat.exited'),
      sample('seat.released'),
      sample('seat.released'),
      sample('seat.status'),
    );
    expect(harness.warnings.slice(2).map((w) => w.code)).toEqual([
      'already_exited',
      'already_released',
      'attempt_released',
    ]);
  });

  test('waiting_input falls back to occurredAt, then keeps the first time', () => {
    const harness = meeting();
    applyAll(harness, sample('seat.status', { n: 1 }));
    expect(harness.state.attempts['att-1']?.waitingSince).toBe(
      '2026-11-17T00:00:00.000Z',
    );
    applyAll(
      harness,
      eventDraft(
        'seat.status',
        { attemptId: 'att-1', state: 'waiting_input' },
        { second: 30 },
      ),
    );
    expect(harness.state.attempts['att-1']?.waitingSince).toBe(
      '2026-11-17T00:00:00.000Z',
    );
  });

  test('agent.unmanaged is recorded', () => {
    const harness = applyAll(
      meeting(),
      sample('agent.unmanaged'),
      sample('agent.unmanaged', {}, { workflowId: null }),
    );
    expect(harness.state.unmanagedAgents).toHaveLength(1);
  });

  test('spawn command success links the agent ref', () => {
    const harness = applyAll(
      meeting(),
      sample('command.issued', { commandId: 'cmd-att-1' }),
      sample('command.succeeded', { commandId: 'cmd-att-1' }),
    );
    expect(harness.state.attempts['att-1']?.agentRef).toBe('agent-ref');
    const other = applyAll(
      meeting(),
      sample('command.issued', { commandId: 'cmd-x' }),
      sample('command.succeeded', { commandId: 'cmd-x' }),
    );
    expect(other.state.attempts['att-1']?.agentRef).toBeUndefined();
  });
});

describe('meeting and submission events', () => {
  test('rounds, statements and conclusion', () => {
    const harness = meeting();
    applyAll(
      harness,
      sample('meeting.statement'),
      sample('meeting.round_started'),
      sample('meeting.round_started'),
      sample('meeting.statement'),
      sample('meeting.round_completed'),
      sample('meeting.round_completed'),
      sample('meeting.round_started', { stageId: 'breakdown' }),
      sample('meeting.concluded'),
      sample('meeting.concluded'),
    );
    expect(harness.state.meetings.meeting?.rounds['1']).toMatchObject({
      statements: { 'att-1': { artifactId: 'art-1', readyToConclude: false } },
      completed: { statements: 1, allReadyToConclude: false },
    });
    expect(harness.state.meetings.meeting?.concluded?.rounds).toBe(1);
    expect(harness.warnings.map((w) => w.code)).toEqual([
      'unknown_round',
      'duplicate_round',
      'round_not_open',
      'unknown_meeting',
      'meeting_not_open',
    ]);
  });

  test('submissions are indexed by attempt and kind', () => {
    const harness = meeting();
    applyAll(
      harness,
      sample('submission.accepted'),
      sample('submission.accepted'),
      sample('submission.accepted', {
        submissionId: 'sub-2',
        attemptId: 'ghost',
      }),
      eventDraft('submission.accepted', {
        submissionId: 'sub-3',
        attemptId: 'att-1',
        kind: 'agenda',
        submission: { kind: 'agenda', payload: { topics: [] } },
      }),
      sample('submission.rejected'),
    );
    expect(harness.state.attempts['att-1']?.submissions).toEqual({
      statement: 'sub-1',
      agenda: 'sub-3',
    });
    expect(harness.state.submissions['sub-3']).not.toHaveProperty('artifactId');
    expect(harness.state.rejectedSubmissions).toBe(1);
    expect(harness.warnings.map((w) => w.code)).toEqual([
      'duplicate_submission',
      'unknown_attempt',
    ]);
  });
});

describe('message and on-call events', () => {
  test('question lifecycle', () => {
    const harness = meeting();
    applyAll(
      harness,
      sample('message.forwarded'),
      sample('message.question'),
      sample('message.question'),
      sample('message.forwarded'),
      sample('message.escalated'),
      sample('message.escalated'),
      sample('message.forwarded'),
      sample('message.answered'),
      sample('message.answered'),
      sample('message.escalated'),
      eventDraft('message.question', {
        questionId: 'q-2',
        attemptId: 'att-1',
        body: 'b',
      }),
      sample('message.nudge'),
    );
    expect(harness.state.questions['q-1']).toMatchObject({
      status: 'answered',
      escalation: { reason: 'timeout' },
      forwarded: { to: 'on-call' },
    });
    expect(harness.state.questions['q-2']).not.toHaveProperty('itemKey');
    expect(harness.state.attempts['att-1']?.nudges).toEqual([
      { reason: 'missing-submission', subject: 's' },
    ]);
    expect(harness.warnings.map((w) => w.code)).toEqual([
      'question_not_forwardable',
      'duplicate_question',
      'question_not_escalatable',
      'question_not_forwardable',
      'question_not_open',
      'question_not_escalatable',
    ]);
  });

  test('on-demand queue (on-call purpose)', () => {
    const harness = meeting();
    applyAll(
      harness,
      sample('ondemand.queue_changed'),
      sample('ondemand.stopped', { attemptId: 'att-x' }),
      sample('ondemand.started'),
    );
    expect(harness.state.ondemand.meeting?.oncall).toEqual({
      stageId: 'meeting',
      attemptId: 'att-1',
      queue: ['q-1'],
      current: 'q-1',
    });
    applyAll(
      harness,
      sample('ondemand.queue_changed'),
      eventDraft('ondemand.queue_changed', {
        stageId: 'meeting',
        purpose: 'oncall',
        queue: [],
      }),
    );
    expect(harness.state.ondemand.meeting?.oncall).toEqual({
      stageId: 'meeting',
      attemptId: 'att-1',
      queue: [],
      deliveries: { 'q-1': { attemptId: 'att-1', retries: 0 } },
    });
    applyAll(
      harness,
      sample('ondemand.queue_changed'),
      sample('ondemand.stopped'),
    );
    expect(harness.state.ondemand.meeting?.oncall).toEqual({
      stageId: 'meeting',
      attemptId: 'att-1',
      queue: ['q-1'],
      stopped: 'queue_empty',
      deliveries: { 'q-1': { attemptId: 'att-1', retries: 0 } },
    });
    expect(harness.state.ondemand.meeting?.merge).toBeUndefined();
    expect(harness.warnings.map((w) => w.code)).toEqual([
      'ondemand_not_running',
    ]);
  });

  test('on-demand purposes keep separate instances per stage', () => {
    const harness = meeting();
    applyAll(
      harness,
      sample('ondemand.started'),
      eventDraft('ondemand.started', {
        stageId: 'meeting',
        purpose: 'merge',
        attemptId: 'att-m',
      }),
      eventDraft('ondemand.stopped', {
        stageId: 'meeting',
        purpose: 'merge',
        attemptId: 'att-1',
        reason: 'queue_empty',
      }),
    );
    expect(harness.state.ondemand.meeting).toEqual({
      oncall: { stageId: 'meeting', attemptId: 'att-1', queue: [] },
      merge: { stageId: 'meeting', attemptId: 'att-m', queue: [] },
    });
    expect(harness.warnings.map((w) => w.code)).toEqual([
      'ondemand_not_running',
    ]);
  });
});

describe('work item, artifact and SCM events', () => {
  test('proposal, approval, dispatch, status, artifacts', () => {
    const harness = meeting();
    applyAll(
      harness,
      sample('workitem.proposed'),
      sample('workitem.dispatched'),
      sample('workitem.status'),
      sample('workitem.approved'),
      sample('workitem.approved'),
      sample('workitem.dispatched', { n: 2 }),
      sample('workitem.dispatched'),
      sample('workitem.status'),
      eventDraft('workitem.status', { itemKey: 'item-a', status: 'merged' }),
      sample('artifact.created', { n: 1 }),
      sample('artifact.created', { n: 1 }),
      sample('artifact.created', { artifactId: 'art-2', n: 2 }),
      sample('artifact.created', { artifactId: 'art-3', n: 3 }),
      sample('artifact.created', {
        artifactId: 'art-4',
        n: 1,
        itemKey: 'ghost',
      }),
      eventDraft('artifact.created', {
        artifactId: 'art-5',
        kind: 'branch',
        name: 'ai-office/ab12-x',
        purpose: 'integration',
      }),
      sample('pr.status'),
      sample('scm.issue_drift'),
      sample('anomaly.detected'),
    );
    expect(harness.state.proposals.meeting?.items).toHaveLength(1);
    expect(harness.state.workItemOrder).toEqual(['item-a']);
    expect(harness.state.workItems['item-a']).toMatchObject({
      status: 'merged',
      attempt: 1,
      attemptIds: ['att-1'],
      branch: 'ai-office/ab12/item-a',
      issue: 1,
      pr: 2,
      headSha: 'abcdef1',
      statusReason: 'r',
    });
    expect(harness.state.workflow?.finalPr).toBe(3);
    expect(Object.keys(harness.state.artifacts)).toHaveLength(5);
    expect(harness.state.prs['1']?.state).toBe('open');
    expect(harness.state.issueDrift['1']?.labels).toEqual([]);
    expect(harness.state.anomalies).toHaveLength(1);
    expect(harness.warnings.map((w) => w.code)).toEqual([
      'unknown_item',
      'unknown_item',
      'already_approved',
      'attempt_out_of_order',
      'duplicate_artifact',
    ]);
  });
});

describe('usage, budget, command and timer events', () => {
  test('usage accumulates per attempt, stage attempt and workflow', () => {
    const harness = meeting();
    applyAll(
      harness,
      sample('usage.tokens'),
      sample('usage.tokens', { n: 2 }),
      sample('usage.turns', { n: 3 }),
      sample('usage.turns', { attemptId: 'ghost' }),
    );
    expect(harness.state.usage).toEqual({
      workflow: { tokens: 30, turns: 3 },
      stages: { 'meeting#1': { tokens: 30, turns: 3 } },
      attempts: { 'att-1': { tokens: 30, turns: 3 } },
    });
    expect(harness.warnings.map((w) => w.code)).toEqual(['unknown_attempt']);
  });

  test('budget alerts are deduplicated per scope and level', () => {
    const harness = meeting();
    applyAll(
      harness,
      sample('budget.exceeded', { n: 1 }),
      sample('budget.exceeded', { n: 1 }),
      sample('budget.exceeded', { n: 2 }),
      sample('budget.exceeded', { n: 3 }),
      sample('budget.hard_limit'),
      sample('budget.hard_limit'),
    );
    expect(Object.keys(harness.state.budgetAlerts).sort()).toEqual([
      'item|att-1|exceeded',
      'stage|meeting#1|exceeded',
      'workflow|exceeded',
      'workflow|hard_limit',
    ]);
    expect(harness.warnings.map((w) => w.code)).toEqual([
      'duplicate_budget_alert',
      'duplicate_budget_alert',
    ]);
  });

  test('command ledger', () => {
    const harness = meeting();
    applyAll(
      harness,
      sample('command.succeeded'),
      sample('command.failed'),
      sample('command.reconciled'),
      sample('command.issued', { n: 2 }, { attemptId: 'att-1' }),
      sample('command.issued', { n: 2 }),
      sample('command.succeeded', { n: 1 }),
      sample('command.failed'),
      sample('command.reconciled'),
      sample('command.succeeded', { n: 2 }),
    );
    expect(harness.state.commands['cmd-att-1']).toMatchObject({
      status: 'succeeded',
      attemptId: 'att-1',
      reconciled: 'found',
      failedAttempts: 3,
      result: { kind: 'runtime.stop' },
    });
    expect(harness.state.commands['cmd-att-1']).not.toHaveProperty('error');
    expect(harness.warnings.map((w) => w.code)).toEqual([
      'unknown_command',
      'unknown_command',
      'unknown_command',
      'duplicate_command',
      'unknown_command',
    ]);
  });

  test('timers are pending until fired or cancelled', () => {
    const harness = meeting();
    applyAll(
      harness,
      sample('timer.scheduled'),
      sample('timer.scheduled'),
      sample('timer.scheduled', { timerId: 't-2' }),
    );
    expect(Object.keys(harness.state.timers)).toEqual(['t-1', 't-2']);
    applyAll(
      harness,
      sample('timer.fired'),
      sample('timer.fired'),
      sample('timer.cancelled', { timerId: 't-2' }),
      sample('timer.cancelled', { timerId: 't-2' }),
    );
    expect(harness.state.timers).toEqual({});
    expect(harness.warnings.map((w) => w.code)).toEqual([
      'duplicate_timer',
      'unknown_timer',
      'unknown_timer',
    ]);
  });
});
