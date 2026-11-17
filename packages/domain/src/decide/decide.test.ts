import { describe, expect, test } from 'vitest';
import type { DomainCommand } from '../commands.js';
import { decide } from './index.js';
import { integrationBranchName, slugify } from './workflow.js';
import {
  ATTEMPT_TRANSITIONS,
  budgetAlertKey,
  initialState,
  isAttemptAlive,
  isAttemptPossiblyAlive,
  latestAttempt,
  liveAttempts,
  possiblyLiveAttempts,
  seatState,
  stageByKind,
} from '../state/index.js';
import {
  Harness,
  meta,
  observe,
  spawn,
  startCommand,
  startStage,
  template,
} from '../test-support/fixtures.js';

const started = (command = startCommand()) => {
  const harness = new Harness().given(command);
  const event = harness.events[0];
  if (event?.type !== 'workflow.started') throw new Error('not started');
  return event;
};

describe('StartWorkflow', () => {
  test('snapshots template, repo, limits and applied defaults', () => {
    const event = started();
    expect(event).toMatchObject({
      workflowId: 'wf-1',
      source: 'user',
      provenance: 'decided',
      schemaVersion: 1,
    });
    expect(event.payload).toMatchObject({
      shortId: 'ab12',
      requirement: 'Add dark mode toggle',
      integrationBranch: 'ai-office/ab12-add-dark-mode-toggle',
      roleOverrides: {},
      gateToggles: { conclusion: true, 'task-split': true },
      limits: { globalAgents: 10 },
      acknowledgedUnverifiedRuntime: false,
      budgets: {
        stages: {
          meeting: { tokens: 300_000, maxTurns: 60 },
          implement: {
            tokens: 1_500_000,
            perItem: { tokens: 400_000, maxTurns: 120 },
          },
        },
        workflow: { tokens: 3_000_000 },
        hardLimitMultiplier: 2,
      },
    });
    expect(Object.keys(event.payload.budgets.stages)).toEqual([
      'meeting',
      'breakdown',
      'implement',
      'integrate',
    ]);
  });

  test('applies overrides and toggles', () => {
    const event = started(
      startCommand({
        requirement: '  Ship it  ',
        gateToggles: { conclusion: false },
        acknowledgedUnverifiedRuntime: true,
        budgetOverrides: {
          stages: {
            implement: { perItem: { tokens: 10 } },
            meeting: { tokens: 5 },
          },
          workflowBudget: { tokens: 99 },
          hardLimitMultiplier: 3,
        },
        meta: {
          ...meta(0, 'user'),
          causationId: 'c-1',
          externalKey: 'k-1',
          provenance: 'inferred',
        },
      }),
    );
    expect(event).toMatchObject({
      causationId: 'c-1',
      externalKey: 'k-1',
      provenance: 'inferred',
    });
    expect(event.payload).toMatchObject({
      requirement: 'Ship it',
      gateToggles: { conclusion: false, 'task-split': true },
      acknowledgedUnverifiedRuntime: true,
      budgets: {
        stages: {
          meeting: { tokens: 5, maxTurns: 60 },
          implement: { tokens: 1_500_000, perItem: { tokens: 10 } },
        },
        workflow: { tokens: 99 },
        hardLimitMultiplier: 3,
      },
    });
  });

  test('omits the workflow budget when neither template nor overrides set one', () => {
    const base = template();
    const { workflowBudget: _unused, ...defaults } = base.defaults;
    void _unused;
    const event = started(startCommand({ template: { ...base, defaults } }));
    expect(event.payload.budgets).not.toHaveProperty('workflow');
  });

  test('observed sources default to observed provenance', () => {
    const harness = new Harness().given(
      startCommand(),
      startStage('meeting'),
      spawn('att-1', 'pm'),
    );
    harness.given(observe('att-1', 'working'));
    expect(harness.events.at(-1)).toMatchObject({
      source: 'runtime',
      provenance: 'observed',
      attemptId: 'att-1',
      seatId: 'wf-1:pm',
      stageId: 'meeting',
    });
  });
});

describe('integration branch naming', () => {
  test.each([
    ['Add dark mode toggle', 'add-dark-mode-toggle'],
    ['  --Héllo, Wörld!--  ', 'hello-world'],
    ['新增深色模式', 'feature-to-pr'],
    ['a'.repeat(40), 'a'.repeat(32)],
    [`${'a'.repeat(31)} b`, 'a'.repeat(31)],
  ])('slugify(%j) = %s', (text, slug) => {
    expect(slugify(text, 'feature-to-pr')).toBe(slug);
  });

  test('falls back when both text and fallback are unusable', () => {
    expect(slugify('！！', '？')).toBe('workflow');
    expect(slugify('！！')).toBe('workflow');
  });

  test('is deterministic', () => {
    expect(started().payload.integrationBranch).toBe(
      started().payload.integrationBranch,
    );
  });

  test.each(['ai-office/{shortId}-{slug}', 'ai-office/{slug}/{shortId}'])(
    'accepts %s',
    (pattern) => {
      expect(
        integrationBranchName(pattern, { shortId: 'ab12', slug: 'x' }),
      ).toMatch(/^ai-office\//);
    },
  );

  test.each([
    'feature/{slug}',
    'ai-office/{slug}..{shortId}',
    'ai-office//{slug}',
    'ai-office/{slug}/',
    'ai-office/{slug}.',
    'ai-office/{slug}.lock',
    'ai-office/{unknown}',
    'ai-office/a b',
  ])('rejects %s', (pattern) => {
    expect(
      integrationBranchName(pattern, { shortId: 'ab12', slug: 'x' }),
    ).toMatchObject({
      category: 'validation',
      code: 'invalid_integration_branch',
    });
  });
});

describe('dispatcher', () => {
  const notYet: DomainCommand[] = [
    {
      type: 'RecordUsageTokens',
      meta: meta(),
      usage: {
        attemptId: 'a',
        inputUncached: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        budgetTokens: 0,
      },
    },
    {
      type: 'RecordUsageTurns',
      meta: meta(),
      usage: { attemptId: 'a', turns: 1 },
    },
    {
      type: 'RecordWallclockLimit',
      meta: meta(),
      stageId: 'meeting',
      usedMinutes: 1,
    },
    {
      type: 'AskQuestion',
      meta: meta(),
      questionId: 'q',
      attemptId: 'a',
      body: 'b',
    },
    {
      type: 'ForwardQuestion',
      meta: meta(),
      questionId: 'q',
      to: 'on-call',
      toAttemptId: 'a',
      retry: 0,
    },
    {
      type: 'AnswerQuestion',
      meta: meta(),
      questionId: 'q',
      by: 'user',
      body: 'b',
    },
    {
      type: 'EscalateQuestion',
      meta: meta(),
      questionId: 'q',
      reason: 'timeout',
      gateId: 'g',
    },
    { type: 'DispatchWorkItem', meta: meta(), itemKey: 'i', attemptId: 'a' },
    {
      type: 'UpdateWorkItemStatus',
      meta: meta(),
      update: { itemKey: 'i', status: 'skipped' },
    },
    {
      type: 'EvaluateAnomaly',
      meta: meta(),
      observation: { kind: 'default-branch', sha: 'abcdef1' },
    },
  ];

  test.each(notYet.map((command) => [command.type, command] as const))(
    '%s is routed to its (not yet implemented) partition',
    (_type, command) => {
      expect(decide(initialState(), command)).toEqual({
        ok: false,
        error: {
          category: 'bug',
          code: 'not_implemented',
          message: `${command.type} is not implemented yet`,
          details: { commandType: command.type },
        },
      });
    },
  );
});

describe('state selectors', () => {
  test('seat state follows the latest attempt', () => {
    const harness = new Harness().given(
      startCommand(),
      startStage('meeting'),
      spawn('att-1', 'pm'),
    );
    expect(seatState(harness.state, 'wf-1:pm')).toBe('starting');
    expect(seatState(harness.state, 'wf-1:ghost')).toBeUndefined();
    expect(latestAttempt(harness.state, 'wf-1:ghost')).toBeUndefined();
    expect(liveAttempts(harness.state).map((a) => a.attemptId)).toEqual([
      'att-1',
    ]);
    harness.given(observe('att-1', 'lost'));
    expect(liveAttempts(harness.state)).toEqual([]);
    // §8.1 / N9: lost is not proven stopped.
    expect(possiblyLiveAttempts(harness.state).map((a) => a.attemptId)).toEqual(
      ['att-1'],
    );
    const attempt = harness.state.attempts['att-1'];
    if (attempt === undefined) throw new Error('missing');
    expect(isAttemptAlive({ ...attempt, state: 'idle', released: true })).toBe(
      false,
    );
    expect(isAttemptAlive({ ...attempt, state: 'exited' })).toBe(false);
    expect(isAttemptPossiblyAlive({ ...attempt, released: true })).toBe(false);
    expect(isAttemptPossiblyAlive({ ...attempt, state: 'exited' })).toBe(false);
  });

  test('attempt transitions never leave exited', () => {
    expect(ATTEMPT_TRANSITIONS.exited).toEqual([]);
    for (const targets of Object.values(ATTEMPT_TRANSITIONS))
      expect(targets).not.toContain('starting');
  });

  test('stageByKind and budgetAlertKey', () => {
    const harness = new Harness().given(startCommand());
    expect(stageByKind(harness.state, 'integrate')?.id).toBe('integrate');
    expect(stageByKind(initialState(), 'integrate')).toBeUndefined();
    const base = {
      metric: 'tokens',
      used: 1,
      budget: 1,
      threshold: 1,
    } as const;
    expect(budgetAlertKey({ ...base, scope: 'workflow' }, 'exceeded')).toBe(
      'workflow|exceeded',
    );
    expect(
      budgetAlertKey(
        { ...base, scope: 'stage', stageId: 's', stageAttempt: 2 },
        'hard_limit',
      ),
    ).toBe('stage|s#2|hard_limit');
    expect(
      budgetAlertKey(
        { ...base, scope: 'item', stageId: 's', itemKey: 'k', attemptId: 'a' },
        'exceeded',
      ),
    ).toBe('item|a|exceeded');
  });
});
