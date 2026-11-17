import type { BudgetBar, TokenUsage } from '@ai-office/contracts/api';
import type { DomainEvent } from '@ai-office/contracts/events';
import { emptyUsage, findAttempt, lookup, type ReadModel } from './model.js';

function add(target: TokenUsage, delta: TokenUsage): void {
  for (const key of Object.keys(delta) as (keyof TokenUsage)[])
    target[key] += delta[key];
}
export function applyUsage(m: ReadModel, e: DomainEvent): void {
  if (e.type !== 'usage.tokens' && e.type !== 'usage.turns') return;
  const found = findAttempt(m, e.payload.attemptId);
  if (!found) return;
  const { seat, attempt } = found;
  const delta = emptyUsage();
  if (e.type === 'usage.tokens') {
    const p = e.payload;
    Object.assign(delta, {
      inputUncached: p.inputUncached,
      output: p.output,
      cacheRead: p.cacheRead,
      cacheWrite: p.cacheWrite,
      reasoning: p.reasoning ?? 0,
      budgetTokens: p.budgetTokens,
    });
  } else delta.turns = e.payload.turns;
  add(attempt.usage, delta);
  add(seat.usage, delta);
  add(m.usage.total, delta);
  const stage = m.stages.find((s) => s.stageId === attempt.stageId);
  if (stage) add(stage.usage, delta);
  const item = m.workItems.find((w) => w.key === attempt.itemKey);
  if (item) add(item.usage, delta);
  m.usage.byStage = {
    ...m.usage.byStage,
    [attempt.stageId]: {
      ...(lookup(m.usage.byStage, attempt.stageId) ?? emptyUsage()),
    },
  };
  add(m.usage.byStage[attempt.stageId]!, delta);
  m.usage.byAgent = {
    ...m.usage.byAgent,
    [attempt.agent]: { ...(m.usage.byAgent[attempt.agent] ?? emptyUsage()) },
  };
  add(m.usage.byAgent[attempt.agent]!, delta);
  m.usage.bySeat = { ...m.usage.bySeat, [seat.seatId]: { ...seat.usage } };
}

/** Budgets use only recorded usage/time; never wall-clock time during replay. */
export function refreshBudgets(m: ReadModel, e: DomainEvent): void {
  const bars: BudgetBar[] = [];
  const bar = (
    scope: BudgetBar['scope'],
    metric: BudgetBar['metric'],
    used: number,
    budget: number,
    stageId?: string,
    itemKey?: string,
  ) => {
    const previous = m.budgetBars.find(
      (b) =>
        b.scope === scope &&
        b.metric === metric &&
        b.stageId === stageId &&
        b.itemKey === itemKey,
    );
    budget = previous?.budget ?? budget;
    used = Math.max(used, previous?.used ?? 0);
    const hardLimit = Math.ceil(budget * m.budgets.hardLimitMultiplier);
    bars.push({
      scope,
      metric,
      used,
      budget,
      hardLimit,
      ...(previous?.gateId === undefined ? {} : { gateId: previous.gateId }),
      level:
        used >= hardLimit ? 'hard_limit' : used >= budget ? 'exceeded' : 'ok',
      ...(stageId === undefined ? {} : { stageId }),
      ...(itemKey === undefined ? {} : { itemKey }),
    });
  };
  if (m.budgets.workflow)
    bar(
      'workflow',
      'tokens',
      m.usage.total.budgetTokens,
      m.budgets.workflow.tokens,
    );
  for (const stage of m.stages) {
    const budget = lookup(m.budgets.stages, stage.stageId);
    if (!budget) continue;
    bar(
      'stage',
      'tokens',
      stage.usage.budgetTokens,
      budget.tokens,
      stage.stageId,
    );
    if (budget.maxTurns !== undefined)
      bar('stage', 'turns', stage.usage.turns, budget.maxTurns, stage.stageId);
    const config = m.template.stages.find((s) => s.id === stage.stageId);
    const run = stage.runs.at(-1);
    if (
      config &&
      'timeouts' in config &&
      'stageMin' in config.timeouts &&
      run
    ) {
      const used = Math.max(
        0,
        Date.parse(run.endedAt ?? e.occurredAt) - Date.parse(run.startedAt),
      );
      bar(
        'stage',
        'wallclock',
        used,
        config.timeouts.stageMin * 60000,
        stage.stageId,
      );
    }
    if (stage.kind === 'implement' && budget.perItem)
      for (const item of m.workItems) {
        bar(
          'item',
          'tokens',
          item.usage.budgetTokens,
          budget.perItem.tokens,
          stage.stageId,
          item.key,
        );
        if (budget.perItem.maxTurns !== undefined)
          bar(
            'item',
            'turns',
            item.usage.turns,
            budget.perItem.maxTurns,
            stage.stageId,
            item.key,
          );
      }
  }
  // Keep observations for scopes whose definition or owning entity is unavailable.
  for (const old of m.budgetBars) {
    if (
      !bars.some(
        (b) =>
          b.scope === old.scope &&
          b.stageId === old.stageId &&
          b.itemKey === old.itemKey &&
          b.metric === old.metric,
      )
    )
      bars.push(old);
  }
  if (e.type === 'budget.exceeded' || e.type === 'budget.hard_limit') {
    const p = e.payload;
    const observed: BudgetBar = {
      scope: p.scope,
      metric: p.metric,
      used: p.used,
      budget: p.budget,
      hardLimit:
        e.type === 'budget.hard_limit'
          ? p.threshold
          : Math.ceil(p.budget * m.budgets.hardLimitMultiplier),
      level: e.type === 'budget.hard_limit' ? 'hard_limit' : 'exceeded',
      ...(p.gateId === undefined ? {} : { gateId: p.gateId }),
      ...('stageId' in p ? { stageId: p.stageId } : {}),
      ...('itemKey' in p ? { itemKey: p.itemKey } : {}),
    };
    const index = bars.findIndex(
      (b) =>
        b.scope === observed.scope &&
        b.stageId === observed.stageId &&
        b.itemKey === observed.itemKey &&
        b.metric === observed.metric,
    );
    if (index < 0) bars.push(observed);
    else bars[index] = observed;
  }
  m.budgetBars = bars;
}
