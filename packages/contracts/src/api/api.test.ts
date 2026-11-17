import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import { ErrorCategorySchema } from '../events/index.js';
import {
  API_ERROR_CODES,
  API_ERRORS,
  apiEndpoints,
  ErrorResponseSchema,
  GateDecisionRequestSchema,
  GateStatusSchema,
  QuestionViewSchema,
  SEAT_RECENT_ACTIVITY_LIMIT,
  SeatViewSchema,
  WorkflowReadModelSchema,
} from './index.js';

const at = '2026-11-17T00:00:00Z';
const hash = 'a'.repeat(64);
const template = parse(
  readFileSync(
    new URL('../../../templates/feature-to-pr.yaml', import.meta.url),
    'utf8',
  ),
);
const usage = {
  inputUncached: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  budgetTokens: 15,
  turns: 1,
};
const repo = {
  repoId: 'r1',
  localPath: '/repos/app',
  orcaRepoId: 'orca-r1',
  github: { owner: 'octo', name: 'app' },
  defaultBranch: 'main',
  visibility: 'public',
  ownerLogin: 'octo',
  defaultBranchProtected: 'unknown',
};
const conclusion = {
  summary: 'Build it',
  decisions: [],
  techDecisions: [],
  openQuestions: [],
};
const attempt = {
  attemptId: 'att1',
  attempt: 1,
  stageId: 'implement',
  role: 'engineer',
  agent: 'codex',
  purpose: 'worker',
  oncall: false,
  itemKey: 'w1',
  state: 'waiting_input',
  degraded: false,
  waitingSince: at,
  startedAt: at,
  released: false,
  usage,
};
const seat = {
  seatId: 'wf1:engineer:w1',
  workflowId: 'wf1',
  role: 'engineer',
  itemKey: 'w1',
  agent: 'codex',
  state: 'waiting_input',
  degraded: false,
  currentAttemptId: 'att1',
  currentWorkItem: 'w1',
  recentActivity: [
    {
      messageId: 'm1',
      category: 'edit',
      inputLen: 1,
      outputLen: 2,
      inputHash: 'h',
      attemptId: 'att1',
      at,
    },
  ],
  attempts: [attempt],
  policyHits: [],
  usage,
  errors: [],
};
const pr = {
  number: 7,
  url: 'https://github.com/octo/app/pull/7',
  state: 'open',
  base: 'ai-office/abcd-x',
  head: 'ai-office/abcd/w1',
  headSha: 'abc1234',
  mergeable: true,
  checks: 'success',
  purpose: 'worker',
  itemKey: 'w1',
  updatedAt: at,
};
const conclusionGate = {
  gateId: 'g1',
  workflowId: 'wf1',
  stageId: 'meeting',
  kind: 'stage',
  templateGateId: 'conclusion',
  stageKind: 'meeting',
  optional: true,
  title: 'Conclusion',
  status: 'open',
  version: 2,
  options: [],
  content: { type: 'conclusion', artifactId: 'a1', renderedHash: hash },
  openedAt: at,
  conclusion: {
    original: conclusion,
    renderedHash: hash,
    githubBodyHash: 'b'.repeat(64),
    githubUpdatedAt: at,
    changedOnGithub: true,
    githubBody: '## Summary\nEdited',
  },
};
const escalationGate = {
  gateId: 'g2',
  workflowId: 'wf1',
  stageId: 'implement',
  kind: 'exception',
  exceptionKind: 'question-escalation',
  title: 'Question',
  status: 'approved',
  version: 1,
  options: [{ optionId: 'abort', label: 'Abort' }],
  content: { type: 'exception', summary: 'Which DB?', questionId: 'q1' },
  openedAt: at,
  questionId: 'q1',
  decision: { decision: 'answer', by: 'user', at },
};
const question = {
  questionId: 'q1',
  workflowId: 'wf1',
  attemptId: 'att1',
  seatId: 'wf1:engineer:w1',
  role: 'engineer',
  itemKey: 'w1',
  body: 'Which DB?',
  status: 'answered',
  askedAt: at,
  forwardedTo: 'on-call',
  escalation: { reason: 'timeout', gateId: 'g2', at, options: [] },
  answer: { by: 'user', body: 'SQLite', at },
};
const readModel = {
  workflowId: 'wf1',
  shortId: 'abcd',
  template,
  repo,
  requirement: 'Build',
  integrationBranch: 'ai-office/abcd-build',
  roleOverrides: {},
  gateToggles: {},
  budgets: {
    stages: { meeting: { tokens: 1000 } },
    hardLimitMultiplier: 2,
  },
  limits: { globalAgents: 4 },
  status: 'running',
  pausedReasons: ['budget'],
  cancelRequested: false,
  startedAt: at,
  currentStageId: 'implement',
  stages: [
    {
      stageId: 'meeting',
      kind: 'meeting',
      status: 'done',
      runs: [
        {
          attempt: 1,
          mode: 'initial',
          startedAt: at,
          endedAt: at,
          outcome: 'completed',
        },
      ],
      gateId: 'g1',
      meeting: {
        round: 1,
        maxRounds: 2,
        concluded: true,
        statements: [
          {
            round: 1,
            role: 'pm',
            attemptId: 'att0',
            artifactId: 'a0',
            position: 'Agree',
            readyToConclude: true,
            at,
          },
        ],
      },
      usage,
    },
    {
      stageId: 'implement',
      kind: 'implement',
      status: 'running',
      runs: [{ attempt: 1, mode: 'initial', startedAt: at }],
      oncall: { active: true, attemptId: 'att9', queue: ['q1'], current: 'q1' },
      usage,
    },
    {
      stageId: 'integrate',
      kind: 'integrate',
      status: 'pending',
      runs: [],
      usage: { ...usage, budgetTokens: 0 },
    },
  ],
  gates: [conclusionGate, escalationGate],
  seats: [seat],
  workItems: [
    {
      key: 'w1',
      title: 'Build',
      body: '',
      acceptance: [],
      role: 'engineer',
      agent: 'codex',
      deps: [],
      status: 'pr_open',
      attempts: 1,
      currentAttemptId: 'att1',
      seatId: 'wf1:engineer:w1',
      branch: 'ai-office/abcd/w1',
      issue: { number: 3 },
      pr,
      usage,
    },
  ],
  questions: [question],
  artifacts: [
    { artifactId: 'a1', kind: 'conclusion', at, submissionId: 's1' },
    {
      artifactId: 'a2',
      kind: 'pr',
      at,
      number: 7,
      url: 'https://github.com/octo/app/pull/7',
      purpose: 'worker',
      itemKey: 'w1',
    },
  ],
  prs: [pr],
  usage: {
    total: usage,
    byStage: { meeting: usage },
    byAgent: { codex: usage },
    bySeat: { 'wf1:engineer:w1': usage },
  },
  budgetBars: [
    {
      scope: 'stage',
      stageId: 'implement',
      metric: 'tokens',
      used: 1200,
      budget: 1000,
      hardLimit: 2000,
      level: 'exceeded',
    },
  ],
  errors: [
    {
      seq: 9,
      at,
      category: 'suspect_escalation',
      code: 'turn_start_unobserved',
      message: 'Escalation',
    },
  ],
  anomalies: [
    {
      kind: 'policy-hit',
      severity: 'high',
      summary: 'gh pr merge',
      seq: 10,
      at,
    },
  ],
  lastSeq: 42,
};
const repoView = {
  ...repo,
  status: 'registered',
  issues: [],
  registeredAt: at,
  updatedAt: at,
};
const healthy = { status: 'healthy', breaker: 'closed' } as const;
const domainEvent = {
  seq: 1,
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  occurredAt: at,
  recordedAt: at,
  workflowId: null,
  source: 'system',
  provenance: 'observed',
  schemaVersion: 1,
  type: 'health.changed',
  payload: { component: 'runtime', status: 'healthy' },
};

// One response example per endpoint (M1-T2 acceptance).
const responses: Record<(typeof apiEndpoints)[number]['operationId'], unknown> =
  {
    bootstrap: null,
    getHealth: {
      status: 'healthy',
      runtime: {
        ...healthy,
        mode: 'fake',
        verified: true,
        shim: { status: 'ok' },
        runOwned: true,
        cliCallsPerMinute: 3,
      },
      scm: {
        ...healthy,
        login: 'octo',
        rateLimit: { limit: 5000, remaining: 4999, resetAt: at },
      },
      store: healthy,
      usage: {
        ...healthy,
        sources: [{ agent: 'codex', source: 'rollout', available: true }],
      },
      adapters: [{ adapter: 'scm-github', calls: 3, failures: 0 }],
    },
    listRepos: { repos: [repoView] },
    registerRepo: repoView,
    getRepo: { ...repoView, status: 'invalid', issues: ['not in Orca'] },
    listTemplates: { valid: [template], invalid: [] },
    getTemplate: {
      valid: [],
      invalid: [{ file: 'x.yaml', issues: [{ path: 'id', message: 'bad' }] }],
    },
    listWorkflows: {
      workflows: [
        {
          workflowId: 'wf1',
          shortId: 'abcd',
          templateId: 'feature-to-pr',
          templateName: 'Feature to PR',
          repoId: 'r1',
          repoFullName: 'octo/app',
          requirement: 'Build',
          status: 'running',
          pausedReasons: [],
          currentStageId: 'implement',
          currentStageKind: 'implement',
          progress: { stagesDone: 2, stagesTotal: 5 },
          openGates: 1,
          escalatedQuestions: 0,
          budgetTokens: 1500,
          startedAt: at,
        },
      ],
    },
    startWorkflow: { workflowId: 'wf1' },
    getWorkflow: { readModel, asOfSeq: 42 },
    listEvents: { events: [domainEvent], nextAfterSeq: 1 },
    cancelWorkflow: { accepted: true },
    cleanupWorkflow: { accepted: true },
    listGates: { gates: [conclusionGate] },
    getGate: {
      ...conclusionGate,
      stageId: 'planning',
      templateGateId: 'plan',
      stageKind: 'planning',
      content: { type: 'work-items', artifactId: 'a3' },
      conclusion: undefined,
      workItems: readModel.workItems.map(
        ({ key, title, body, acceptance, role, deps }) => ({
          key,
          title,
          body,
          acceptance,
          role,
          deps,
        }),
      ),
      editable: ['title', 'agent'],
    },
    decideGate: { accepted: true },
    listQuestions: { questions: [{ ...question, status: 'escalated' }] },
    answerQuestion: { accepted: true },
    getSeat: seat,
    messageSeat: { accepted: true },
    streamEvents: { event: 'domain', id: '1', data: domainEvent },
    submitAgent: { status: 'accepted', submissionId: 's1' },
  };

describe('endpoint responses', () => {
  test('every endpoint has an example', () =>
    expect(Object.keys(responses).sort()).toEqual(
      apiEndpoints.map((endpoint) => endpoint.operationId).sort(),
    ));
  test.each(apiEndpoints.map((endpoint) => [endpoint.operationId, endpoint]))(
    '%s response parses',
    (operationId, endpoint) => {
      const value = JSON.parse(
        JSON.stringify(responses[operationId]) ?? 'null',
      );
      const result = (endpoint.response as z.ZodType).safeParse(value);
      expect(result.error).toBeUndefined();
    },
  );
  test('no endpoint uses an untyped record response', () => {
    for (const endpoint of apiEndpoints)
      expect((endpoint.response as z.ZodType).safeParse({}).success).toBe(
        false,
      );
  });
});

describe('read model', () => {
  test('gate status has only the §4 states', () =>
    expect(GateStatusSchema.options).toEqual([
      'open',
      'approved',
      'revised',
      'rejected',
      'closed',
    ]));
  test('questions have no expired status (Q10)', () =>
    expect(
      QuestionViewSchema.safeParse({ ...question, status: 'expired' }).success,
    ).toBe(false));
  test('seat activity is capped at the recent limit', () =>
    expect(
      SeatViewSchema.safeParse({
        ...seat,
        recentActivity: Array.from(
          { length: SEAT_RECENT_ACTIVITY_LIMIT + 1 },
          () => seat.recentActivity[0],
        ),
      }).success,
    ).toBe(false));
  test('on-call attempts carry the oncall flag (Q10)', () => {
    const withoutFlag: Partial<typeof attempt> = { ...attempt };
    delete withoutFlag.oncall;
    expect(
      SeatViewSchema.safeParse({ ...seat, attempts: [withoutFlag] }).success,
    ).toBe(false);
  });
  test('rejects unknown agent kinds in usage by agent', () =>
    expect(
      WorkflowReadModelSchema.safeParse({
        ...readModel,
        usage: { ...readModel.usage, byAgent: { gemini: usage } },
      }).success,
    ).toBe(false));
});

describe('gate decision request', () => {
  const base = { decision: 'approve', expectedVersion: 2 };
  test('accepts body hash and typed edits (Q1)', () => {
    expect(
      GateDecisionRequestSchema.parse({ ...base, githubBodyHash: hash }),
    ).toEqual({ ...base, githubBodyHash: hash });
    expect(
      GateDecisionRequestSchema.safeParse({
        ...base,
        decision: 'revise',
        githubBodyHash: hash,
        edits: { type: 'conclusion', conclusion },
      }).success,
    ).toBe(true);
    expect(
      GateDecisionRequestSchema.safeParse({
        ...base,
        decision: 'option',
        optionId: 'top-up',
        additionalTokens: 5000,
      }).success,
    ).toBe(true);
  });
  test.each([
    ['answer decision', { decision: 'answer' }],
    ['malformed body hash', { githubBodyHash: 'abc' }],
    ['untyped edits', { edits: { title: 'x' } }],
    ['version zero', { expectedVersion: 0 }],
  ])('rejects %s', (_, patch) =>
    expect(
      GateDecisionRequestSchema.safeParse({ ...base, ...patch }).success,
    ).toBe(false),
  );
});

describe('error response', () => {
  test('uses all 12 event error categories', () => {
    for (const category of ErrorCategorySchema.options)
      expect(
        ErrorResponseSchema.safeParse({
          error: { code: 'x', category, message: '', retryable: false },
        }).success,
      ).toBe(true);
    expect(ErrorCategorySchema.options).toContain('suspect_escalation');
  });
  test('lists the known codes with valid categories', () => {
    expect(API_ERROR_CODES).toEqual(
      expect.arrayContaining([
        'workflow_slot_busy',
        'gate_content_changed',
        'version_conflict',
        'template_invalid',
        'runtime_unverified_ack_required',
        'not_found',
        'unauthorized',
        'forbidden_origin',
      ]),
    );
    for (const { status, category } of Object.values(API_ERRORS)) {
      expect(ErrorCategorySchema.options).toContain(category);
      expect(status).toBeGreaterThanOrEqual(400);
    }
    expect(API_ERRORS.gate_content_changed.status).toBe(409);
    expect(API_ERRORS.runtime_unverified_ack_required.status).toBe(428);
  });
});
