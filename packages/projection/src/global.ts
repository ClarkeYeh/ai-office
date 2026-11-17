import { clone } from './model.js';
import type {
  GateView,
  HealthView,
  QuestionView,
  RepoView,
  WorkflowSummary,
} from '@ai-office/contracts/api';
import type { DomainEvent } from '@ai-office/contracts/events';
import { evolve } from './evolve.js';
import { lookup, summarizeWorkflow, type ReadModel } from './model.js';

/** Global SSE fold; all fields are JSON-serializable, including checkpoint state. */
export interface GlobalReadModel {
  lastSeq: number;
  workflows: Record<string, ReadModel>;
  workflowList: WorkflowSummary[];
  gateInbox: GateView[];
  escalatedQuestions: QuestionView[];
  repos: RepoView[];
  health: HealthView;
}
export function initialGlobalReadModel(
  runtimeMode: 'orca' | 'fake' = 'orca',
): GlobalReadModel {
  return {
    lastSeq: 0,
    workflows: {},
    workflowList: [],
    gateInbox: [],
    escalatedQuestions: [],
    repos: [],
    health: {
      status: 'degraded',
      runtime: { status: 'degraded', mode: runtimeMode, verified: false },
      scm: { status: 'degraded' },
      store: { status: 'degraded' },
      usage: { status: 'degraded', sources: [] },
      adapters: [],
    },
  };
}

export function evolveGlobal(
  model: GlobalReadModel,
  event: DomainEvent,
): GlobalReadModel {
  if (event.seq <= model.lastSeq) return model;
  const next = clone(model);
  const e = clone(event);
  next.lastSeq = e.seq;
  if (e.workflowId !== null) {
    const workflow = evolve(lookup(next.workflows, e.workflowId) ?? null, e);
    if (workflow)
      next.workflows = { ...next.workflows, [e.workflowId]: workflow };
  }
  switch (e.type) {
    case 'repo.registered': {
      if (!next.repos.some((r) => r.repoId === e.payload.repoId))
        next.repos.push({
          ...e.payload,
          status: 'registered',
          issues: [],
          registeredAt: e.occurredAt,
          updatedAt: e.occurredAt,
        });
      break;
    }
    case 'repo.updated': {
      const repo = next.repos.find((r) => r.repoId === e.payload.repoId);
      if (repo) Object.assign(repo, e.payload, { updatedAt: e.occurredAt });
      break;
    }
    case 'health.changed': {
      const p = e.payload;
      const component = next.health[p.component];
      component.status = p.status;
      component.checkedAt = e.occurredAt;
      if (p.breaker !== undefined) component.breaker = p.breaker;
      if (p.detail === undefined) delete component.detail;
      else component.detail = p.detail;
      if (p.component === 'runtime' && p.runtimeVerified !== undefined)
        next.health.runtime.verified = p.runtimeVerified;
      break;
    }
    case 'runtime.identity_restored':
      next.health.runtime.shim = { status: 'ok', location: e.payload.newShim };
      next.health.runtime.runOwned = true;
      break;
    case 'runtime.identity_hijacked':
      next.health.runtime.runOwned = false;
      next.health.runtime.status = 'unhealthy';
      next.health.runtime.checkedAt = e.occurredAt;
      break;
  }
  const statuses = [
    next.health.runtime,
    next.health.scm,
    next.health.store,
    next.health.usage,
  ].map((c) => c.status);
  next.health.status = statuses.includes('unhealthy')
    ? 'unhealthy'
    : statuses.includes('degraded')
      ? 'degraded'
      : 'healthy';
  const workflows = Object.values(next.workflows);
  next.workflowList = workflows.map(summarizeWorkflow);
  next.gateInbox = workflows.flatMap((w) =>
    w.gates.filter((g) => g.status === 'open'),
  );
  next.escalatedQuestions = workflows.flatMap((w) =>
    w.questions.filter((q) => q.status === 'escalated'),
  );
  return next;
}
