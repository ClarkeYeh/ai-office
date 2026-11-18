import { expect, test } from 'vitest';
import { WorkflowReadModelSchema } from '@ai-office/contracts/api';
import { evolve, replay } from './index.js';
import { event, payloads } from './test-support/events.js';
import { scenario } from './test-support/scenario.js';

const start = {
  ...payloads['workflow.started'],
  budgets: {
    workflow: { tokens: 100 },
    stages: {
      meeting: { tokens: 50, maxTurns: 2 },
      implement: { tokens: 300, perItem: { tokens: 100, maxTurns: 3 } },
    },
    hardLimitMultiplier: 2,
  },
};
const open = (gateId: string) => ({
  ...payloads['gate.opened'],
  gateId,
  kind: 'exception',
  exceptionKind: 'budget-exceeded',
  stageId: 'meeting',
  content: { type: 'exception', summary: 'Budget' },
});

test('budget bars derive token, turn and recorded elapsed-time usage at all scopes', () => {
  const s = scenario(start);
  s.push('stage.started');
  s.push('workitem.proposed');
  s.push('seat.spawned', {
    ...payloads['seat.spawned'],
    stageId: 'meeting',
    itemKey: 'w1',
  });
  s.push('usage.tokens', { ...payloads['usage.tokens'], budgetTokens: 60 });
  s.push('usage.turns', { attemptId: 'a1', turns: 3 });
  expect(
    s.model.budgetBars.find(
      (b) =>
        b.scope === 'stage' && b.metric === 'tokens' && b.stageId === 'meeting',
    ),
  ).toMatchObject({ used: 60, level: 'exceeded' });
  expect(
    s.model.budgetBars.find((b) => b.scope === 'stage' && b.metric === 'turns'),
  ).toMatchObject({ used: 3, level: 'exceeded' });
  expect(
    s.model.budgetBars.find((b) => b.scope === 'item' && b.metric === 'turns'),
  ).toMatchObject({ used: 3, level: 'exceeded' });
  s.push('usage.tokens', { ...payloads['usage.tokens'], budgetTokens: 140 });
  expect(s.model.budgetBars.find((b) => b.scope === 'workflow')).toMatchObject({
    used: 200,
    level: 'hard_limit',
  });
  s.push('timer.fired', undefined, { occurredAt: '2026-11-17T01:00:00Z' });
  expect(
    s.model.budgetBars.find((b) => b.metric === 'wallclock'),
  ).toMatchObject({ used: 3600000, level: 'exceeded' });
  s.push('stage.completed', undefined, { occurredAt: '2026-11-17T01:00:00Z' });
  s.push('timer.fired', undefined, { occurredAt: '2026-11-17T02:00:00Z' });
  expect(s.model.budgetBars.find((b) => b.metric === 'wallclock')?.used).toBe(
    3600000,
  );
  s.push('seat.spawned', {
    ...payloads['seat.spawned'],
    attemptId: 'orphan',
    stageId: 'missing',
  });
  s.push('usage.turns', { attemptId: 'orphan', turns: 1 });
  expect(s.model.usage.byStage.missing?.turns).toBe(1);
});

test('top-ups use persisted gate links, survive snapshot/replay and isolate items and scopes', () => {
  const s = scenario(start);
  s.push('workitem.proposed', {
    ...payloads['workitem.proposed'],
    items: [
      payloads['workitem.proposed'].items[0],
      { ...payloads['workitem.proposed'].items[0], key: 'w2' },
    ],
  });
  s.push('budget.exceeded', {
    scope: 'workflow',
    metric: 'tokens',
    used: 120,
    budget: 100,
    threshold: 100,
    gateId: 'workflow-budget',
  });
  s.push('budget.exceeded', {
    ...payloads['budget.exceeded'],
    gateId: 'item-budget',
  });
  s.push('budget.hard_limit', {
    ...payloads['budget.hard_limit'],
    gateId: 'stage-budget',
  });
  for (const gateId of [
    'workflow-budget',
    'item-budget',
    'stage-budget',
    'unlinked',
  ])
    s.push('gate.opened', open(gateId));
  let snapshot = WorkflowReadModelSchema.parse(
    JSON.parse(JSON.stringify(s.model)),
  );
  for (const gateId of [
    'workflow-budget',
    'item-budget',
    'stage-budget',
    'unlinked',
  ]) {
    const e = event('gate.decided', s.events.length + 1, {
      gateId,
      decision: 'option',
      optionId: 'top-up',
      by: 'user',
      version: 1,
      additionalTokens: 50,
    });
    snapshot = evolve(snapshot, e);
    s.push('gate.decided', e.payload);
  }
  expect(snapshot).toEqual(s.model);
  expect(replay(s.events)).toEqual(snapshot);
  const bars = snapshot.budgetBars;
  expect(bars.find((b) => b.scope === 'workflow')).toMatchObject({
    budget: 150,
    hardLimit: 300,
    level: 'ok',
    gateId: 'workflow-budget',
  });
  expect(
    bars.find((b) => b.itemKey === 'w1' && b.metric === 'tokens'),
  ).toMatchObject({ budget: 150, level: 'ok' });
  expect(
    bars.find((b) => b.itemKey === 'w2' && b.metric === 'tokens')?.budget,
  ).toBe(100);
  expect(bars.find((b) => b.gateId === 'stage-budget')).toMatchObject({
    budget: 1050,
    hardLimit: 2100,
    level: 'exceeded',
  });
  expect(snapshot.budgets).toEqual(start.budgets);
  s.push('timer.fired');
  expect(s.model.budgetBars).toEqual(bars);
  // A subsequent observed threshold is authoritative and can attach the next gate.
  s.push('budget.hard_limit', {
    scope: 'workflow',
    metric: 'tokens',
    used: 300,
    budget: 150,
    threshold: 300,
    gateId: 'next',
  });
  expect(s.model.budgetBars.find((b) => b.scope === 'workflow')).toMatchObject({
    gateId: 'next',
    level: 'hard_limit',
  });
  s.push('gate.opened', open('next'));
  s.push('gate.decided', {
    gateId: 'next',
    decision: 'option',
    by: 'user',
    version: 1,
    additionalTokens: 1,
  });
  expect(s.model.budgetBars.find((b) => b.scope === 'workflow')?.level).toBe(
    'exceeded',
  );
  // Equal-to-hard-limit keeps the hard-limit level when multiplier is one.
  const one = scenario({
    ...start,
    budgets: { ...start.budgets, hardLimitMultiplier: 1 },
  });
  one.push('budget.hard_limit', {
    scope: 'workflow',
    metric: 'tokens',
    used: 300,
    budget: 100,
    threshold: 100,
    gateId: 'one',
  });
  one.push('gate.opened', open('one'));
  one.push('gate.decided', {
    gateId: 'one',
    decision: 'option',
    by: 'user',
    version: 1,
    additionalTokens: 10,
  });
  expect(one.model.budgetBars.find((b) => b.scope === 'workflow')?.level).toBe(
    'hard_limit',
  );
});

test('S25: enforcement off shows usage-only bars; wallclock timeouts stay enforced', () => {
  const s = scenario({
    ...start,
    limits: { globalAgents: 10, budgetEnforcement: 'off' },
  });
  s.push('stage.started');
  s.push('seat.spawned', {
    ...payloads['seat.spawned'],
    stageId: 'meeting',
    itemKey: 'w1',
  });
  s.push('usage.tokens', { ...payloads['usage.tokens'], budgetTokens: 500 });
  s.push('usage.turns', { attemptId: 'a1', turns: 9 });
  s.push('timer.fired', undefined, { occurredAt: '2026-11-17T01:00:00Z' });
  const bars = s.model.budgetBars;
  for (const bar of bars.filter((b) => b.metric !== 'wallclock'))
    expect(bar).toMatchObject({ enforcement: 'off', level: 'ok' });
  expect(bars.find((b) => b.scope === 'workflow')).toMatchObject({
    used: 500,
    budget: 100,
  });
  const clock = bars.find((b) => b.metric === 'wallclock');
  expect(clock).toMatchObject({ level: 'exceeded' });
  expect(clock).not.toHaveProperty('enforcement');
});

test('S25: on carries the snapshot; older snapshots without it are unchanged', () => {
  const on = scenario({
    ...start,
    limits: { globalAgents: 10, budgetEnforcement: 'on' },
  });
  on.push('usage.tokens', { ...payloads['usage.tokens'], budgetTokens: 500 });
  const old = scenario(start);
  old.push('usage.tokens', { ...payloads['usage.tokens'], budgetTokens: 500 });
  expect(on.model.budgetBars.every((b) => b.enforcement === 'on')).toBe(true);
  expect(old.model.budgetBars.some((b) => 'enforcement' in b)).toBe(false);
  expect(
    on.model.budgetBars.map((b) => {
      const copy = { ...b };
      delete copy.enforcement;
      return copy;
    }),
  ).toEqual(old.model.budgetBars);
});
