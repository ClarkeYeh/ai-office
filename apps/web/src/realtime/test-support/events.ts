// Schema-valid domain events for realtime tests (a small subset of the catalog).
import {
  DomainEventSchema,
  type DomainEvent,
  type EventType,
} from '@ai-office/contracts/events';

export const at = '2026-11-18T00:00:00.000Z';

const started = (shortId: string) => ({
  templateSnapshot: {
    apiVersion: 'ai-office/v1alpha1',
    id: 'flow',
    name: 'Flow',
    roles: { lead: { agent: 'claude-code' }, engineer: { agent: 'codex' } },
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
  },
  repo: {
    repoId: 'r1',
    localPath: '/repo',
    orcaRepoId: 'orca-1',
    github: { owner: 'octo', name: 'demo' },
    defaultBranch: 'main',
    visibility: 'public',
    ownerLogin: 'octo',
    defaultBranchProtected: 'unknown',
  },
  requirement: 'Add login',
  shortId,
  integrationBranch: `ai-office/${shortId}-add-login`,
  roleOverrides: {},
  gateToggles: {},
  budgets: { stages: { meeting: { tokens: 1000 } }, hardLimitMultiplier: 2 },
  limits: { globalAgents: 10 },
  acknowledgedUnverifiedRuntime: false,
});

export function domainEvent(
  type: EventType,
  seq: number,
  payload: unknown,
  workflowId: string | null = 'wf1',
  occurredAt = at,
  recordedAt = occurredAt,
): DomainEvent {
  return DomainEventSchema.parse({
    seq,
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    occurredAt,
    recordedAt,
    workflowId,
    source: 'engine',
    provenance: 'decided',
    schemaVersion: 1,
    type,
    payload,
  });
}

export const workflowStarted = (seq: number, workflowId = 'wf1') =>
  domainEvent(
    'workflow.started',
    seq,
    started(`${workflowId}abcd`.slice(0, 8)),
    workflowId,
  );

export const seatSpawned = (
  seq: number,
  attemptId: string,
  workflowId = 'wf1',
) =>
  domainEvent(
    'seat.spawned',
    seq,
    {
      seatId: `${workflowId}:engineer:${attemptId}`,
      attemptId,
      attempt: 1,
      stageId: 'implement',
      role: 'engineer',
      itemKey: attemptId,
      agent: 'codex',
      purpose: 'worker',
      keepOpen: false,
      spawnCommandId: `c-${attemptId}`,
    },
    workflowId,
  );

export const usageTokens = (
  seq: number,
  attemptId: string,
  workflowId = 'wf1',
  occurredAt = at,
) =>
  domainEvent(
    'usage.tokens',
    seq,
    {
      attemptId,
      inputUncached: seq,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      budgetTokens: seq + 1,
    },
    workflowId,
    occurredAt,
  );

export const healthChanged = (seq: number) =>
  domainEvent(
    'health.changed',
    seq,
    { component: 'runtime', status: 'degraded', breaker: 'half_open' },
    null,
  );

/** started, one seat, then `count - 2` token updates: every event changes the model. */
export function workflowEvents(
  count: number,
  workflowId = 'wf1',
  firstSeq = 1,
  step = 1,
): DomainEvent[] {
  const events = [workflowStarted(firstSeq, workflowId)];
  if (count > 1) events.push(seatSpawned(firstSeq + step, 'a1', workflowId));
  for (let i = 2; i < count; i++)
    events.push(usageTokens(firstSeq + i * step, 'a1', workflowId));
  return events;
}
