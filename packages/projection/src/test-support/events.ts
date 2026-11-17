// Schema-valid examples, adapted from the contracts event catalog.
import {
  DomainEventSchema,
  type DomainEvent,
  type EventType,
} from '@ai-office/contracts/events';
export const at = '2026-11-17T00:00:00Z';
export const payloads = {
  'workflow.started': {
    templateSnapshot: {
      apiVersion: 'ai-office/v1alpha1',
      id: 'flow',
      name: 'Flow',
      roles: {
        lead: {
          agent: 'claude-code',
        },
        engineer: {
          agent: 'codex',
        },
      },
      defaults: {
        integrationBranch: 'ai-office/{shortId}-{slug}',
        maxReruns: 2,
        budget: {
          hardLimitMultiplier: 2,
        },
      },
      stages: [
        {
          id: 'meeting',
          kind: 'meeting',
          facilitator: 'lead',
          participants: ['engineer'],
          maxRounds: 2,
          timeouts: {
            roundMin: 15,
            stageMin: 60,
          },
          budget: {
            tokens: 1000,
          },
          conclusion: {
            requireTechDecisions: true,
          },
          gate: {
            id: 'conclusion',
            title: 'Conclusion',
          },
        },
        {
          id: 'planning',
          kind: 'planning',
          owner: 'lead',
          from: 'meeting',
          timeouts: {
            stageMin: 30,
          },
          budget: {
            tokens: 1000,
          },
          gate: {
            id: 'plan',
            title: 'Plan',
          },
        },
        {
          id: 'implement',
          kind: 'implement',
          role: 'engineer',
          from: 'planning',
          maxParallel: 2,
          timeouts: {
            itemMin: 45,
          },
          budget: {
            tokens: 1000,
            perItem: {
              tokens: 100,
            },
          },
          onCall: {
            role: 'lead',
            questionTimeoutMin: 10,
          },
        },
        {
          id: 'integrate',
          kind: 'integrate',
          owner: 'lead',
          escalateOn: ['unresolvable-conflict'],
          timeouts: {
            stageMin: 60,
          },
          budget: {
            tokens: 1000,
          },
        },
        {
          id: 'final-pr',
          kind: 'final-pr',
          maxRevisions: 2,
          gate: {
            id: 'final-pr',
            title: 'Final PR',
          },
        },
      ],
    },
    repo: {
      repoId: 'r1',
      localPath: '/repo',
      orcaRepoId: 'orca-1',
      github: {
        owner: 'octo',
        name: 'demo',
      },
      defaultBranch: 'main',
      visibility: 'public',
      ownerLogin: 'octo',
      defaultBranchProtected: 'unknown',
    },
    requirement: 'Add login',
    shortId: 'abcd1234',
    integrationBranch: 'ai-office/abcd1234-add-login',
    roleOverrides: {
      engineer: {
        agent: 'claude-code',
      },
    },
    gateToggles: {
      conclusion: true,
    },
    budgets: {
      stages: {
        meeting: {
          tokens: 1000,
        },
      },
      hardLimitMultiplier: 2,
    },
    limits: {
      globalAgents: 10,
    },
    acknowledgedUnverifiedRuntime: false,
  },
  'workflow.paused': {
    reason: 'runtime_unhealthy',
  },
  'workflow.resumed': {
    reason: 'anomaly',
  },
  'workflow.completed': {
    finalPr: 9,
    mergeCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  'workflow.failed': {
    reason: 'max_reruns_exceeded',
    stageId: 'meeting',
  },
  'workflow.cancel_requested': {
    by: 'gate',
    gateId: 'g1',
  },
  'workflow.cancelled': {},
  'stage.started': {
    stageId: 'meeting',
    kind: 'meeting',
    attempt: 1,
    mode: 'initial',
  },
  'stage.completed': {
    stageId: 'meeting',
    attempt: 1,
  },
  'stage.failed': {
    stageId: 'integrate',
    attempt: 2,
    reason: 'timeout',
  },
  'stage.rerun_requested': {
    stageId: 'integrate',
    fromAttempt: 1,
    mode: 'revision',
    by: 'user',
    feedback: 'Fix review comments',
  },
  'gate.opened': {
    gateId: 'g1',
    stageId: 'meeting',
    kind: 'stage',
    templateGateId: 'conclusion',
    stageKind: 'meeting',
    optional: true,
    title: 'Conclusion',
    options: [],
    content: {
      type: 'conclusion',
      artifactId: 'art1',
      renderedHash:
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
    version: 1,
  },
  'gate.content_updated': {
    gateId: 'g1',
    source: 'github',
    version: 2,
    bodyHash:
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    githubUpdatedAt: '2026-11-17T00:00:00Z',
  },
  'gate.decided': {
    gateId: 'g1',
    decision: 'approve',
    by: 'user',
    version: 2,
    approvedSnapshot: {
      source: 'github',
      body: '## Summary',
      bodyHash:
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      githubUpdatedAt: '2026-11-17T00:00:00Z',
      structured: null,
    },
  },
  'gate.closed': {
    gateId: 'g3',
    reason: 'merged',
  },
  'seat.spawned': {
    seatId: 'wf1:lead',
    attemptId: 'a1',
    attempt: 2,
    stageId: 'implement',
    role: 'lead',
    agent: 'claude-code',
    purpose: 'oncall',
    oncall: true,
    keepOpen: true,
    spawnCommandId: 'c1',
  },
  'seat.status': {
    attemptId: 'a1',
    state: 'waiting_input',
    waitingSince: '2026-11-17T00:00:00Z',
  },
  'seat.activity': {
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
  'seat.degraded': {
    attemptId: 'a1',
    reason: 'source_changed',
  },
  'seat.policy_violation': {
    attemptId: 'a1',
    hits: [
      {
        rule: 'gh-merge',
        severity: 'high',
        messageId: 'm1',
      },
    ],
  },
  'seat.exited': {
    attemptId: 'a1',
    reason: 'released',
    expected: true,
  },
  'seat.released': {
    attemptId: 'a1',
    removeWorkspace: true,
  },
  'agent.unmanaged': {
    dispatch: 'd9',
    parentDispatch: 'd1',
    agentKind: 'claude',
  },
  'meeting.round_started': {
    stageId: 'meeting',
    round: 1,
    attemptIds: ['a2', 'a3'],
  },
  'meeting.statement': {
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
  'meeting.round_completed': {
    stageId: 'meeting',
    round: 1,
    statements: 1,
    absentAttemptIds: ['a3'],
    allReadyToConclude: false,
  },
  'meeting.concluded': {
    stageId: 'meeting',
    rounds: 2,
    endedEarly: false,
    conclusionArtifactId: 'art3',
  },
  'submission.accepted': {
    submissionId: 'sub1',
    attemptId: 'a1',
    kind: 'conclusion',
    submission: {
      kind: 'conclusion',
      payload: {
        summary: 'Build it',
        decisions: [
          {
            title: 'Scope',
            rationale: 'Small',
          },
        ],
        techDecisions: [
          {
            topic: 'DB',
            options: ['sqlite'],
            chosen: 'sqlite',
            rationale: 'Local',
          },
        ],
        openQuestions: [],
      },
    },
    artifactId: 'art3',
  },
  'submission.rejected': {
    reason: 'schema',
    kind: 'statement',
    issues: [
      {
        path: 'round',
        message: 'Required',
      },
    ],
  },
  'message.question': {
    questionId: 'msg1',
    attemptId: 'a4',
    itemKey: 'w1',
    body: 'Which DB? branch: ai-office/abcd1234/w1',
  },
  'message.forwarded': {
    questionId: 'msg1',
    to: 'on-call',
    toAttemptId: 'a5',
    retry: 0,
  },
  'message.answered': {
    questionId: 'msg1',
    by: 'agent',
    body: 'sqlite',
    attemptId: 'a5',
  },
  'message.escalated': {
    questionId: 'msg1',
    reason: 'timeout',
    gateId: 'g4',
  },
  'message.nudge': {
    attemptId: 'a1',
    reason: 'missing-submission',
    subject: 'Submit conclusion',
    body: 'Run ai-office submit conclusion first.',
  },
  'message.instruction': {
    seatId: 'wf1:engineer:w1',
    attemptId: 'a4',
    subject: 'Hint',
    body: 'Check README',
  },
  'oncall.started': {
    stageId: 'implement',
    attemptId: 'a5',
  },
  'oncall.queue_changed': {
    stageId: 'implement',
    queue: ['msg1', 'msg2'],
    current: 'msg1',
  },
  'oncall.stopped': {
    stageId: 'implement',
    attemptId: 'a5',
    reason: 'queue_empty',
  },
  'workitem.proposed': {
    stageId: 'planning',
    submissionId: 'sub2',
    items: [
      {
        key: 'w1',
        title: 'Build',
        body: 'Do it',
        acceptance: ['tests pass'],
        role: 'engineer',
        deps: [],
      },
    ],
  },
  'workitem.approved': {
    gateId: 'g2',
    items: [
      {
        key: 'w1',
        title: 'Build',
        body: 'Do it',
        acceptance: ['tests pass'],
        role: 'engineer',
        deps: [],
        agent: 'codex',
      },
    ],
  },
  'workitem.dispatched': {
    itemKey: 'w1',
    attemptId: 'a6',
    attempt: 2,
    agent: 'codex',
    branch: 'ai-office/abcd1234/w1-a2',
    workspaceName: 'aio-abcd1234-w1-a2',
    retryOf: 'a4',
  },
  'workitem.status': {
    itemKey: 'w1',
    status: 'pr_open',
    attemptId: 'a6',
    pr: 5,
  },
  'artifact.created': {
    artifactId: 'art4',
    kind: 'pr',
    number: 5,
    url: 'https://github.com/octo/demo/pull/5',
    purpose: 'worker',
    head: 'ai-office/abcd1234/w1',
    base: 'ai-office/abcd1234-demo',
    itemKey: 'w1',
  },
  'pr.status': {
    pr: 5,
    state: 'merged',
    base: 'ai-office/abcd1234-demo',
    head: 'ai-office/abcd1234/w1',
    headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    mergeable: null,
    checks: 'success',
    mergedBy: 'octo',
  },
  'scm.issue_drift': {
    issue: 3,
    bodyHash:
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    githubUpdatedAt: '2026-11-17T00:00:00Z',
    labels: ['role:engineer'],
    itemKey: 'w1',
  },
  'anomaly.detected': {
    kind: 'unknown-object',
    severity: 'high',
    summary: 'Issue #7 has no marker',
    number: 7,
    author: 'octo',
  },
  'usage.tokens': {
    attemptId: 'a1',
    inputUncached: 10,
    output: 20,
    cacheRead: 3000,
    cacheWrite: 5,
    budgetTokens: 35,
  },
  'usage.turns': {
    attemptId: 'a1',
    turns: 1,
  },
  'budget.exceeded': {
    scope: 'item',
    stageId: 'implement',
    itemKey: 'w1',
    attemptId: 'a6',
    metric: 'tokens',
    used: 120,
    budget: 100,
    threshold: 100,
  },
  'budget.hard_limit': {
    scope: 'stage',
    stageId: 'meeting',
    stageAttempt: 1,
    metric: 'tokens',
    used: 2000,
    budget: 1000,
    threshold: 2000,
    gateId: 'g5',
  },
  'command.issued': {
    commandId: 'c1',
    orcaRequestId: '6ba7b810-9dad-51d1-80b4-00c04fd430c8',
    kind: 'runtime.send',
    args: {
      agent: 'ag1',
      subject: 'Round 2',
      body: 'Go',
    },
  },
  'command.succeeded': {
    commandId: 'c1',
    kind: 'runtime.spawnAgent',
    result: {
      agent: 'ag1',
    },
  },
  'command.failed': {
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
  'command.reconciled': {
    commandId: 'c1',
    kind: 'runtime.spawnAgent',
    outcome: 'found',
  },
  'timer.scheduled': {
    timerId: 't1',
    fireAt: '2026-11-17T00:00:00Z',
    payload: {
      purpose: 'question-timeout',
      questionId: 'msg1',
    },
  },
  'timer.fired': {
    timerId: 't1',
  },
  'timer.cancelled': {
    timerId: 't1',
    reason: 'cancelled',
  },
  'repo.registered': {
    repoId: 'r1',
    localPath: '/repo',
    orcaRepoId: 'orca-1',
    github: {
      owner: 'octo',
      name: 'demo',
    },
    defaultBranch: 'main',
    visibility: 'public',
    ownerLogin: 'octo',
    defaultBranchProtected: 'unknown',
  },
  'repo.updated': {
    repoId: 'r1',
    status: 'invalid',
    issues: ['Not in Orca'],
  },
  'health.changed': {
    component: 'runtime',
    status: 'degraded',
    breaker: 'half_open',
  },
  'runtime.identity_restored': {
    newShim: 'term_2',
    runs: ['run1'],
  },
  'runtime.identity_hijacked': {
    run: 'run1',
    coordinatorHandle: 'term_x',
    consumerGeneration: 3,
  },
  'error.recorded': {
    category: 'guard',
    code: 'merge_default_branch',
    message: 'Refused',
  },
} as const;
export function event(
  type: EventType,
  seq = 1,
  payload: unknown = payloads[type],
  workflowId: string | null = 'wf1',
): DomainEvent {
  return DomainEventSchema.parse({
    seq,
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    occurredAt: at,
    recordedAt: at,
    workflowId,
    source: 'engine',
    provenance: 'decided',
    schemaVersion: 1,
    type,
    payload,
  });
}
