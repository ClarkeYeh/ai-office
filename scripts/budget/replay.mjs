// Replays exported events through the domain build output (M5 §4.3). Only
// numeric usage fields and ids are read, so B4-masked exports work unchanged.
import {
  decide,
  evolveWithWarning,
  initialState,
} from '../../packages/domain/dist/index.js';

/**
 * @typedef {{ tokens: number, maxTurns?: number, perItem?: { tokens: number, maxTurns?: number } }} StageBudget
 * @typedef {{ stages: Record<string, StageBudget>, workflow?: { tokens: number }, hardLimitMultiplier: number }} Budgets
 * @typedef {{ attemptId: string, stageId: string, stageAttempt: number, itemKey?: string, metric: 'tokens' | 'turns', amount: number }} UsageRecord
 * @typedef {{ type: string, scope: string, metric: string, stageId?: string, itemKey?: string, used: number, threshold: number }} BudgetHit
 * @typedef {{ workflowId: string, stages: { id: string, kind: string, maxParallel?: number }[], budgets: Budgets, events: any[] }} Run
 */

const BUDGET_EVENTS = new Set(['budget.exceeded', 'budget.hard_limit']);

/** @param {any} event */
const isBudgetArtifact = (event) =>
  BUDGET_EVENTS.has(event.type) ||
  (typeof event.type === 'string' &&
    event.type.startsWith('gate.') &&
    typeof event.payload?.gateId === 'string' &&
    event.payload.gateId.startsWith('budget-'));

/**
 * Splits an export (`{ events }` envelope or a bare array) into one run per workflow.
 * @param {unknown} json
 * @returns {Run[]}
 */
export function runsFromExport(json) {
  const events = Array.isArray(json) ? json : /** @type {any} */ (json)?.events;
  if (!Array.isArray(events)) throw new Error('Export has no events array');
  const ordered = events.every((e) => typeof e?.seq === 'number')
    ? [...events].sort((a, b) => a.seq - b.seq)
    : events;
  /** @type {Map<string, any[]>} */
  const byWorkflow = new Map();
  for (const event of ordered) {
    if (typeof event?.workflowId !== 'string') continue;
    const list = byWorkflow.get(event.workflowId) ?? [];
    list.push(event);
    byWorkflow.set(event.workflowId, list);
  }
  const runs = [...byWorkflow].flatMap(([workflowId, list]) => {
    const started = list.find((e) => e.type === 'workflow.started');
    if (started === undefined) return [];
    /** @type {any[]} */
    const stages = started.payload?.templateSnapshot?.stages ?? [];
    return [
      {
        workflowId,
        stages: stages.map((s) => ({
          id: s.id,
          kind: s.kind,
          ...(typeof s.maxParallel === 'number'
            ? { maxParallel: s.maxParallel }
            : {}),
        })),
        budgets: started.payload.budgets,
        events: list,
      },
    ];
  });
  if (runs.length === 0) throw new Error('Export has no workflow.started');
  return runs;
}

/**
 * Folds a run with domain evolve. Recorded budget alerts and budget gates are
 * dropped; with `enforce`, every usage event is re-decided against `budgets`
 * so budget.* events come from the domain rule itself.
 * @param {any[]} events
 * @param {{ budgets?: Budgets, enforce: boolean }} options
 */
export function replayRun(events, { budgets, enforce }) {
  let state = initialState();
  let seq = 0;
  /** @type {UsageRecord[]} */
  const usage = [];
  /** @type {BudgetHit[][]} */
  const hitsPerUsage = [];
  /** @type {string[]} */
  const warnings = [];
  /** @param {any} event */
  const apply = (event) => {
    seq += 1;
    const result = evolveWithWarning(state, {
      id: `replay-${seq}`,
      recordedAt: event.occurredAt,
      ...event,
      seq,
    });
    state = result.state;
    if (result.warning !== undefined)
      warnings.push(`${result.warning.type ?? '?'}: ${result.warning.code}`);
  };
  for (const original of events) {
    if (isBudgetArtifact(original)) continue;
    let event = original;
    if (event.type === 'workflow.started') {
      event = {
        ...event,
        payload: {
          ...event.payload,
          ...(budgets === undefined ? {} : { budgets }),
          limits: {
            ...event.payload.limits,
            budgetEnforcement: enforce ? 'on' : 'off',
          },
        },
      };
    }
    if (event.type !== 'usage.tokens' && event.type !== 'usage.turns') {
      apply(event);
      continue;
    }
    const metric = event.type === 'usage.tokens' ? 'tokens' : 'turns';
    const attempt = state.attempts[event.payload.attemptId];
    if (attempt !== undefined)
      usage.push({
        attemptId: attempt.attemptId,
        stageId: attempt.stageId,
        stageAttempt: attempt.stageAttempt,
        ...(attempt.itemKey === undefined ? {} : { itemKey: attempt.itemKey }),
        metric,
        amount:
          metric === 'tokens'
            ? event.payload.budgetTokens
            : event.payload.turns,
      });
    else warnings.push(`${event.type}: unknown_attempt`);
    /** @type {any[]} */
    let alerts = [];
    if (enforce && attempt !== undefined) {
      const decided = decide(state, {
        type: metric === 'tokens' ? 'RecordUsageTokens' : 'RecordUsageTurns',
        meta: {
          occurredAt: event.occurredAt,
          source: event.source ?? 'runtime',
        },
        usage: event.payload,
      });
      if (decided.ok)
        alerts = decided.events.filter((e) => BUDGET_EVENTS.has(e.type));
      else warnings.push(`${event.type}: ${decided.error.code}`);
    }
    apply(event);
    alerts.forEach(apply);
    hitsPerUsage.push(
      alerts.map((a) => ({
        type: a.type,
        scope: a.payload.scope,
        metric: a.payload.metric,
        ...(a.payload.stageId === undefined
          ? {}
          : { stageId: a.payload.stageId }),
        ...(a.payload.itemKey === undefined
          ? {}
          : { itemKey: a.payload.itemKey }),
        used: a.payload.used,
        threshold: a.payload.threshold,
      })),
    );
  }
  return { state, usage, hits: hitsPerUsage.flat(), hitsPerUsage, warnings };
}

const SYNTHETIC_AT = '2000-01-01T00:00:00.000Z';

/**
 * Criterion 3 (review B6): a synthetic sequence that crosses `budget`, then
 * `budget × hardLimitMultiplier`, independent of how loose the values are.
 * Only the scope under test is configured, so other rules cannot interfere.
 * @param {{ scope: 'item' | 'stage' | 'workflow', metric: 'tokens' | 'turns', stage: { id: string, kind: string }, budget: number, hardLimitMultiplier: number }} spec
 */
export function thresholdMechanism({
  scope,
  metric,
  stage,
  budget,
  hardLimitMultiplier,
}) {
  if (!Number.isSafeInteger(budget) || budget < 2)
    throw new Error(`Budget ${budget} is too small for the mechanism test`);
  const hard = Math.ceil(budget * hardLimitMultiplier);
  if (hard - budget < 2)
    throw new Error(`Hard limit ${hard} must exceed budget ${budget} by 2+`);
  const value = metric === 'tokens' ? 'tokens' : 'maxTurns';
  /** @type {Budgets} */
  const budgets = {
    stages:
      scope === 'workflow'
        ? {}
        : {
            [stage.id]:
              scope === 'item'
                ? // Stage tokens are required by the schema; keep them out of reach.
                  {
                    tokens: Number.MAX_SAFE_INTEGER,
                    perItem: {
                      tokens: Number.MAX_SAFE_INTEGER,
                      [value]: budget,
                    },
                  }
                : { tokens: Number.MAX_SAFE_INTEGER, [value]: budget },
          },
    ...(scope === 'workflow' ? { workflow: { tokens: budget } } : {}),
    hardLimitMultiplier,
  };
  const workflowId = 'wf-threshold';
  const base = { workflowId, occurredAt: SYNTHETIC_AT, source: 'engine' };
  const attemptId = 'att-threshold';
  const events = [
    {
      ...base,
      type: 'workflow.started',
      payload: {
        templateSnapshot: { stages: [stage] },
        budgets,
        limits: { globalAgents: 1 },
      },
    },
    {
      ...base,
      stageId: stage.id,
      type: 'stage.started',
      payload: {
        stageId: stage.id,
        kind: stage.kind,
        attempt: 1,
        mode: 'initial',
      },
    },
    {
      ...base,
      stageId: stage.id,
      type: 'seat.spawned',
      payload: {
        seatId: 'seat-threshold',
        attemptId,
        attempt: 1,
        stageId: stage.id,
        role: 'engineer',
        agent: 'codex',
        purpose: scope === 'item' ? 'worker' : 'participant',
        keepOpen: false,
        ...(scope === 'item' ? { itemKey: 'A' } : {}),
        spawnCommandId: 'cmd-threshold',
      },
    },
    // Cumulative: budget-1, budget, hard-1, hard, hard+1.
    ...[budget - 1, 1, hard - budget - 1, 1, 1].map((delta) => ({
      ...base,
      source: 'runtime',
      stageId: stage.id,
      attemptId,
      type: metric === 'tokens' ? 'usage.tokens' : 'usage.turns',
      payload:
        metric === 'tokens'
          ? {
              attemptId,
              inputUncached: delta,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              budgetTokens: delta,
            }
          : { attemptId, turns: delta },
    })),
  ];
  const { hitsPerUsage, warnings } = replayRun(events, { enforce: true });
  const types = hitsPerUsage.map((hits) =>
    hits.map((h) => `${h.type}:${h.scope}`),
  );
  const expected = [
    [],
    [`budget.exceeded:${scope}`],
    [],
    [`budget.hard_limit:${scope}`],
    [],
  ];
  return {
    scope,
    metric,
    stageId: scope === 'workflow' ? undefined : stage.id,
    budget,
    hard,
    steps: types,
    ok:
      warnings.length === 0 &&
      JSON.stringify(types) === JSON.stringify(expected),
  };
}
