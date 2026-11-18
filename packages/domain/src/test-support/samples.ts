import type { EventPayload, EventType } from '@ai-office/contracts/events';
import { HASH, SHA, at, repo, template } from './fixtures.js';

/** Ids a sample payload refers to; property tests draw them from small pools. */
export interface SampleIds {
  stageId: string;
  attemptId: string;
  gateId: string;
  itemKey: string;
  questionId: string;
  commandId: string;
  timerId: string;
  submissionId: string;
  artifactId: string;
  seatId: string;
  n: number;
}

export const DEFAULT_IDS: SampleIds = {
  stageId: 'meeting',
  attemptId: 'att-1',
  gateId: 'conclusion',
  itemKey: 'item-a',
  questionId: 'q-1',
  commandId: 'cmd-att-1',
  timerId: 't-1',
  submissionId: 'sub-1',
  artifactId: 'art-1',
  seatId: 'wf-1:pm',
  n: 1,
};

type Samples = { [T in EventType]: EventPayload<T> };

/** One schema-valid payload per event type (validated in evolve.test.ts). */
export const samplePayloads = (ids: SampleIds = DEFAULT_IDS): Samples => {
  const statement = {
    round: ids.n,
    position: 'p',
    arguments: [],
    concerns: [],
    readyToConclude: ids.n % 2 === 0,
  };
  const item = {
    key: ids.itemKey,
    title: 't',
    body: 'b',
    acceptance: [],
    role: 'engineer',
    deps: [],
  };
  return {
    'workflow.started': {
      templateSnapshot: template(),
      repo: repo(),
      requirement: 'r',
      shortId: 'ab12',
      integrationBranch: 'ai-office/ab12-r',
      roleOverrides: {},
      gateToggles: { conclusion: true, 'task-split': true },
      budgets: { stages: {}, hardLimitMultiplier: 2 },
      limits: { globalAgents: 10 },
      acknowledgedUnverifiedRuntime: false,
    },
    'workflow.paused': { reason: ids.n % 2 === 0 ? 'anomaly' : 'budget' },
    'workflow.resumed': { reason: ids.n % 2 === 0 ? 'anomaly' : 'budget' },
    'workflow.completed': { finalPr: ids.n, mergeCommitSha: SHA },
    'workflow.failed': { reason: 'other', stageId: ids.stageId },
    'workflow.cancel_requested': { by: 'user' },
    'workflow.cancelled': { reason: 'user' },
    'stage.started': {
      stageId: ids.stageId,
      kind: 'meeting',
      attempt: ids.n,
      mode: ids.n === 1 ? 'initial' : 'rerun',
      feedback: 'f',
      agentOverride: 'codex',
    },
    'stage.completed': { stageId: ids.stageId, attempt: ids.n },
    'stage.failed': {
      stageId: ids.stageId,
      attempt: ids.n,
      reason: 'timeout',
      detail: 'd',
    },
    'stage.rerun_requested': {
      stageId: ids.stageId,
      fromAttempt: ids.n,
      mode: 'rerun',
      by: 'user',
      gateId: ids.gateId,
      feedback: 'f',
      agentOverride: 'claude-code',
    },
    'gate.opened': {
      kind: 'stage',
      gateId: ids.gateId,
      stageId: ids.stageId,
      templateGateId: ids.gateId,
      stageKind: 'meeting',
      optional: true,
      title: 'g',
      options: [],
      content: {
        type: 'conclusion',
        artifactId: ids.artifactId,
        renderedHash: HASH,
      },
      version: 1,
    },
    'gate.content_updated':
      ids.n % 2 === 0
        ? {
            gateId: ids.gateId,
            source: 'github',
            version: ids.n + 1,
            bodyHash: HASH,
            githubUpdatedAt: at(1),
          }
        : {
            gateId: ids.gateId,
            source: 'agent',
            version: ids.n + 1,
            artifactId: ids.artifactId,
          },
    'gate.decided': {
      gateId: ids.gateId,
      decision: ids.n % 2 === 0 ? 'reject' : 'approve',
      by: 'user',
      version: 1,
    },
    'gate.closed': { gateId: ids.gateId, reason: 'merged' },
    'seat.spawned': {
      seatId: ids.seatId,
      attemptId: ids.attemptId,
      attempt: 1,
      stageId: ids.stageId,
      role: 'pm',
      agent: 'claude-code',
      purpose: 'participant',
      keepOpen: true,
      spawnCommandId: ids.commandId,
    },
    'seat.status': {
      attemptId: ids.attemptId,
      state:
        (
          ['working', 'waiting_input', 'idle', 'done', 'error', 'lost'] as const
        )[ids.n % 6] ?? 'working',
    },
    'seat.activity': {
      attemptId: ids.attemptId,
      activity: [
        {
          messageId: 'm',
          category: 'read',
          inputLen: 1,
          outputLen: 1,
          inputHash: 'h',
        },
      ],
    },
    'seat.degraded': { attemptId: ids.attemptId, reason: 'source_changed' },
    'seat.policy_violation': {
      attemptId: ids.attemptId,
      hits: [{ rule: 'gh-merge', severity: 'high', messageId: 'm' }],
    },
    'seat.exited': { attemptId: ids.attemptId, reason: 'done', expected: true },
    'seat.released': { attemptId: ids.attemptId, removeWorkspace: true },
    'agent.unmanaged': { dispatch: 'd-1' },
    'meeting.round_started': {
      stageId: ids.stageId,
      round: ids.n,
      attemptIds: [ids.attemptId],
    },
    'meeting.statement': {
      stageId: ids.stageId,
      attemptId: ids.attemptId,
      role: 'pm',
      artifactId: ids.artifactId,
      statement,
    },
    'meeting.round_completed': {
      stageId: ids.stageId,
      round: ids.n,
      statements: 1,
      absentAttemptIds: [],
      allReadyToConclude: false,
    },
    'meeting.concluded': {
      stageId: ids.stageId,
      rounds: ids.n,
      endedEarly: false,
      conclusionArtifactId: ids.artifactId,
    },
    'submission.accepted': {
      submissionId: ids.submissionId,
      attemptId: ids.attemptId,
      kind: 'statement',
      submission: { kind: 'statement', payload: statement },
      artifactId: ids.artifactId,
    },
    'submission.rejected': { reason: 'gate_open', attemptId: ids.attemptId },
    'message.question': {
      questionId: ids.questionId,
      attemptId: ids.attemptId,
      itemKey: ids.itemKey,
      body: 'q',
    },
    'message.forwarded': {
      questionId: ids.questionId,
      to: 'on-call',
      toAttemptId: ids.attemptId,
      retry: 0,
    },
    'message.answered': { questionId: ids.questionId, by: 'agent', body: 'a' },
    'message.escalated': {
      questionId: ids.questionId,
      reason: 'timeout',
      gateId: ids.gateId,
    },
    'message.nudge': {
      attemptId: ids.attemptId,
      reason: 'missing-submission',
      subject: 's',
      body: 'b',
    },
    'message.instruction': {
      seatId: ids.seatId,
      attemptId: ids.attemptId,
      subject: 's',
      body: 'b',
    },
    'ondemand.started': {
      stageId: ids.stageId,
      purpose: 'oncall',
      attemptId: ids.attemptId,
    },
    'ondemand.queue_changed': {
      stageId: ids.stageId,
      purpose: 'oncall',
      queue: [ids.questionId],
      current: ids.questionId,
    },
    'ondemand.stopped': {
      stageId: ids.stageId,
      purpose: 'oncall',
      attemptId: ids.attemptId,
      reason: 'queue_empty',
    },
    'workitem.proposed': {
      stageId: ids.stageId,
      submissionId: ids.submissionId,
      items: [item],
    },
    'workitem.approved': {
      gateId: ids.gateId,
      items: [{ ...item, agent: 'codex' }],
    },
    'workitem.dispatched': {
      itemKey: ids.itemKey,
      attemptId: ids.attemptId,
      attempt: ids.n,
      agent: 'codex',
      branch: `ai-office/ab12/${ids.itemKey}`,
      workspaceName: `aio-ab12-${ids.itemKey}`,
    },
    'workitem.status': {
      itemKey: ids.itemKey,
      status: 'pr_open',
      issue: ids.n,
      pr: ids.n,
      headSha: SHA,
      reason: 'r',
    },
    'workitem.merge_queued': {
      itemKey: ids.itemKey,
      attemptId: ids.attemptId,
      pr: ids.n,
      headSha: SHA,
    },
    'workitem.rework_requested': {
      itemKey: ids.itemKey,
      pr: ids.n,
      submissionId: ids.submissionId,
      attemptId: ids.attemptId,
      reasons: ['r'],
      rework: 1,
    },
    'workitem.merged': {
      itemKey: ids.itemKey,
      pr: ids.n,
      mergeCommitSha: SHA,
      commandId: ids.commandId,
    },
    'artifact.created':
      ids.n % 3 === 0
        ? {
            artifactId: ids.artifactId,
            kind: 'pr',
            number: ids.n,
            url: 'https://github.com/o/r/pull/1',
            purpose: 'final',
            head: 'h',
            base: 'b',
          }
        : ids.n % 3 === 1
          ? {
              artifactId: ids.artifactId,
              kind: 'issue',
              number: ids.n,
              url: 'https://github.com/o/r/issues/1',
              purpose: 'work-item',
              itemKey: ids.itemKey,
            }
          : {
              artifactId: ids.artifactId,
              kind: 'pr',
              number: ids.n,
              url: 'https://github.com/o/r/pull/2',
              purpose: 'worker',
              head: 'h',
              base: 'b',
              itemKey: ids.itemKey,
            },
    'pr.status': {
      pr: ids.n,
      state: 'open',
      base: 'b',
      head: 'h',
      headSha: SHA,
      mergeable: true,
    },
    'scm.issue_drift': {
      issue: ids.n,
      bodyHash: HASH,
      githubUpdatedAt: at(1),
      labels: [],
    },
    'anomaly.detected': { kind: 'early-merge', severity: 'high', summary: 's' },
    'usage.tokens': {
      attemptId: ids.attemptId,
      inputUncached: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      budgetTokens: 10 * ids.n,
    },
    'usage.turns': { attemptId: ids.attemptId, turns: ids.n },
    'budget.exceeded':
      ids.n % 3 === 0
        ? {
            scope: 'workflow',
            metric: 'tokens',
            used: 10,
            budget: 5,
            threshold: 5,
          }
        : ids.n % 3 === 1
          ? {
              scope: 'stage',
              stageId: ids.stageId,
              stageAttempt: 1,
              metric: 'tokens',
              used: 10,
              budget: 5,
              threshold: 5,
            }
          : {
              scope: 'item',
              stageId: ids.stageId,
              itemKey: ids.itemKey,
              attemptId: ids.attemptId,
              metric: 'turns',
              used: 10,
              budget: 5,
              threshold: 5,
            },
    'budget.hard_limit': {
      scope: 'workflow',
      metric: 'tokens',
      used: 10,
      budget: 5,
      threshold: 10,
    },
    'command.issued':
      ids.n % 2 === 0
        ? {
            commandId: ids.commandId,
            kind: 'runtime.stop',
            args: { agent: 'a' },
          }
        : {
            commandId: ids.commandId,
            orcaRequestId: '00000000-0000-4000-8000-000000000000',
            kind: 'runtime.spawnAgent',
            args: {
              session: 's',
              agent: 'claude-code',
              title: 't',
              specPath: '/spec',
              specSha256: HASH,
              workspace: {
                kind: 'existing-worktree',
                workspace: 'w',
                readOnly: true,
              },
              keepOpen: true,
            },
          },
    'command.succeeded':
      ids.n % 2 === 0
        ? { commandId: ids.commandId, kind: 'runtime.stop', result: {} }
        : {
            commandId: ids.commandId,
            kind: 'runtime.spawnAgent',
            result: { agent: 'agent-ref' },
          },
    'command.failed': {
      commandId: ids.commandId,
      kind: 'runtime.stop',
      error: {
        category: 'transient',
        code: 'x',
        message: 'm',
        retryable: true,
      },
      attempts: 3,
    },
    'command.reconciled': {
      commandId: ids.commandId,
      kind: 'runtime.stop',
      outcome: 'found',
    },
    'timer.scheduled': {
      timerId: ids.timerId,
      fireAt: at(60),
      payload: { purpose: 'stage-timeout', stageId: ids.stageId, attempt: 1 },
    },
    'timer.fired': { timerId: ids.timerId },
    'timer.cancelled': { timerId: ids.timerId, reason: 'r' },
    'repo.registered': repo(),
    'repo.updated': { repoId: 'repo-1', status: 'registered' },
    'health.changed': { component: 'runtime', status: 'healthy' },
    'runtime.identity_restored': { newShim: 'shim', runs: [] },
    'runtime.identity_hijacked': {
      run: 'r',
      coordinatorHandle: 'h',
      consumerGeneration: 1,
    },
    'error.recorded': { category: 'bug', code: 'c', message: 'm' },
  };
};
