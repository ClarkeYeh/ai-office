import type {
  WorkflowReadModel,
  TokenUsage,
  WorkflowSummary,
} from '@ai-office/contracts/api';
import type { EventOfType } from '@ai-office/contracts/events';

/** Increment when persisted projection semantics change; rebuild older checkpoints. */
export const PROJECTION_VERSION = 1;
export const CHECKPOINT_INTERVAL = 500;
export type ReadModel = WorkflowReadModel;
export const initialReadModel = (): ReadModel | null => null;
export const emptyUsage = (): TokenUsage => ({
  inputUncached: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  budgetTokens: 0,
  turns: 0,
});

export function startWorkflow(
  event: EventOfType<'workflow.started'>,
): ReadModel {
  const p = event.payload;
  return {
    workflowId: event.workflowId!,
    shortId: p.shortId,
    template: p.templateSnapshot,
    repo: p.repo,
    requirement: p.requirement,
    integrationBranch: p.integrationBranch,
    roleOverrides: p.roleOverrides,
    gateToggles: p.gateToggles,
    budgets: p.budgets,
    limits: p.limits,
    status: 'running',
    pausedReasons: [],
    cancelRequested: false,
    startedAt: event.occurredAt,
    currentStageId: null,
    stages: p.templateSnapshot.stages.map((s) => ({
      stageId: s.id,
      kind: s.kind,
      status: 'pending',
      runs: [],
      usage: emptyUsage(),
      ...(s.kind === 'meeting'
        ? {
            meeting: {
              round: 0,
              maxRounds: s.maxRounds,
              concluded: false,
              statements: [],
            },
          }
        : {}),
      ...(s.kind === 'implement'
        ? { oncall: { active: false, queue: [] } }
        : {}),
    })),
    gates: [],
    seats: [],
    workItems: [],
    questions: [],
    artifacts: [],
    prs: [],
    usage: { total: emptyUsage(), byStage: {}, byAgent: {}, bySeat: {} },
    budgetBars: [],
    errors: [],
    anomalies: [],
    acceptedSubmissions: {},
    lastSeq: event.seq,
  };
}

export function summarizeWorkflow(m: ReadModel): WorkflowSummary {
  return {
    workflowId: m.workflowId,
    shortId: m.shortId,
    templateId: m.template.id,
    templateName: m.template.name,
    repoId: m.repo.repoId,
    repoFullName: `${m.repo.github.owner}/${m.repo.github.name}`,
    requirement: m.requirement,
    status: m.status,
    pausedReasons: m.pausedReasons,
    currentStageId: m.currentStageId,
    currentStageKind:
      m.stages.find((s) => s.stageId === m.currentStageId)?.kind ?? null,
    progress: {
      stagesDone: m.stages.filter((s) => s.status === 'done').length,
      stagesTotal: m.stages.length,
    },
    openGates: m.gates.filter((g) => g.status === 'open').length,
    escalatedQuestions: m.questions.filter((q) => q.status === 'escalated')
      .length,
    budgetTokens: m.usage.total.budgetTokens,
    ...(m.budgets.workflow
      ? { workflowBudgetTokens: m.budgets.workflow.tokens }
      : {}),
    startedAt: m.startedAt,
    ...(m.endedAt === undefined ? {} : { endedAt: m.endedAt }),
  };
}

/** Own-property lookup also works for user-defined ids such as `constructor`. */
export function lookup<T>(
  record: Record<string, T>,
  key: string,
): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
export function findAttempt(m: ReadModel, id: string) {
  const seat = m.seats.find((s) => s.attempts.some((a) => a.attemptId === id));
  const attempt = seat?.attempts.find((a) => a.attemptId === id);
  return seat && attempt ? { seat, attempt } : undefined;
}

/** Clone schema-owned JSON data without Node or DOM globals. */
export function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clone(item)]),
    ) as T;
  return value;
}
