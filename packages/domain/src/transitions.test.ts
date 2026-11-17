import { describe, expect } from 'vitest';
import type { DomainCommand } from './commands.js';
import {
  approveGate,
  completeStage,
  eventDraft,
  meta,
  observe,
  spawn,
  startCommand,
  startStage,
  template,
  throughStage,
} from './test-support/fixtures.js';
import type { Step } from './test-support/fixtures.js';
import { runTransitionRows } from './test-support/transitions.js';
import type { TransitionRow } from './test-support/transitions.js';

const started: Step[] = [startCommand()];
const inMeeting: Step[] = [...started, startStage('meeting')];
const withAttempt: Step[] = [...inMeeting, spawn('att-1', 'pm')];
const cmd = <T extends DomainCommand['type']>(
  type: T,
  fields: Omit<Extract<DomainCommand, { type: T }>, 'type' | 'meta'>,
): DomainCommand => ({ type, meta: meta(9), ...fields }) as DomainCommand;
const failRerun = (n: number): Step[] =>
  Array.from({ length: n }, (_, i) => [
    cmd('RequestStageRerun', { stageId: 'meeting', mode: 'rerun', by: 'user' }),
    startStage('meeting'),
    completeStage('meeting', i + 2),
  ]).flat();

const T6_ROWS: TransitionRow[] = [
  // workflow ----------------------------------------------------------------
  {
    name: 'start workflow',
    given: [],
    when: startCommand(),
    then: ['workflow.started'],
  },
  {
    name: 'start twice',
    given: started,
    when: startCommand(),
    then: { error: 'workflow_exists' },
  },
  {
    name: 'start with bad shortId',
    given: [],
    when: startCommand({ shortId: 'AB' }),
    then: { error: 'invalid_short_id' },
  },
  {
    name: 'start with blank requirement',
    given: [],
    when: startCommand({ requirement: '  ' }),
    then: { error: 'empty_requirement' },
  },
  {
    name: 'start with unknown role override',
    given: [],
    when: startCommand({ roleOverrides: { ghost: { agent: 'codex' } } }),
    then: { error: 'unknown_role' },
  },
  {
    name: 'start toggling a mandatory gate',
    given: [],
    when: startCommand({ gateToggles: { 'final-pr': false } }),
    then: { error: 'gate_not_optional' },
  },
  {
    name: 'start overriding budget of a budgetless stage',
    given: [],
    when: startCommand({
      budgetOverrides: { stages: { 'final-pr': { tokens: 1 } } },
    }),
    then: { error: 'unknown_budget_stage' },
  },
  {
    name: 'start with unsafe integration branch pattern',
    given: [],
    when: startCommand({
      template: {
        ...template(),
        defaults: {
          ...template().defaults,
          integrationBranch: 'feature/{slug}',
        },
      },
    }),
    then: { error: 'invalid_integration_branch' },
  },
  {
    name: 'pause',
    given: started,
    when: cmd('PauseWorkflow', { reason: 'anomaly' }),
    then: ['workflow.paused'],
  },
  {
    name: 'pause again for same reason',
    given: [...started, cmd('PauseWorkflow', { reason: 'anomaly' })],
    when: cmd('PauseWorkflow', { reason: 'anomaly' }),
    then: [],
  },
  {
    name: 'pause for a second reason',
    given: [...started, cmd('PauseWorkflow', { reason: 'anomaly' })],
    when: cmd('PauseWorkflow', { reason: 'budget', gateId: 'g', detail: 'd' }),
    then: ['workflow.paused'],
    check: (h) =>
      expect(h.state.workflow?.pausedReasons).toEqual(['anomaly', 'budget']),
  },
  {
    name: 'resume one reason',
    given: [
      ...started,
      cmd('PauseWorkflow', { reason: 'anomaly' }),
      cmd('PauseWorkflow', { reason: 'budget' }),
    ],
    when: cmd('ResumeWorkflow', { reason: 'anomaly' }),
    then: ['workflow.resumed'],
    check: (h) => expect(h.state.workflow?.pausedReasons).toEqual(['budget']),
  },
  {
    name: 'resume when not paused',
    given: started,
    when: cmd('ResumeWorkflow', { reason: 'anomaly' }),
    then: [],
  },
  {
    name: 'pause before start',
    given: [],
    when: cmd('PauseWorkflow', { reason: 'anomaly' }),
    then: { error: 'workflow_not_started' },
  },
  {
    name: 'request cancel',
    given: started,
    when: cmd('RequestCancel', { by: 'gate', gateId: 'g', reason: 'r' }),
    then: ['workflow.cancel_requested'],
    check: (h) => expect(h.state.workflow?.cancelRequested).toBe(true),
  },
  {
    name: 'request cancel twice',
    given: [...started, cmd('RequestCancel', { by: 'user' })],
    when: cmd('RequestCancel', { by: 'user' }),
    then: [],
  },
  {
    name: 'mark cancelled without request',
    given: started,
    when: cmd('MarkCancelled', {}),
    then: { error: 'cancel_not_requested' },
  },
  {
    name: 'mark cancelled',
    given: [...started, cmd('RequestCancel', { by: 'user' })],
    when: cmd('MarkCancelled', { reason: 'user' }),
    then: ['workflow.cancelled'],
    check: (h) => expect(h.state.workflow?.status).toBe('cancelled'),
  },
  {
    name: 'pause after cancellation',
    given: [
      ...started,
      cmd('RequestCancel', { by: 'user' }),
      cmd('MarkCancelled', {}),
    ],
    when: cmd('PauseWorkflow', { reason: 'anomaly' }),
    then: { error: 'workflow_ended' },
  },
  {
    name: 'complete before final-pr',
    given: started,
    when: cmd('CompleteWorkflow', { finalPr: 7 }),
    then: { error: 'final_pr_not_started' },
  },
  {
    name: 'complete after final-pr started',
    given: (h) => throughStage(h, 'integrate').given(startStage('final-pr')),
    when: cmd('CompleteWorkflow', { finalPr: 7, mergeCommitSha: 'abcdef1' }),
    then: ['workflow.completed'],
    check: (h) =>
      expect(h.state.workflow).toMatchObject({
        status: 'completed',
        finalPr: 7,
      }),
  },
  {
    name: 'fail',
    given: started,
    when: cmd('FailWorkflow', {
      reason: 'stage_failed',
      stageId: 'meeting',
      detail: 'd',
    }),
    then: ['workflow.failed'],
    check: (h) => expect(h.state.workflow?.status).toBe('failed'),
  },
  {
    name: 'fail naming unknown stage',
    given: started,
    when: cmd('FailWorkflow', { reason: 'other', stageId: 'ghost' }),
    then: { error: 'unknown_stage' },
  },

  // stage -------------------------------------------------------------------
  {
    name: 'start first stage',
    given: started,
    when: startStage('meeting'),
    then: ['stage.started'],
    check: (h) =>
      expect(h.state.stages.meeting).toMatchObject({
        status: 'running',
        attempt: 1,
        mode: 'initial',
      }),
  },
  {
    name: 'start unknown stage',
    given: started,
    when: startStage('ghost'),
    then: { error: 'unknown_stage' },
  },
  {
    name: 'start stage out of order',
    given: started,
    when: startStage('breakdown'),
    then: { error: 'previous_stage_incomplete' },
  },
  {
    name: 'start stage with undecided gate',
    given: [...inMeeting, completeStage('meeting')],
    when: startStage('breakdown'),
    then: { error: 'previous_stage_incomplete' },
  },
  {
    name: 'start next stage after gate approval',
    given: [
      ...inMeeting,
      completeStage('meeting'),
      ...approveGate('conclusion', 'meeting', 'meeting'),
    ],
    when: startStage('breakdown'),
    then: ['stage.started'],
  },
  {
    name: 'start while a stage runs',
    given: inMeeting,
    when: startStage('breakdown'),
    then: { error: 'stage_running' },
  },
  {
    name: 'start while paused',
    given: [...started, cmd('PauseWorkflow', { reason: 'scm_unhealthy' })],
    when: startStage('meeting'),
    then: { error: 'workflow_paused' },
  },
  {
    name: 'start while cancelling',
    given: [...started, cmd('RequestCancel', { by: 'user' })],
    when: startStage('meeting'),
    then: { error: 'cancel_requested' },
  },
  {
    name: 'start finished stage again without rerun',
    given: (h) => throughStage(h, 'meeting'),
    when: startStage('meeting'),
    then: { error: 'rerun_not_requested' },
  },
  {
    name: 'complete stage',
    given: inMeeting,
    when: completeStage('meeting'),
    then: ['stage.completed'],
    check: (h) => expect(h.state.stages.meeting?.status).toBe('awaiting_gate'),
  },
  {
    name: 'complete ungated stage goes done',
    given: (h) => throughStage(h, 'breakdown').given(startStage('implement')),
    when: completeStage('implement'),
    then: ['stage.completed'],
    check: (h) => expect(h.state.stages.implement?.status).toBe('done'),
  },
  {
    name: 'complete stale attempt',
    given: inMeeting,
    when: completeStage('meeting', 2),
    then: { error: 'stale_stage_attempt' },
  },
  {
    name: 'complete unknown stage',
    given: inMeeting,
    when: completeStage('ghost'),
    then: { error: 'unknown_stage' },
  },
  {
    name: 'fail stage',
    given: inMeeting,
    when: cmd('FailStage', {
      stageId: 'meeting',
      attempt: 1,
      reason: 'timeout',
      detail: 'd',
    }),
    then: ['stage.failed'],
    check: (h) =>
      expect(h.state.stages.meeting).toMatchObject({
        status: 'failed',
        failure: { reason: 'timeout' },
      }),
  },
  {
    name: 'fail stage while cancelling',
    given: [...inMeeting, cmd('RequestCancel', { by: 'user' })],
    when: cmd('FailStage', {
      stageId: 'meeting',
      attempt: 1,
      reason: 'cancelled',
    }),
    then: ['stage.failed'],
  },
  {
    name: 'request rerun at gate',
    given: [...inMeeting, completeStage('meeting')],
    when: cmd('RequestStageRerun', {
      stageId: 'meeting',
      mode: 'rerun',
      by: 'user',
      feedback: 'more risk',
      agentOverride: 'codex',
    }),
    then: ['stage.rerun_requested'],
  },
  {
    name: 'start rerun carries feedback',
    given: [
      ...inMeeting,
      completeStage('meeting'),
      cmd('RequestStageRerun', {
        stageId: 'meeting',
        mode: 'rerun',
        by: 'user',
        feedback: 'more risk',
        agentOverride: 'codex',
      }),
    ],
    when: startStage('meeting'),
    then: ['stage.started'],
    check: (h) =>
      expect(h.state.stages.meeting).toMatchObject({
        attempt: 2,
        mode: 'rerun',
        feedback: 'more risk',
        agentOverride: 'codex',
        reruns: 1,
        status: 'running',
      }),
  },
  {
    name: 'rerun a failed stage',
    given: [
      ...inMeeting,
      cmd('FailStage', {
        stageId: 'meeting',
        attempt: 1,
        reason: 'agent_failed',
      }),
    ],
    when: cmd('RequestStageRerun', {
      stageId: 'meeting',
      mode: 'rerun',
      by: 'auto',
    }),
    then: ['stage.rerun_requested'],
  },
  {
    name: 'rerun a running stage',
    given: inMeeting,
    when: cmd('RequestStageRerun', {
      stageId: 'meeting',
      mode: 'rerun',
      by: 'user',
    }),
    then: { error: 'stage_not_rerunnable' },
  },
  {
    name: 'rerun a stage that never ran',
    given: started,
    when: cmd('RequestStageRerun', {
      stageId: 'meeting',
      mode: 'rerun',
      by: 'user',
    }),
    then: { error: 'stage_not_rerunnable' },
  },
  {
    name: 'rerun an unknown stage',
    given: started,
    when: cmd('RequestStageRerun', {
      stageId: 'ghost',
      mode: 'rerun',
      by: 'user',
    }),
    then: { error: 'unknown_stage' },
  },
  {
    name: 'rerun twice before restart',
    given: [
      ...inMeeting,
      completeStage('meeting'),
      cmd('RequestStageRerun', {
        stageId: 'meeting',
        mode: 'rerun',
        by: 'user',
      }),
    ],
    when: cmd('RequestStageRerun', {
      stageId: 'meeting',
      mode: 'rerun',
      by: 'user',
    }),
    then: { error: 'rerun_already_requested' },
  },
  {
    name: 'rerun past maxReruns',
    given: [...inMeeting, completeStage('meeting'), ...failRerun(2)],
    when: cmd('RequestStageRerun', {
      stageId: 'meeting',
      mode: 'rerun',
      by: 'user',
    }),
    then: { error: 'max_reruns_exceeded' },
  },
  {
    name: 'rerun with unknown gate',
    given: [...inMeeting, completeStage('meeting')],
    when: cmd('RequestStageRerun', {
      stageId: 'meeting',
      mode: 'rerun',
      by: 'user',
      gateId: 'ghost',
    }),
    then: { error: 'unknown_gate' },
  },
  {
    name: 'rerun while cancelling',
    given: [
      ...inMeeting,
      completeStage('meeting'),
      cmd('RequestCancel', { by: 'user' }),
    ],
    when: cmd('RequestStageRerun', {
      stageId: 'meeting',
      mode: 'rerun',
      by: 'user',
    }),
    then: { error: 'cancel_requested' },
  },
  {
    name: 'rerun final-pr',
    given: (h) =>
      throughStage(h, 'integrate').given(
        startStage('final-pr'),
        completeStage('final-pr'),
      ),
    when: cmd('RequestStageRerun', {
      stageId: 'final-pr',
      mode: 'rerun',
      by: 'user',
    }),
    then: { error: 'not_rerunnable' },
  },
  {
    name: 'revision of a meeting',
    given: [...inMeeting, completeStage('meeting')],
    when: cmd('RequestStageRerun', {
      stageId: 'meeting',
      mode: 'revision',
      by: 'user',
    }),
    then: { error: 'revision_not_supported' },
  },
  {
    name: 'revision of integrate',
    given: (h) =>
      throughStage(h, 'integrate').given(
        startStage('final-pr'),
        completeStage('final-pr'),
      ),
    when: cmd('RequestStageRerun', {
      stageId: 'integrate',
      mode: 'revision',
      by: 'user',
      feedback: 'fix',
    }),
    then: ['stage.rerun_requested'],
  },
  {
    name: 'revision past maxRevisions',
    given: (h) => {
      throughStage(h, 'integrate');
      for (let n = 2; n <= 3; n += 1)
        h.given(
          cmd('RequestStageRerun', {
            stageId: 'integrate',
            mode: 'revision',
            by: 'user',
          }),
          startStage('integrate'),
          completeStage('integrate', n),
        );
      return h;
    },
    when: cmd('RequestStageRerun', {
      stageId: 'integrate',
      mode: 'revision',
      by: 'user',
    }),
    then: { error: 'max_revisions_exceeded' },
    check: (h) => expect(h.state.stages.integrate?.revisions).toBe(2),
  },

  // seat / attempt ------------------------------------------------------------
  {
    name: 'spawn attempt',
    given: inMeeting,
    when: spawn('att-1', 'lead', 'meeting', { purpose: 'facilitator' }),
    then: ['seat.spawned'],
    check: (h) =>
      expect(h.state.attempts['att-1']).toMatchObject({
        seatId: 'wf-1:lead',
        attempt: 1,
        agent: 'claude-code',
        effort: 'high',
        state: 'starting',
        stageAttempt: 1,
      }),
  },
  {
    name: 'spawn honours role override',
    given: [
      startCommand({
        roleOverrides: { pm: { agent: 'codex', effort: 'low' } },
      }),
      startStage('meeting'),
    ],
    when: spawn('att-1', 'pm'),
    then: ['seat.spawned'],
    check: (h) =>
      expect(h.state.attempts['att-1']).toMatchObject({
        agent: 'codex',
        effort: 'low',
      }),
  },
  {
    name: 'spawn outside a running stage',
    given: started,
    when: spawn('att-1', 'pm'),
    then: { error: 'stage_not_running' },
  },
  {
    name: 'spawn in unknown stage',
    given: inMeeting,
    when: spawn('att-1', 'pm', 'ghost'),
    then: { error: 'unknown_stage' },
  },
  {
    name: 'spawn unknown role',
    given: inMeeting,
    when: spawn('att-1', 'ghost'),
    then: { error: 'unknown_role' },
  },
  {
    name: 'spawn duplicate attempt id',
    given: withAttempt,
    when: spawn('att-1', 'architect'),
    then: { error: 'duplicate_attempt' },
  },
  {
    name: 'spawn worker without item',
    given: inMeeting,
    when: spawn('att-1', 'engineer', 'meeting', { purpose: 'worker' }),
    then: { error: 'item_key_mismatch' },
  },
  {
    name: 'spawn worker for unknown item',
    given: inMeeting,
    when: spawn('att-1', 'engineer', 'meeting', {
      purpose: 'worker',
      itemKey: 'ghost',
    }),
    then: { error: 'unknown_item' },
  },
  {
    name: 'spawn worker for approved item',
    given: (h) =>
      throughStage(h, 'breakdown').given(
        eventDraft('workitem.approved', {
          gateId: 'task-split',
          items: [
            {
              key: 'item-a',
              title: 't',
              body: 'b',
              acceptance: [],
              role: 'engineer',
              deps: [],
              agent: 'claude-code',
            },
          ],
        }),
        startStage('implement'),
      ),
    when: spawn('att-w', 'engineer', 'implement', {
      purpose: 'worker',
      itemKey: 'item-a',
      agent: 'claude-code',
      keepOpen: false,
    }),
    then: ['seat.spawned'],
    check: (h) =>
      expect(h.state.seats['wf-1:engineer:item-a']?.attemptIds).toEqual([
        'att-w',
      ]),
  },
  {
    name: 'spawn onto occupied seat',
    given: withAttempt,
    when: spawn('att-2', 'pm'),
    then: { error: 'seat_occupied' },
  },
  {
    name: 'spawn retry after exit',
    given: [
      ...withAttempt,
      cmd('RecordAttemptExited', {
        attemptId: 'att-1',
        reason: 'crash',
        expected: false,
      }),
    ],
    when: spawn('att-2', 'pm', 'meeting', { retryOf: 'att-1' }),
    then: ['seat.spawned'],
    check: (h) =>
      expect(h.state.attempts['att-2']).toMatchObject({
        attempt: 2,
        retryOf: 'att-1',
      }),
  },
  {
    name: 'spawn retry of foreign attempt',
    given: withAttempt,
    when: spawn('att-2', 'architect', 'meeting', { retryOf: 'att-1' }),
    then: { error: 'unknown_retry_of' },
  },
  {
    name: 'spawn on-call on the shared lead seat',
    given: (h) => throughStage(h, 'breakdown').given(startStage('implement')),
    when: spawn('att-oc', 'lead', 'implement', { purpose: 'oncall' }),
    then: ['seat.spawned'],
    check: (h) =>
      expect(h.state.attempts['att-oc']).toMatchObject({
        seatId: 'wf-1:lead',
        ondemand: { purpose: 'oncall' },
      }),
  },
  {
    name: 'spawn while paused',
    given: [
      ...inMeeting,
      cmd('PauseWorkflow', { reason: 'runtime_unhealthy' }),
    ],
    when: spawn('att-1', 'pm'),
    then: { error: 'workflow_paused' },
  },
  {
    name: 'observe working',
    given: withAttempt,
    when: observe('att-1', 'working'),
    then: ['seat.status'],
    check: (h) => expect(h.state.attempts['att-1']?.state).toBe('working'),
  },
  {
    name: 'observe waiting_input records since',
    given: withAttempt,
    when: cmd('ObserveAttemptStatus', {
      attemptId: 'att-1',
      state: 'waiting_input',
      waitingSince: '2026-11-17T00:00:05.000Z',
    }),
    then: ['seat.status'],
    check: (h) =>
      expect(h.state.attempts['att-1']?.waitingSince).toBe(
        '2026-11-17T00:00:05.000Z',
      ),
  },
  {
    name: 'observe same state',
    given: [...withAttempt, observe('att-1', 'working')],
    when: observe('att-1', 'working'),
    then: [],
  },
  {
    name: 'observe keep-open agent back to work',
    given: [...withAttempt, observe('att-1', 'done')],
    when: observe('att-1', 'working'),
    then: ['seat.status'],
  },
  {
    name: 'observe lost then exited',
    given: [...withAttempt, observe('att-1', 'lost')],
    when: cmd('RecordAttemptExited', {
      attemptId: 'att-1',
      reason: 'gone',
      expected: false,
    }),
    then: ['seat.exited'],
  },
  {
    name: 'observe illegal transition',
    given: [...withAttempt, observe('att-1', 'error')],
    when: observe('att-1', 'working'),
    then: { error: 'invalid_attempt_transition' },
  },
  {
    name: 'observe released attempt',
    given: [
      ...withAttempt,
      cmd('ReleaseAttempt', { attemptId: 'att-1', removeWorkspace: false }),
    ],
    when: observe('att-1', 'working'),
    then: [],
  },
  {
    name: 'observe unknown attempt',
    given: withAttempt,
    when: observe('ghost', 'working'),
    then: { error: 'unknown_attempt' },
  },
  {
    name: 'observe before start',
    given: [],
    when: observe('att-1', 'working'),
    then: { error: 'workflow_not_started' },
  },
  {
    name: 'observe after workflow ended',
    given: [...withAttempt, cmd('FailWorkflow', { reason: 'other' })],
    when: cmd('RecordAttemptExited', {
      attemptId: 'att-1',
      reason: 'stopped',
      expected: true,
    }),
    then: ['seat.exited'],
  },
  {
    name: 'record activity',
    given: withAttempt,
    when: cmd('RecordAttemptActivity', {
      attemptId: 'att-1',
      activity: [
        {
          messageId: 'm',
          category: 'edit',
          inputLen: 1,
          outputLen: 2,
          inputHash: 'h',
        },
      ],
    }),
    then: ['seat.activity'],
  },
  {
    name: 'record empty activity',
    given: withAttempt,
    when: cmd('RecordAttemptActivity', { attemptId: 'att-1', activity: [] }),
    then: [],
  },
  {
    name: 'mark degraded',
    given: withAttempt,
    when: cmd('MarkAttemptDegraded', {
      attemptId: 'att-1',
      reason: 'no_transcript_source',
    }),
    then: ['seat.degraded'],
    check: (h) => expect(h.state.attempts['att-1']?.degraded).toBe(true),
  },
  {
    name: 'mark degraded twice',
    given: [
      ...withAttempt,
      cmd('MarkAttemptDegraded', {
        attemptId: 'att-1',
        reason: 'source_changed',
      }),
    ],
    when: cmd('MarkAttemptDegraded', {
      attemptId: 'att-1',
      reason: 'source_changed',
    }),
    then: [],
  },
  {
    name: 'record policy violation',
    given: withAttempt,
    when: cmd('RecordPolicyViolation', {
      attemptId: 'att-1',
      hits: [{ rule: 'gh-merge', severity: 'high', messageId: 'm' }],
    }),
    then: ['seat.policy_violation'],
    check: (h) => expect(h.state.attempts['att-1']?.policyHits).toHaveLength(1),
  },
  {
    name: 'record no policy hits',
    given: withAttempt,
    when: cmd('RecordPolicyViolation', { attemptId: 'att-1', hits: [] }),
    then: [],
  },
  {
    name: 'record exit',
    given: withAttempt,
    when: cmd('RecordAttemptExited', {
      attemptId: 'att-1',
      reason: 'worker_done',
      expected: true,
    }),
    then: ['seat.exited'],
    check: (h) =>
      expect(h.state.attempts['att-1']).toMatchObject({
        state: 'exited',
        exit: { expected: true },
      }),
  },
  {
    name: 'record exit twice',
    given: [
      ...withAttempt,
      cmd('RecordAttemptExited', {
        attemptId: 'att-1',
        reason: 'r',
        expected: true,
      }),
    ],
    when: cmd('RecordAttemptExited', {
      attemptId: 'att-1',
      reason: 'r',
      expected: true,
    }),
    then: [],
  },
  {
    name: 'release',
    given: withAttempt,
    when: cmd('ReleaseAttempt', { attemptId: 'att-1', removeWorkspace: true }),
    then: ['seat.released'],
    check: (h) =>
      expect(h.state.attempts['att-1']).toMatchObject({
        released: true,
        removeWorkspace: true,
      }),
  },
  {
    name: 'release twice',
    given: [
      ...withAttempt,
      cmd('ReleaseAttempt', { attemptId: 'att-1', removeWorkspace: true }),
    ],
    when: cmd('ReleaseAttempt', { attemptId: 'att-1', removeWorkspace: true }),
    then: [],
  },
];

// T9 / T10 add their own `describe` blocks with rows in the same shape.
describe('M1-T6 transitions', () => {
  runTransitionRows(T6_ROWS);
});

const t9Open: DomainCommand = {
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
    content: {
      type: 'conclusion',
      artifactId: 'a',
      renderedHash: 'a'.repeat(64),
    },
  },
};
const t9Ready: Step[] = [...inMeeting, completeStage('meeting')];
const t9Decision: DomainCommand = {
  type: 'DecideGate',
  meta: meta(),
  gateId: 'g',
  expectedVersion: 1,
  by: 'user',
  decision: 'reject',
  comment: 'try again',
};
describe('M1-T9 transitions', () => {
  runTransitionRows([
    {
      name: 'completed stage opens gate',
      given: t9Ready,
      when: t9Open,
      then: ['gate.opened'],
    },
    {
      name: 'disabled optional gate opens then auto approves',
      given: [
        startCommand({ gateToggles: { conclusion: false } }),
        startStage('meeting'),
        completeStage('meeting'),
      ],
      when: t9Open,
      then: ['gate.opened', 'gate.decided'],
    },
    {
      name: 'reject requests stage rerun',
      given: [...t9Ready, t9Open],
      when: t9Decision,
      then: ['gate.decided', 'stage.rerun_requested'],
    },
    {
      name: 'reject over max reruns fails workflow',
      given: [
        startCommand({
          template: {
            ...template(),
            defaults: { ...template().defaults, maxReruns: 0 },
          },
        }),
        startStage('meeting'),
        completeStage('meeting'),
        t9Open,
      ],
      when: t9Decision,
      then: ['gate.decided', 'workflow.failed'],
    },
    {
      name: 'content update bumps version',
      given: [...t9Ready, t9Open],
      when: {
        type: 'UpdateGateContent',
        meta: meta(),
        update: { gateId: 'g', source: 'user', artifactId: 'new' },
      },
      then: ['gate.content_updated'],
      check: (h) => expect(h.state.gates.g?.version).toBe(2),
    },
    {
      name: 'close superseded gate',
      given: [...t9Ready, t9Open],
      when: {
        type: 'CloseGate',
        meta: meta(),
        gateId: 'g',
        reason: 'superseded',
      },
      then: ['gate.closed'],
    },
    {
      name: 'participant statement accepted',
      given: withAttempt,
      when: {
        type: 'AcceptSubmission',
        meta: meta(),
        attemptId: 'att-1',
        submissionId: 's',
        submission: {
          kind: 'statement',
          payload: {
            round: 1,
            position: 'yes',
            arguments: [],
            concerns: [],
            readyToConclude: true,
          },
        },
      },
      then: ['submission.accepted'],
    },
    {
      name: 'rejection recorded',
      given: withAttempt,
      when: {
        type: 'RejectSubmission',
        meta: meta(),
        rejection: { reason: 'not_allowed' },
      },
      then: ['submission.rejected'],
    },
  ]);
});
