import { describe, expect, test } from 'vitest';
import type { DecideGate, OpenGate } from '../commands.js';
import {
  Harness,
  HASH,
  at,
  completeStage,
  eventDraft,
  meta,
  spawn,
  startCommand,
  startStage,
  throughStage,
} from '../test-support/fixtures.js';
import { EXCEPTION_OPTIONS } from './gate.js';

export const meetingGate = (overrides: Partial<OpenGate> = {}): OpenGate => ({
  type: 'OpenGate',
  meta: meta(),
  noLiveAttempts: true,
  gate: {
    kind: 'stage',
    gateId: 'g',
    stageId: 'meeting',
    stageKind: 'meeting',
    templateGateId: 'conclusion',
    optional: true,
    title: 'Conclusion',
    options: [],
    content: { type: 'conclusion', artifactId: 'a', renderedHash: HASH },
  },
  ...overrides,
});
const ready = () =>
  new Harness().given(
    startCommand(),
    startStage('meeting'),
    completeStage('meeting'),
  );
const opened = () => ready().given(meetingGate());
export const decision = (overrides: Partial<DecideGate> = {}): DecideGate => ({
  type: 'DecideGate',
  meta: meta(),
  gateId: 'g',
  expectedVersion: 1,
  decision: 'approve',
  by: 'user',
  requestedGithubBodyHash: HASH,
  currentGithubBodyHash: HASH,
  approvedSnapshot: {
    source: 'github',
    body: 'approved',
    bodyHash: HASH,
    structured: null,
    githubUpdatedAt: at(20),
  },
  ...overrides,
});
const error = (h: Harness, c: Parameters<Harness['run']>[0], code: string) =>
  expect(h.run(c)).toMatchObject({ ok: false, error: { code } });
const final = () =>
  throughStage(new Harness(), 'integrate').given(
    startStage('final-pr'),
    completeStage('final-pr'),
    {
      type: 'OpenGate',
      meta: meta(),
      noLiveAttempts: true,
      gate: {
        kind: 'stage',
        gateId: 'g',
        stageId: 'final-pr',
        stageKind: 'final-pr',
        templateGateId: 'final-pr',
        optional: false,
        title: 'Final',
        options: [],
        content: { type: 'final-pr', artifactId: 'a', pr: 7 },
      },
    },
  );
const exception = (
  exceptionKind: Extract<
    OpenGate['gate'],
    { kind: 'exception' }
  >['exceptionKind'],
  options: Extract<OpenGate['gate'], { kind: 'exception' }>['options'],
): OpenGate => ({
  type: 'OpenGate',
  meta: meta(),
  noLiveAttempts: false,
  gate: {
    kind: 'exception',
    gateId: 'g',
    stageId: 'meeting',
    exceptionKind,
    title: 'Exception',
    options,
    content: { type: 'exception', summary: 'problem' },
  },
});

describe('gate invariants', () => {
  test('disabled optional gate opens before automatic approval, after stage completion', () => {
    const h = new Harness().given(
      startCommand({ gateToggles: { conclusion: false } }),
      startStage('meeting'),
      completeStage('meeting'),
    );
    expect(h.state.stages.meeting?.status).toBe('awaiting_gate');
    h.given(meetingGate());
    expect(h.events.slice(-2).map((e) => e.type)).toEqual([
      'gate.opened',
      'gate.decided',
    ]);
    expect(h.state.gates.g?.status).toBe('approved');
    expect(h.state.stages.meeting?.status).toBe('done');
  });
  test('GitHub hash alone controls conflicts; latest timestamp is display only', () => {
    const h = opened().given(decision());
    expect(h.state.gates.g?.decision?.approvedSnapshot?.githubUpdatedAt).toBe(
      at(20),
    );
    error(
      opened(),
      decision({ currentGithubBodyHash: 'b'.repeat(64) }),
      'gate_content_changed',
    );
    const noHash = decision();
    delete noHash.requestedGithubBodyHash;
    error(opened(), noHash, 'gate_content_changed');
    const noSnapshot = decision();
    delete noSnapshot.approvedSnapshot;
    error(opened(), noSnapshot, 'snapshot_required');
    error(
      opened(),
      decision({
        approvedSnapshot: {
          source: 'github',
          body: '',
          bodyHash: 'b'.repeat(64),
          structured: null,
        },
      }),
      'snapshot_required',
    );
  });
  test.each(['agent', 'user', 'github'] as const)(
    '%s content increments version and rejects stale decision',
    (source) => {
      const h = opened();
      h.given({
        type: 'UpdateGateContent',
        meta: meta(),
        update:
          source === 'github'
            ? { gateId: 'g', source, bodyHash: HASH, githubUpdatedAt: at(8) }
            : { gateId: 'g', source, artifactId: 'new' },
      });
      expect(h.state.gates.g?.version).toBe(2);
      error(h, decision(), 'gate_version_conflict');
      h.given(decision({ expectedVersion: 2 }));
    },
  );
  test('rejection reruns twice, then fails workflow', () => {
    const h = opened();
    for (let i = 0; i < 3; i++) {
      h.given(
        decision({
          gateId: `g${i || ''}`,
          decision: 'reject',
          comment: 'try again',
        }),
      );
      if (i < 2)
        h.given(
          startStage('meeting'),
          completeStage('meeting', i + 2),
          meetingGate({ gate: { ...meetingGate().gate, gateId: `g${i + 1}` } }),
        );
    }
    expect(h.events.at(-1)).toMatchObject({
      type: 'workflow.failed',
      payload: { reason: 'max_reruns_exceeded' },
    });
    expect(h.state.workflow?.status).toBe('failed');
  });
  test('conclusion revision accepts explicit structured edits', () => {
    const h = opened().given(
      decision({
        decision: 'revise',
        edits: {
          type: 'conclusion',
          conclusion: {
            summary: 'new',
            decisions: [],
            techDecisions: [],
            openQuestions: [],
          },
        },
      }),
    );
    expect(h.state.gates.g?.status).toBe('revised');
    error(opened(), decision({ decision: 'revise' }), 'edits_required');
    error(
      opened(),
      decision({ edits: { type: 'work-items', items: [] } }),
      'unexpected_edits',
    );
  });
  test('opening checks state, template, duplicates and strict attempt clearance including lost', () => {
    error(new Harness(), meetingGate(), 'workflow_not_started');
    error(
      ready(),
      meetingGate({ gate: { ...meetingGate().gate, stageId: 'missing' } }),
      'unknown_stage',
    );
    error(opened(), meetingGate(), 'duplicate_gate');
    error(
      new Harness().given(startCommand(), startStage('meeting')),
      meetingGate(),
      'stage_not_complete',
    );
    error(
      ready(),
      meetingGate({
        gate: { ...meetingGate().gate, optional: false } as OpenGate['gate'],
      }),
      'invalid_stage_gate',
    );
    error(ready(), meetingGate({ noLiveAttempts: false }), 'live_attempts');
    const h = new Harness().given(
      startCommand(),
      startStage('meeting'),
      spawn('a', 'pm'),
      completeStage('meeting'),
    );
    error(h, meetingGate(), 'live_attempts');
    h.given({
      type: 'ObserveAttemptStatus',
      meta: meta(),
      attemptId: 'a',
      state: 'lost',
    });
    error(h, meetingGate(), 'live_attempts');
    h.given(
      {
        type: 'RecordAttemptExited',
        meta: meta(),
        attemptId: 'a',
        reason: 'gone',
        expected: true,
      },
      meetingGate(),
    );
    error(
      h,
      meetingGate({ gate: { ...meetingGate().gate, gateId: 'second' } }),
      'gate_open',
    );
    error(
      ready().given({ type: 'RequestCancel', meta: meta(), by: 'user' }),
      meetingGate(),
      'cancel_requested',
    );
  });
  test('unknown/decided gates, unsupported decisions and auto decisions', () => {
    error(ready(), decision(), 'unknown_gate');
    error(opened().given(decision()), decision(), 'gate_not_open');
    error(opened(), decision({ by: 'auto' }), 'auto_not_allowed');
    error(opened(), decision({ decision: 'answer' }), 'invalid_gate_decision');
    error(
      final(),
      {
        type: 'UpdateGateContent',
        meta: meta(),
        update: {
          gateId: 'g',
          source: 'github',
          bodyHash: HASH,
          githubUpdatedAt: at(2),
        },
      },
      'not_conclusion',
    );
  });
  test('final PR requests integration revision and cannot approve', () => {
    const h = final().given(decision({ decision: 'reject', comment: 'fix' }));
    expect(h.state.stages.integrate?.pendingRerun).toMatchObject({
      mode: 'revision',
      feedback: 'fix',
    });
    error(final(), decision(), 'invalid_gate_decision');
    const exhausted = final();
    exhausted.state.stages.integrate!.revisions = 2;
    error(
      exhausted,
      decision({ decision: 'reject' }),
      'max_revisions_exceeded',
    );
    exhausted.given(decision({ decision: 'option', optionId: 'keep-open' }));
    expect(exhausted.state.workflow?.status).toBe('running');
    const aborted = final().given(
      decision({ decision: 'option', optionId: 'abort' }),
    );
    expect(aborted.state.workflow?.cancelRequested).toBe(true);
  });
  test('a final PR closed on GitHub keeps the gate open with prClosedAt; only keep-open/abort (S9)', () => {
    const status = (state: 'open' | 'closed' | 'merged', second: number) =>
      eventDraft(
        'pr.status',
        {
          pr: 7,
          state,
          base: 'main',
          head: 'integration',
          headSha: 'abcdef1',
          mergeable: true,
        },
        { second },
      );
    const h = final();
    h.state.gates.g = {
      ...h.state.gates.g!,
      options: [
        { optionId: 'request-changes', label: 'Request changes' },
        { optionId: 'keep-open', label: 'Keep open' },
        { optionId: 'abort', label: 'Abort' },
      ],
    };
    h.given(status('closed', 40), status('closed', 50));
    const gate = h.state.gates.g!;
    expect(gate.status).toBe('open');
    expect(gate.content).toMatchObject({ prClosedAt: at(40) });
    expect(gate.options.map((o) => o.optionId)).toEqual(['keep-open', 'abort']);
    expect(h.state.prsClosedAt).toEqual({ '7': at(40) });
    expect(h.state.workflow?.status).toBe('running');
    error(h, decision({ decision: 'reject' }), 'invalid_gate_decision');
    // Reopened: the mark clears; merging still completes as usual.
    h.given(status('open', 60));
    expect(h.state.gates.g!.content).not.toHaveProperty('prClosedAt');
    expect(h.state.prsClosedAt).toEqual({});
    h.given(status('merged', 70), {
      type: 'CloseGate',
      meta: meta(),
      gateId: 'g',
      reason: 'merged',
    });
    expect(h.state.gates.g?.closedReason).toBe('merged');
    const keep = final().given(
      status('closed', 40),
      decision({ decision: 'option', optionId: 'keep-open' }),
    );
    expect(keep.state.gates.g?.status).toBe('approved');
  });
  test('merged closure requires observed final PR and works after keep-open', () => {
    const close = {
      type: 'CloseGate',
      meta: meta(),
      gateId: 'g',
      reason: 'merged',
    } as const;
    error(opened(), close, 'pr_not_merged');
    const h = final();
    error(h, close, 'pr_not_merged');
    h.given(
      decision({ decision: 'option', optionId: 'keep-open' }),
      eventDraft('pr.status', {
        pr: 7,
        state: 'merged',
        base: 'main',
        head: 'integration',
        headSha: 'abcdef1',
        mergeable: true,
      }),
      close,
      close,
    );
    expect(h.state.gates.g?.closedReason).toBe('merged');
    expect(h.state.stages['final-pr']?.status).toBe('done');
    opened().given({ ...close, reason: 'superseded' });
  });
  test.each(Object.entries(EXCEPTION_OPTIONS))(
    '%s permits its choices and resolves approved',
    (kind, ids) => {
      const options = ids.map((optionId) => ({
        optionId,
        label: optionId,
        ...(['top-up', 'top-up-rerun'].includes(optionId)
          ? { input: 'tokens' as const }
          : optionId === 'reassign'
            ? { input: 'agent' as const }
            : {}),
      }));
      for (const option of options) {
        const h = ready().given(
          exception(kind as keyof typeof EXCEPTION_OPTIONS, options),
          decision({
            decision: 'option',
            optionId: option.optionId,
            additionalTokens: 100,
            agent: 'codex',
          }),
        );
        expect(h.state.gates.g?.status).toBe('approved');
        expect(h.state.stages.meeting?.status).toBe('awaiting_gate');
      }
    },
  );
  test('exception options reject invalid sets and missing inputs', () => {
    for (const options of [
      [],
      [{ optionId: 'abort', label: 'a' }],
      [
        { optionId: 'abort', label: 'a' },
        { optionId: 'bad', label: 'b' },
      ],
      [
        { optionId: 'abort', label: 'a' },
        { optionId: 'abort', label: 'a' },
      ],
    ])
      error(ready(), exception('anomaly', options), 'invalid_options');
    error(
      ready(),
      exception('budget-exceeded', [
        { optionId: 'top-up', label: 'add' },
        { optionId: 'abort', label: 'abort' },
      ]),
      'invalid_options',
    );
    const budget = () =>
      ready().given(
        exception('budget-exceeded', [
          { optionId: 'top-up', label: 'add', input: 'tokens' },
          { optionId: 'abort', label: 'abort' },
        ]),
      );
    error(
      budget(),
      decision({ decision: 'option', optionId: 'top-up' }),
      'tokens_required',
    );
    error(
      budget(),
      decision({ decision: 'option', optionId: 'missing' }),
      'invalid_gate_decision',
    );
    const reassign = ready().given(
      exception('stage-violation', [
        { optionId: 'reassign', label: 'change', input: 'agent' },
        { optionId: 'abort', label: 'abort' },
      ]),
    );
    error(
      reassign,
      decision({ decision: 'option', optionId: 'reassign' }),
      'agent_required',
    );
  });
  test('decision-request options and question-escalation text-only routing', () => {
    const options = [
      { optionId: 'choice', label: 'Choice' },
      { optionId: 'abort', label: 'Abort' },
    ];
    ready().given(
      exception('decision-request', options),
      decision({ decision: 'option', optionId: 'choice' }),
    );
    error(ready(), exception('decision-request', []), 'invalid_options');
    error(ready(), exception('question-escalation', []), 'invalid_options');
    const q = exception('question-escalation', []);
    q.gate.content = {
      type: 'exception',
      summary: 'question',
      questionId: 'q',
    };
    error(
      ready().given(q),
      decision({ decision: 'answer' }),
      'answer_question_required',
    );
    const invalid = exception('anomaly', options);
    invalid.gate.content = { type: 'work-items', artifactId: 'a' };
    error(ready(), invalid, 'invalid_exception_gate');
  });
});
