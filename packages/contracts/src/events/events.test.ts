import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  AgentSubmissionSchema as SubmissionFromAgentPath,
  exitCodeForHttpStatus,
  RuntimeInfoSchema,
  SubmissionResponseSchema,
} from '../agent-submission/index.js';
import {
  AgentSubmissionSchema,
  CommandIssuedPayloadSchema,
  CommandResultSchema,
  CURRENT_SCHEMA_VERSION,
  DomainEventSchema,
  EVENT_PAYLOAD_SCHEMAS,
  ErrorCategorySchema,
  EVENT_TYPES,
  EXTERNAL_COMMAND_KINDS,
  ExceptionKindSchema,
  ExternalCommandSchema,
  ORCA_REQUEST_ID_KINDS,
  seatIdFor,
  SubmissionAcceptedPayloadSchema,
  TimerPayloadSchema,
  WorkItemStatusSchema,
  type DomainEventDraft,
  type EventPayload,
  type EventType,
  type ExternalCommandKind,
} from './index.js';

// Fixtures: one valid and one invalid example per event type and command kind.
const sha = 'a'.repeat(40);
const hash = 'b'.repeat(64);
const at = '2026-11-17T00:00:00Z';
const repo = { owner: 'octo', name: 'demo' };
const conclusion = {
  summary: 'Build it',
  decisions: [{ title: 'Scope', rationale: 'Small' }],
  techDecisions: [
    { topic: 'DB', options: ['sqlite'], chosen: 'sqlite', rationale: 'Local' },
  ],
  openQuestions: [],
};
const draft = {
  key: 'w1',
  title: 'Build',
  body: 'Do it',
  acceptance: ['tests pass'],
  role: 'engineer',
  deps: [],
};
const repoSnapshot = {
  repoId: 'r1',
  localPath: '/repo',
  orcaRepoId: 'orca-1',
  github: repo,
  defaultBranch: 'main',
  visibility: 'public',
  ownerLogin: 'octo',
  defaultBranchProtected: 'unknown',
};
const template = {
  apiVersion: 'ai-office/v1alpha1',
  id: 'flow',
  name: 'Flow',
  roles: {
    lead: { agent: 'claude-code' },
    engineer: { agent: 'codex' },
  },
  defaults: {
    integrationBranch: 'ai-office/{shortId}-{slug}',
    maxReruns: 2,
    budget: { hardLimitMultiplier: 2 },
  },
  stages: [
    {
      id: 'meeting',
      kind: 'meeting',
      facilitator: 'lead',
      participants: ['engineer'],
      maxRounds: 2,
      timeouts: { roundMin: 15, stageMin: 60 },
      budget: { tokens: 1000 },
      conclusion: { requireTechDecisions: true },
      gate: { id: 'conclusion', title: 'Conclusion' },
    },
    {
      id: 'planning',
      kind: 'planning',
      owner: 'lead',
      from: 'meeting',
      timeouts: { stageMin: 30 },
      budget: { tokens: 1000 },
      gate: { id: 'plan', title: 'Plan' },
    },
    {
      id: 'implement',
      kind: 'implement',
      role: 'engineer',
      from: 'planning',
      maxParallel: 2,
      timeouts: { itemMin: 45 },
      budget: { tokens: 1000, perItem: { tokens: 100 } },
      onCall: { role: 'lead', questionTimeoutMin: 10 },
      mergeQueue: { role: 'lead', reviewTimeoutMin: 20 },
      escalateOn: ['unresolvable-conflict'],
    },
    {
      id: 'integrate',
      kind: 'integrate',
      owner: 'lead',
      timeouts: { stageMin: 60 },
      budget: { tokens: 1000 },
    },
    {
      id: 'final-pr',
      kind: 'final-pr',
      maxRevisions: 2,
      gate: { id: 'final-pr', title: 'Final PR' },
    },
  ],
};

const commandExamples: Record<ExternalCommandKind, unknown> = {
  'runtime.openSession': {
    repo: { orcaRepoId: 'orca-1', localPath: '/repo' },
    objective: 'Build aio:c1',
  },
  'runtime.prepareWorkspace': {
    session: 's1',
    repo: { orcaRepoId: 'orca-1', localPath: '/repo' },
    baseBranch: 'origin/ai-office/abcd1234-demo',
    name: 'aio-abcd1234-w1',
    branch: 'ai-office/abcd1234/w1',
  },
  'runtime.disposeWorkspace': { workspace: 'ws1' },
  'runtime.inspectWorkspace': { workspace: 'ws1' },
  'runtime.spawnAgent': {
    session: 's1',
    agent: 'codex',
    effort: 'high',
    title: 'aio:c1 Build w1',
    specPath: '/data/specs/a1.md',
    specSha256: hash,
    workspace: {
      kind: 'existing-worktree',
      workspace: 'ws1',
      readOnly: true,
    },
    keepOpen: true,
  },
  'runtime.send': { agent: 'ag1', subject: 'Round 2', body: 'Go' },
  'runtime.answer': { question: 'msg1', body: 'Use sqlite' },
  'runtime.stop': { agent: 'ag1' },
  'runtime.release': { agent: 'ag1', removeWorkspace: false },
  'scm.ensureLabels': {
    repo,
    labels: [{ name: 'ai-office:pending', color: 'ededed' }],
  },
  'scm.ensureBranch': {
    repo,
    name: 'ai-office/abcd1234-demo',
    from: 'main',
  },
  'scm.deleteBranch': { repo, name: 'ai-office/abcd1234/w1' },
  'scm.createIssue': {
    repo,
    title: 'Conclusion',
    body: '<!-- ai-office:cmd=c1 -->',
    labels: ['ai-office:conclusion'],
  },
  'scm.updateIssue': {
    issue: { repo, number: 1 },
    patch: { body: 'edited' },
  },
  'scm.comment': {
    target: { repo, number: 1, type: 'issue' },
    body: 'AI Office 決策：approve',
  },
  'scm.setLabels': {
    target: { repo, number: 2, type: 'pr' },
    labels: ['ai-office:cancelled'],
  },
  'scm.openPR': {
    repo,
    title: 'w1',
    body: 'Refs #3',
    head: 'ai-office/abcd1234/w1',
    base: 'ai-office/abcd1234-demo',
  },
  'scm.updatePR': {
    pr: { repo, number: 4 },
    patch: { state: 'closed' },
  },
  'scm.compareBranch': {
    repo,
    base: 'ai-office/integration',
    head: 'ai-office/worker',
  },
  'scm.mergePR': {
    pr: { repo, number: 4 },
    method: 'merge',
    expectedHeadSha: sha,
  },
};

const exception = {
  gateId: 'g2',
  stageId: 'implement',
  kind: 'exception',
  exceptionKind: 'workitem-failed',
  title: 'w1 failed',
  options: [
    { optionId: 'retry', label: 'Retry' },
    { optionId: 'reassign', label: 'Reassign', input: 'agent' },
  ],
  content: { type: 'exception', summary: 'Exited', itemKey: 'w1' },
  version: 1,
};

/** One valid and one invalid payload per event type. */
const payloadExamples: Record<EventType, { valid: unknown; invalid: unknown }> =
  {
    'workflow.started': {
      valid: {
        templateSnapshot: template,
        repo: repoSnapshot,
        requirement: 'Add login',
        shortId: 'abcd1234',
        integrationBranch: 'ai-office/abcd1234-add-login',
        roleOverrides: { engineer: { agent: 'claude-code' } },
        gateToggles: { conclusion: true },
        budgets: {
          stages: { meeting: { tokens: 1000 } },
          hardLimitMultiplier: 2,
        },
        limits: { globalAgents: 10 },
        acknowledgedUnverifiedRuntime: false,
      },
      invalid: { requirement: 'missing limits' },
    },
    'workflow.paused': {
      valid: { reason: 'runtime_unhealthy' },
      invalid: { reason: 'tired' },
    },
    'workflow.resumed': { valid: { reason: 'anomaly' }, invalid: {} },
    'workflow.completed': {
      valid: { finalPr: 9, mergeCommitSha: sha },
      invalid: { finalPr: 0 },
    },
    'workflow.failed': {
      valid: { reason: 'max_reruns_exceeded', stageId: 'meeting' },
      invalid: { reason: 'oops' },
    },
    'workflow.cancel_requested': {
      valid: { by: 'gate', gateId: 'g1' },
      invalid: { by: 'agent' },
    },
    'workflow.cancelled': { valid: {}, invalid: { reason: 1 } },
    'stage.started': {
      valid: {
        stageId: 'meeting',
        kind: 'meeting',
        attempt: 1,
        mode: 'initial',
      },
      invalid: { stageId: 'meeting', kind: 'decision', attempt: 1 },
    },
    'stage.completed': {
      valid: { stageId: 'meeting', attempt: 1 },
      invalid: { stageId: 'meeting', attempt: 0 },
    },
    'stage.failed': {
      valid: { stageId: 'integrate', attempt: 2, reason: 'timeout' },
      invalid: { stageId: 'integrate', attempt: 2, reason: 'bored' },
    },
    'stage.rerun_requested': {
      valid: {
        stageId: 'integrate',
        fromAttempt: 1,
        mode: 'revision',
        by: 'user',
        feedback: 'Fix review comments',
      },
      invalid: {
        stageId: 'integrate',
        fromAttempt: 1,
        mode: 'initial',
        by: 'user',
      },
    },
    'gate.opened': {
      valid: {
        gateId: 'g1',
        stageId: 'meeting',
        kind: 'stage',
        templateGateId: 'conclusion',
        stageKind: 'meeting',
        optional: true,
        title: 'Conclusion',
        options: [],
        content: { type: 'conclusion', artifactId: 'art1', renderedHash: hash },
        version: 1,
      },
      invalid: { ...exception, exceptionKind: 'unknown' },
    },
    'gate.content_updated': {
      valid: {
        gateId: 'g1',
        source: 'github',
        version: 2,
        bodyHash: hash,
        githubUpdatedAt: at,
      },
      invalid: { gateId: 'g1', source: 'github', version: 2 },
    },
    'gate.decided': {
      valid: {
        gateId: 'g1',
        decision: 'approve',
        by: 'user',
        version: 2,
        approvedSnapshot: {
          source: 'github',
          body: '## Summary',
          bodyHash: hash,
          githubUpdatedAt: at,
          structured: null,
        },
      },
      invalid: { gateId: 'g1', decision: 'approve', by: 'robot', version: 2 },
    },
    'gate.closed': {
      valid: { gateId: 'g3', reason: 'merged' },
      invalid: { gateId: 'g3', reason: 'approved' },
    },
    'seat.spawned': {
      valid: {
        seatId: 'wf1:lead',
        attemptId: 'a1',
        attempt: 2,
        stageId: 'implement',
        role: 'lead',
        agent: 'claude-code',
        purpose: 'oncall',
        ondemand: { purpose: 'oncall' },
        keepOpen: true,
        spawnCommandId: 'c1',
      },
      invalid: {
        seatId: 'wf1:lead',
        attemptId: 'a1',
        ondemand: { purpose: 'merge-queue' },
      },
    },
    'seat.status': {
      valid: { attemptId: 'a1', state: 'waiting_input', waitingSince: at },
      invalid: { attemptId: 'a1', state: 'expired' },
    },
    'seat.activity': {
      valid: {
        attemptId: 'a1',
        activity: [
          {
            messageId: 'm1',
            tool: 'Bash',
            category: 'shell',
            ok: true,
            inputLen: 10,
            outputLen: 20,
            inputHash: 'h1',
          },
        ],
      },
      invalid: { attemptId: 'a1', activity: [] },
    },
    'seat.degraded': {
      valid: { attemptId: 'a1', reason: 'source_changed' },
      invalid: { attemptId: 'a1', reason: 'slow' },
    },
    'seat.policy_violation': {
      valid: {
        attemptId: 'a1',
        hits: [{ rule: 'gh-merge', severity: 'high', messageId: 'm1' }],
      },
      invalid: {
        attemptId: 'a1',
        hits: [{ rule: 'rm-rf', severity: 'high', messageId: 'm1' }],
      },
    },
    'seat.exited': {
      valid: { attemptId: 'a1', reason: 'released', expected: true },
      invalid: { attemptId: 'a1' },
    },
    'seat.released': {
      valid: { attemptId: 'a1', removeWorkspace: true },
      invalid: { attemptId: 'a1', removeWorkspace: 'yes' },
    },
    'agent.unmanaged': {
      valid: { dispatch: 'd9', parentDispatch: 'd1', agentKind: 'claude' },
      invalid: { parentDispatch: 'd1' },
    },
    'meeting.round_started': {
      valid: { stageId: 'meeting', round: 1, attemptIds: ['a2', 'a3'] },
      invalid: { stageId: 'meeting', round: 1, attemptIds: [] },
    },
    'meeting.statement': {
      valid: {
        stageId: 'meeting',
        attemptId: 'a2',
        role: 'engineer',
        artifactId: 'art2',
        statement: {
          round: 1,
          position: 'Agree',
          arguments: [],
          concerns: [],
          readyToConclude: true,
        },
      },
      invalid: { stageId: 'meeting', attemptId: 'a2', statement: {} },
    },
    'meeting.round_completed': {
      valid: {
        stageId: 'meeting',
        round: 1,
        statements: 1,
        absentAttemptIds: ['a3'],
        allReadyToConclude: false,
      },
      invalid: { stageId: 'meeting', round: 1, statements: -1 },
    },
    'meeting.concluded': {
      valid: {
        stageId: 'meeting',
        rounds: 2,
        endedEarly: false,
        conclusionArtifactId: 'art3',
      },
      invalid: { stageId: 'meeting', rounds: 0 },
    },
    'submission.accepted': {
      valid: {
        submissionId: 'sub1',
        attemptId: 'a1',
        kind: 'conclusion',
        submission: { kind: 'conclusion', payload: conclusion },
        artifactId: 'art3',
      },
      invalid: {
        submissionId: 'sub1',
        attemptId: 'a1',
        kind: 'agenda',
        submission: { kind: 'conclusion', payload: conclusion },
      },
    },
    'submission.rejected': {
      valid: {
        reason: 'schema',
        kind: 'statement',
        issues: [{ path: 'round', message: 'Required' }],
      },
      invalid: { reason: 'expired' },
    },
    'message.question': {
      valid: {
        questionId: 'msg1',
        attemptId: 'a4',
        itemKey: 'w1',
        body: 'Which DB? branch: ai-office/abcd1234/w1',
      },
      invalid: { questionId: 'msg1', body: 'missing asker' },
    },
    'message.forwarded': {
      valid: { questionId: 'msg1', to: 'on-call', toAttemptId: 'a5', retry: 0 },
      invalid: {
        questionId: 'msg1',
        to: 'on-call',
        toAttemptId: 'a5',
        retry: 2,
      },
    },
    'message.answered': {
      valid: {
        questionId: 'msg1',
        by: 'agent',
        body: 'sqlite',
        attemptId: 'a5',
      },
      invalid: { questionId: 'msg1', by: 'oracle', body: 'sqlite' },
    },
    'message.escalated': {
      valid: { questionId: 'msg1', reason: 'timeout', gateId: 'g4' },
      invalid: { questionId: 'msg1', reason: 'expired', gateId: 'g4' },
    },
    'message.nudge': {
      valid: {
        attemptId: 'a1',
        reason: 'missing-submission',
        subject: 'Submit conclusion',
        body: 'Run ai-office submit conclusion first.',
      },
      invalid: { attemptId: 'a1', reason: 'missing-submission' },
    },
    'message.instruction': {
      valid: {
        seatId: 'wf1:engineer:w1',
        attemptId: 'a4',
        subject: 'Hint',
        body: 'Check README',
      },
      invalid: { seatId: 'wf1:engineer:w1', subject: '' },
    },
    'ondemand.started': {
      valid: { stageId: 'implement', purpose: 'merge', attemptId: 'a5' },
      invalid: { stageId: 'implement', attemptId: 'a5' },
    },
    'ondemand.queue_changed': {
      valid: {
        stageId: 'implement',
        purpose: 'oncall',
        queue: ['msg1', 'msg2'],
        current: 'msg1',
      },
      invalid: { stageId: 'implement', purpose: 'oncall', queue: 'msg1' },
    },
    'ondemand.stopped': {
      valid: {
        stageId: 'implement',
        purpose: 'merge',
        attemptId: 'a5',
        reason: 'queue_empty',
      },
      invalid: {
        stageId: 'implement',
        purpose: 'merge-queue',
        attemptId: 'a5',
        reason: 'queue_empty',
      },
    },
    'workitem.proposed': {
      valid: { stageId: 'planning', submissionId: 'sub2', items: [draft] },
      invalid: {
        stageId: 'planning',
        submissionId: 'sub2',
        items: [{ ...draft, key: 'bad key/with slash' }],
      },
    },
    'workitem.approved': {
      valid: { gateId: 'g2', items: [{ ...draft, agent: 'codex' }] },
      invalid: { gateId: 'g2', items: [draft] },
    },
    'workitem.dispatched': {
      valid: {
        itemKey: 'w1',
        attemptId: 'a6',
        attempt: 2,
        agent: 'codex',
        branch: 'ai-office/abcd1234/w1-a2',
        workspaceName: 'aio-abcd1234-w1-a2',
        baseSha: sha,
        retryOf: 'a4',
      },
      invalid: {
        itemKey: 'w1',
        attemptId: 'a6',
        attempt: 2,
        agent: 'codex',
        branch: 'feature/w1',
        workspaceName: 'x',
      },
    },
    'workitem.status': {
      valid: { itemKey: 'w1', status: 'in_review', attemptId: 'a6', pr: 5 },
      invalid: { itemKey: 'w1', status: 'done' },
    },
    'workitem.merge_queued': {
      valid: { itemKey: 'w1', attemptId: 'a6', pr: 5, headSha: sha },
      invalid: { itemKey: 'w1', attemptId: 'a6', pr: 5 },
    },
    'workitem.rework_requested': {
      valid: {
        itemKey: 'w1',
        pr: 5,
        submissionId: 'sub9',
        attemptId: 'a7',
        reasons: ['missing tests'],
        rework: 1,
      },
      invalid: {
        itemKey: 'w1',
        pr: 5,
        submissionId: 'sub9',
        attemptId: 'a7',
        reasons: [],
        rework: 1,
      },
    },
    'workitem.merged': {
      valid: { itemKey: 'w1', pr: 5, mergeCommitSha: sha, commandId: 'c9' },
      invalid: { itemKey: 'w1', pr: 5, mergeCommitSha: 'not-a-sha' },
    },
    'artifact.created': {
      valid: {
        artifactId: 'art4',
        kind: 'pr',
        number: 5,
        url: 'https://github.com/octo/demo/pull/5',
        purpose: 'worker',
        head: 'ai-office/abcd1234/w1',
        base: 'ai-office/abcd1234-demo',
        itemKey: 'w1',
      },
      invalid: { artifactId: 'art4', kind: 'pr', number: 5 },
    },
    'pr.status': {
      valid: {
        pr: 5,
        state: 'merged',
        base: 'ai-office/abcd1234-demo',
        head: 'ai-office/abcd1234/w1',
        headSha: sha,
        mergeable: null,
        checks: 'success',
        mergedBy: 'octo',
      },
      invalid: { pr: 5, state: 'draft' },
    },
    'scm.issue_drift': {
      valid: {
        issue: 3,
        bodyHash: hash,
        githubUpdatedAt: at,
        labels: ['role:engineer'],
        itemKey: 'w1',
      },
      invalid: { issue: 3, bodyHash: 'short', githubUpdatedAt: at, labels: [] },
    },
    'anomaly.detected': {
      valid: {
        kind: 'unknown-object',
        severity: 'high',
        summary: 'Issue #7 has no marker',
        number: 7,
        author: 'octo',
      },
      invalid: { kind: 'ghost', severity: 'high', summary: 'x' },
    },
    'usage.tokens': {
      valid: {
        attemptId: 'a1',
        inputUncached: 10,
        output: 20,
        cacheRead: 3000,
        cacheWrite: 5,
        budgetTokens: 35,
      },
      invalid: {
        attemptId: 'a1',
        inputUncached: -1,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        budgetTokens: 0,
      },
    },
    'usage.turns': {
      valid: { attemptId: 'a1', turns: 1 },
      invalid: { attemptId: 'a1', turns: 0 },
    },
    'budget.exceeded': {
      valid: {
        scope: 'item',
        stageId: 'implement',
        itemKey: 'w1',
        attemptId: 'a6',
        metric: 'tokens',
        used: 120,
        budget: 100,
        threshold: 100,
      },
      invalid: {
        scope: 'item',
        stageId: 'implement',
        metric: 'tokens',
        used: 120,
        budget: 100,
        threshold: 100,
      },
    },
    'budget.hard_limit': {
      valid: {
        scope: 'stage',
        stageId: 'meeting',
        stageAttempt: 1,
        metric: 'tokens',
        used: 2000,
        budget: 1000,
        threshold: 2000,
        gateId: 'g5',
      },
      invalid: {
        scope: 'repo',
        metric: 'tokens',
        used: 1,
        budget: 1,
        threshold: 1,
      },
    },
    'command.issued': {
      valid: {
        commandId: 'c1',
        orcaRequestId: '6ba7b810-9dad-51d1-80b4-00c04fd430c8',
        kind: 'runtime.send',
        args: commandExamples['runtime.send'],
      },
      invalid: {
        commandId: 'c1',
        kind: 'runtime.send',
        args: commandExamples['runtime.send'],
      },
    },
    'command.succeeded': {
      valid: {
        commandId: 'c1',
        kind: 'runtime.spawnAgent',
        result: { agent: 'ag1' },
      },
      invalid: { commandId: 'c1', kind: 'runtime.spawnAgent', result: {} },
    },
    'command.failed': {
      valid: {
        commandId: 'c1',
        kind: 'scm.mergePR',
        attempts: 3,
        error: {
          category: 'transient',
          code: 'github_5xx',
          message: 'Bad gateway',
          retryable: true,
        },
      },
      invalid: {
        commandId: 'c1',
        kind: 'scm.mergePR',
        attempts: 1,
        error: {
          category: 'panic',
          code: 'x',
          message: '',
          retryable: false,
        },
      },
    },
    'command.reconciled': {
      valid: { commandId: 'c1', kind: 'runtime.spawnAgent', outcome: 'found' },
      invalid: { commandId: 'c1', kind: 'runtime.spawnAgent', outcome: 'lost' },
    },
    'timer.scheduled': {
      valid: {
        timerId: 't1',
        fireAt: at,
        payload: { purpose: 'question-timeout', questionId: 'msg1' },
      },
      invalid: { timerId: 't1', fireAt: at, payload: { purpose: 'alarm' } },
    },
    'timer.fired': { valid: { timerId: 't1' }, invalid: { timerId: '' } },
    'timer.cancelled': {
      valid: { timerId: 't1', reason: 'cancelled' },
      invalid: {},
    },
    'repo.registered': {
      valid: repoSnapshot,
      invalid: { ...repoSnapshot, visibility: 'internal' },
    },
    'repo.updated': {
      valid: { repoId: 'r1', status: 'invalid', issues: ['Not in Orca'] },
      invalid: { status: 'registered' },
    },
    'health.changed': {
      valid: { component: 'runtime', status: 'degraded', breaker: 'half_open' },
      invalid: { component: 'orca', status: 'degraded' },
    },
    'runtime.identity_restored': {
      valid: { newShim: 'term_2', runs: ['run1'] },
      invalid: { runs: ['run1'] },
    },
    'runtime.identity_hijacked': {
      valid: {
        run: 'run1',
        coordinatorHandle: 'term_x',
        consumerGeneration: 3,
      },
      invalid: {
        run: 'run1',
        coordinatorHandle: 'term_x',
        consumerGeneration: -1,
      },
    },
    'error.recorded': {
      valid: {
        category: 'guard',
        code: 'merge_default_branch',
        message: 'Refused',
      },
      invalid: { category: 'panic', code: 'x', message: 'x' },
    },
  };

const envelope = {
  seq: 1,
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  occurredAt: at,
  recordedAt: '2026-11-17T00:00:01Z',
  workflowId: 'wf1',
  source: 'engine',
  provenance: 'decided',
  schemaVersion: 1,
};
const event = (type: EventType, payload: unknown) => ({
  ...envelope,
  type,
  payload,
});

test('EVENT_TYPES matches the DomainEventSchema options one-to-one', () => {
  expect(EVENT_TYPES).toHaveLength(66);
  expect(new Set(EVENT_TYPES).size).toBe(66);
  expect(DomainEventSchema.options.map((o) => o.shape.type.value)).toEqual([
    ...EVENT_TYPES,
  ]);
  expect(Object.keys(EVENT_PAYLOAD_SCHEMAS).sort()).toEqual(
    [...EVENT_TYPES].sort(),
  );
  expect(Object.keys(payloadExamples).sort()).toEqual([...EVENT_TYPES].sort());
  for (const type of EVENT_TYPES) expect(CURRENT_SCHEMA_VERSION[type]).toBe(1);
});

test.each([...EVENT_TYPES])(
  '%s accepts a valid payload and round-trips',
  (type) => {
    const value = event(type, payloadExamples[type].valid);
    const parsed = DomainEventSchema.parse(value);
    expect(DomainEventSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(
      parsed,
    );
    expect(parsed.payload).toEqual(payloadExamples[type].valid);
  },
);

test.each([...EVENT_TYPES])('%s rejects an invalid payload', (type) => {
  expect(
    DomainEventSchema.safeParse(event(type, payloadExamples[type].invalid))
      .success,
  ).toBe(false);
});

test('payloads are no longer open records', () => {
  expect(
    DomainEventSchema.safeParse(event('workflow.paused', { futureField: true }))
      .success,
  ).toBe(false);
  expect(
    DomainEventSchema.safeParse(event('agent.output' as EventType, {})).success,
  ).toBe(false);
});

test('ExternalCommandSchema covers every kind with an example', () => {
  expect(ExternalCommandSchema.options.map((o) => o.shape.kind.value)).toEqual([
    ...EXTERNAL_COMMAND_KINDS,
  ]);
  expect(Object.keys(commandExamples).sort()).toEqual(
    [...EXTERNAL_COMMAND_KINDS].sort(),
  );
});

test.each([...EXTERNAL_COMMAND_KINDS])('command %s parses', (kind) => {
  const value = { kind, args: commandExamples[kind] };
  expect(ExternalCommandSchema.parse(value)).toEqual(value);
  expect(
    ExternalCommandSchema.safeParse({ kind, args: { unexpected: true } })
      .success,
  ).toBe(false);
});

test('orcaRequestId is required exactly for Orca orchestration mutations', () => {
  const requestId = '6ba7b810-9dad-51d1-80b4-00c04fd430c8';
  for (const kind of EXTERNAL_COMMAND_KINDS) {
    const base = { commandId: 'c1', kind, args: commandExamples[kind] };
    const needs = (
      ORCA_REQUEST_ID_KINDS as readonly ExternalCommandKind[]
    ).includes(kind);
    expect(CommandIssuedPayloadSchema.safeParse(base).success).toBe(!needs);
    expect(
      CommandIssuedPayloadSchema.safeParse({
        ...base,
        orcaRequestId: requestId,
      }).success,
    ).toBe(needs);
  }
});

test('deleteBranch refuses non AI Office branches', () => {
  expect(
    ExternalCommandSchema.safeParse({
      kind: 'scm.deleteBranch',
      args: { repo, name: 'main' },
    }).success,
  ).toBe(false);
});

test('gate kinds, conclusion edits, and Q10 question states', () => {
  const opened = payloadExamples['gate.opened'];
  expect(
    DomainEventSchema.safeParse(
      event('gate.opened', {
        gateId: 'g2',
        stageId: 'implement',
        kind: 'exception',
        exceptionKind: 'item-budget-hard-limit',
        title: 'Budget',
        options: [{ optionId: 'topup', label: 'Add', input: 'tokens' }],
        content: { type: 'exception', summary: 'Over budget' },
        version: 1,
      }),
    ).success,
  ).toBe(true);
  // Stage gates must not carry an exception kind and vice versa.
  expect(
    DomainEventSchema.safeParse(
      event('gate.opened', {
        ...(opened.valid as object),
        kind: 'exception',
      }),
    ).success,
  ).toBe(false);
  expect(
    DomainEventSchema.safeParse(
      event('gate.decided', {
        gateId: 'g1',
        decision: 'revise',
        by: 'user',
        version: 3,
        edits: { type: 'conclusion', conclusion },
      }),
    ).success,
  ).toBe(true);
});

test('submissions and artifacts share one schema source', () => {
  expect(SubmissionFromAgentPath).toBe(AgentSubmissionSchema);
  expect(
    AgentSubmissionSchema.safeParse({
      kind: 'decision-request',
      payload: {
        reason: 'other',
        question: 'Which?',
        options: ['a', 'b', 'c', 'd', 'e'],
      },
    }).success,
  ).toBe(false);
});

test('seat ids are deterministic and encode separators', () => {
  expect(seatIdFor({ workflowId: 'wf1', role: 'lead' })).toBe('wf1:lead');
  expect(seatIdFor({ workflowId: 'wf1', role: 'eng', itemKey: 'w1' })).toBe(
    'wf1:eng:w1',
  );
  expect(seatIdFor({ workflowId: 'wf1', role: 'a:b' })).toBe('wf1:a%3Ab');
});

test('submission responses and HTTP exit-code mapping', () => {
  for (const value of [
    { status: 'accepted', submissionId: 's1' },
    { status: 'merged', submissionId: 's1', pr: 5, mergeCommitSha: sha },
    { status: 'pending', submissionId: 's1' },
    {
      status: 'failed',
      submissionId: 's1',
      pr: 5,
      reason: 'checks_failed',
      message: 'CI red',
    },
  ])
    expect(SubmissionResponseSchema.parse(value)).toEqual(value);
  expect(
    SubmissionResponseSchema.safeParse({ status: 'failed', submissionId: 's1' })
      .success,
  ).toBe(false);
  expect(
    [200, 201, 202, 400, 422, 401, 403, 409, 410, 418, 500, 503].map(
      exitCodeForHttpStatus,
    ),
  ).toEqual([0, 0, 3, 2, 2, 3, 3, 3, 3, 3, 4, 4]);
});

test('runtime.json schema', () => {
  const info = { port: 4319, pid: 123, startedAt: at };
  expect(RuntimeInfoSchema.parse(info)).toEqual(info);
  expect(RuntimeInfoSchema.safeParse({ ...info, port: 70000 }).success).toBe(
    false,
  );
});

test('draft and payload helper types narrow by event type', () => {
  const draft: DomainEventDraft = {
    occurredAt: at,
    workflowId: 'wf1',
    source: 'engine',
    provenance: 'decided',
    schemaVersion: 1,
    type: 'timer.fired',
    payload: { timerId: 't1' },
  };
  const payload: EventPayload<'gate.closed'> = {
    gateId: 'g1',
    reason: 'superseded',
  };
  // @ts-expect-error drafts never carry seq.
  const withSeq: DomainEventDraft = { ...draft, seq: 1 };
  expect([draft, payload, withSeq]).toHaveLength(3);
});

test('error categories match the 12 in SPEC §15', () => {
  expect(ErrorCategorySchema.options).toEqual([
    'transient',
    'rate_limited',
    'auth',
    'suspect_escalation',
    'identity',
    'hijacked',
    'contract_mismatch',
    'permanent',
    'bug',
    'conflict',
    'validation',
    'guard',
  ]);
});

test('generated schemas reference shared definitions that exist', () => {
  const dir = new URL('../../generated/', import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  const refs = (text: string) =>
    [...text.matchAll(/"\$ref": "([^"]+)"/g)].map((match) => match[1]!);
  for (const name of files.filter((file) => file !== 'openapi.json'))
    for (const ref of refs(readFileSync(new URL(name, dir), 'utf8')))
      if (!ref.startsWith('#')) expect(files).toContain(ref.slice(2));
  const openapi = readFileSync(new URL('openapi.json', dir), 'utf8');
  const components = Object.keys(JSON.parse(openapi).components.schemas);
  for (const ref of refs(openapi))
    if (ref.startsWith('#/components/schemas/'))
      expect(components).toContain(ref.slice('#/components/schemas/'.length));
  expect(components).toContain('DomainEvent');
  expect(openapi).not.toContain('./');
});

describe('rev2.10 progressive merge (M1-CP3)', () => {
  test.each(['merge_queued', 'in_review', 'rework'])(
    'work-item status %s parses',
    (status) => {
      expect(WorkItemStatusSchema.parse(status)).toBe(status);
    },
  );
  test.each(['rework_requested', 'reviewing', 'queued'])(
    'work-item status %s is rejected',
    (status) => {
      expect(WorkItemStatusSchema.safeParse(status).success).toBe(false);
    },
  );

  test('oncall.* event types are gone; ondemand.* carry a purpose', () => {
    expect(EVENT_TYPES.filter((t) => t.startsWith('oncall.'))).toEqual([]);
    for (const type of [
      'oncall.started',
      'oncall.queue_changed',
      'oncall.stopped',
    ])
      expect(
        DomainEventSchema.safeParse(
          event(type as EventType, payloadExamples['ondemand.started'].valid),
        ).success,
      ).toBe(false);
    for (const type of [
      'ondemand.started',
      'ondemand.queue_changed',
      'ondemand.stopped',
    ] as const) {
      const withoutPurpose = {
        ...(payloadExamples[type].valid as object),
        purpose: undefined,
      };
      expect(
        EVENT_PAYLOAD_SCHEMAS[type].safeParse(withoutPurpose).success,
      ).toBe(false);
    }
  });

  test('seat.spawned drops the oncall flag for ondemand.purpose', () => {
    const valid = payloadExamples['seat.spawned'].valid as Record<
      string,
      unknown
    >;
    const schema = EVENT_PAYLOAD_SCHEMAS['seat.spawned'];
    expect(
      schema.parse({ ...valid, ondemand: { purpose: 'merge' } }),
    ).toMatchObject({ ondemand: { purpose: 'merge' } });
    const plain = { ...valid };
    delete plain.ondemand;
    expect(schema.parse(plain)).not.toHaveProperty('ondemand');
    // Unknown keys are stripped, so the legacy flag never reaches consumers.
    expect(schema.parse({ ...plain, oncall: true })).not.toHaveProperty(
      'oncall',
    );
  });

  test('rework-request is the ninth submission kind', () => {
    const submission = {
      kind: 'rework-request',
      payload: { pr: 5, reasons: ['Add tests'] },
    } as const;
    expect(AgentSubmissionSchema.options).toHaveLength(9);
    expect(
      SubmissionAcceptedPayloadSchema.parse({
        submissionId: 'sub9',
        attemptId: 'a7',
        kind: 'rework-request',
        submission,
      }).kind,
    ).toBe('rework-request');
    expect(
      SubmissionAcceptedPayloadSchema.safeParse({
        submissionId: 'sub9',
        attemptId: 'a7',
        kind: 'merge-request',
        submission,
      }).success,
    ).toBe(false);
  });

  test('prepareWorkspace fetches the remote base and reports baseSha', () => {
    const args = {
      ...(commandExamples['runtime.prepareWorkspace'] as object),
      baseBranch: sha,
      fetchBranch: 'ai-office/abcd1234-demo',
    };
    expect(
      ExternalCommandSchema.parse({ kind: 'runtime.prepareWorkspace', args }),
    ).toMatchObject({ args: { fetchBranch: 'ai-office/abcd1234-demo' } });
    expect(
      ExternalCommandSchema.safeParse({
        kind: 'runtime.prepareWorkspace',
        args: { ...args, fetchBranch: '' },
      }).success,
    ).toBe(false);
    expect(
      CommandResultSchema.parse({
        kind: 'runtime.prepareWorkspace',
        result: { workspace: 'ws1', path: '/wt/w1', baseSha: sha },
      }),
    ).toMatchObject({ result: { baseSha: sha } });
    expect(
      CommandResultSchema.safeParse({
        kind: 'runtime.prepareWorkspace',
        result: { workspace: 'ws1', path: '/wt/w1', baseSha: 'HEAD' },
      }).success,
    ).toBe(false);
    expect(
      EVENT_PAYLOAD_SCHEMAS['workitem.dispatched'].safeParse({
        ...(payloadExamples['workitem.dispatched'].valid as object),
        baseSha: 'origin/main',
      }).success,
    ).toBe(false);
  });

  test('exception gates and timers for the merge queue', () => {
    for (const kind of [
      'dependency-blocked',
      'merge-blocked',
      'rework-limit',
      'merge-review-failed',
    ])
      expect(ExceptionKindSchema.safeParse(kind).success).toBe(true);
    expect(
      TimerPayloadSchema.parse({
        purpose: 'review-timeout',
        itemKey: 'w1',
        attemptId: 'a7',
      }).purpose,
    ).toBe('review-timeout');
    expect(
      TimerPayloadSchema.parse({
        purpose: 'ondemand-idle',
        stageId: 'implement',
        ondemand: 'merge',
      }).purpose,
    ).toBe('ondemand-idle');
    expect(
      TimerPayloadSchema.safeParse({
        purpose: 'ondemand-idle',
        stageId: 'implement',
        ondemand: 'merge-queue',
      }).success,
    ).toBe(false);
  });
});

test('compareBranch is read-only and preserves both comparison and missing-branch results', () => {
  const issued = {
    commandId: 'compare',
    kind: 'scm.compareBranch',
    args: commandExamples['scm.compareBranch'],
  };
  expect(CommandIssuedPayloadSchema.parse(issued)).toEqual(issued);
  expect(
    CommandIssuedPayloadSchema.safeParse({
      ...issued,
      orcaRequestId: '00000000-0000-4000-8000-000000000000',
    }).success,
  ).toBe(false);
  for (const result of [
    null,
    { ahead: 0, headSha: sha },
    { ahead: 2, headSha: sha },
  ]) {
    const payload = { commandId: 'compare', kind: 'scm.compareBranch', result };
    expect(EVENT_PAYLOAD_SCHEMAS['command.succeeded'].parse(payload)).toEqual(
      payload,
    );
  }
  for (const result of [
    { ahead: -1, headSha: sha },
    { ahead: 0.5, headSha: sha },
    { ahead: 1, headSha: 'HEAD' },
  ]) {
    expect(
      CommandResultSchema.safeParse({ kind: 'scm.compareBranch', result })
        .success,
    ).toBe(false);
  }
});
test('prepareWorkspace retains the optional existing-branch checkout flag', () => {
  const args = {
    ...(commandExamples['runtime.prepareWorkspace'] as object),
    checkoutExisting: true,
  };
  expect(
    ExternalCommandSchema.parse({ kind: 'runtime.prepareWorkspace', args }),
  ).toEqual({ kind: 'runtime.prepareWorkspace', args });
  expect(
    ExternalCommandSchema.safeParse({
      kind: 'runtime.prepareWorkspace',
      args: { ...args, checkoutExisting: false },
    }).success,
  ).toBe(false);
});

test('submission.accepted optionally preserves the provider session for usage lookup', () => {
  const payload = payloadExamples['submission.accepted'].valid;
  expect(SubmissionAcceptedPayloadSchema.parse(payload)).toEqual(payload);
  for (const provider of ['claude', 'codex']) {
    const withSession = {
      ...(payload as object),
      agentSession: { provider, id: 'session-1' },
    };
    expect(
      EVENT_PAYLOAD_SCHEMAS['submission.accepted'].parse(withSession),
    ).toEqual(withSession);
  }
  for (const agentSession of [
    null,
    {},
    { provider: 'other', id: 'session-1' },
    { provider: 'claude' },
    { provider: 'codex', id: '' },
    { provider: 'codex', id: 123 },
  ]) {
    expect(
      SubmissionAcceptedPayloadSchema.safeParse({
        ...(payload as object),
        agentSession,
      }).success,
    ).toBe(false);
  }
});
