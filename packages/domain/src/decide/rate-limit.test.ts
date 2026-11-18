import { describe, expect, test } from 'vitest';
import type { DomainEventDraft } from '@ai-office/contracts/events';
import type { DomainCommand } from '../commands.js';
import { replay } from '../evolve.js';
import { isRateLimited, TIMER_PAUSE_REASON } from '../state/index.js';
import {
  at,
  eventDraft,
  Harness,
  meta,
  spawn,
  startCommand,
  startStage,
  throughStage,
} from '../test-support/fixtures.js';
import { suspendedMilliseconds } from './question.js';

const item = {
  key: 'T1',
  title: 'T1',
  body: 'Implement feature',
  acceptance: ['Works'],
  role: 'engineer',
  agent: 'codex' as const,
  deps: [],
};
const worker = (enforcement?: 'on' | 'off') =>
  throughStage(
    new Harness(),
    'breakdown',
    startCommand({
      limits: {
        globalAgents: 10,
        ...(enforcement === undefined
          ? {}
          : { budgetEnforcement: enforcement }),
      },
    }),
  ).given(
    eventDraft('workitem.approved', { gateId: 'task-split', items: [item] }),
    startStage('implement'),
    { type: 'DispatchWorkItem', meta: meta(), itemKey: 'T1', attemptId: 'w' },
    spawn('w', 'engineer', 'implement', { purpose: 'worker', itemKey: 'T1' }),
  );
const emitted = (h: Harness, command: DomainCommand): DomainEventDraft[] => {
  const result = h.run(command);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result.ok ? result.events : [];
};
const tokens = (amount: number): DomainCommand => ({
  type: 'RecordUsageTokens',
  meta: meta(10),
  usage: {
    attemptId: 'w',
    inputUncached: amount,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    budgetTokens: amount,
  },
});
const turns = (amount: number): DomainCommand => ({
  type: 'RecordUsageTurns',
  meta: meta(10),
  usage: { attemptId: 'w', turns: amount },
});
const itemClock = (second: number, usedMinutes: number): DomainCommand => ({
  type: 'RecordWallclockLimit',
  meta: meta(second),
  stageId: 'implement',
  itemKey: 'T1',
  attemptId: 'w',
  usedMinutes,
});
const limited = (
  second: number,
  rateLimited: Extract<
    DomainCommand,
    { type: 'ObserveAttemptStatus' }
  >['rateLimited'] = {
    since: at(second),
    evidence: 'worker-show',
  },
  state: 'working' | 'starting' | 'waiting_input' | 'exited' = 'starting',
): DomainCommand => ({
  type: 'ObserveAttemptStatus',
  meta: meta(second, 'runtime'),
  attemptId: 'w',
  state,
  rateLimited,
});

describe('S25 budget enforcement switch (§10.1)', () => {
  test('off: usage is recorded but no stage, item or workflow budget event', () => {
    const h = worker('off');
    expect(emitted(h, tokens(10_000_000)).map((e) => e.type)).toEqual([
      'usage.tokens',
    ]);
    expect(emitted(h, turns(500)).map((e) => e.type)).toEqual(['usage.turns']);
    expect(h.state.usage.workflow.tokens).toBe(10_000_000);
    expect(h.state.usage.attempts.w).toMatchObject({
      tokens: 10_000_000,
      turns: 500,
    });
    expect(h.state.budgetAlerts).toEqual({});
  });
  test('on and absent (older snapshots) both enforce', () => {
    for (const h of [worker('on'), worker()])
      expect(
        emitted(h, tokens(10_000_000)).filter((e) =>
          e.type.startsWith('budget.'),
        ).length,
      ).toBeGreaterThan(0);
  });
  test('off keeps stage-contract wallclock timeouts', () => {
    expect(
      emitted(worker('off'), itemClock(5400, 90)).map((e) => e.type),
    ).toEqual(['budget.exceeded', 'budget.hard_limit']);
  });
});

describe('S26 rate limit state (§7.1, provisional)', () => {
  test('enter, refresh, lift: since is kept and windows close at the lift', () => {
    const h = worker();
    expect(emitted(h, limited(60)).map((e) => e.type)).toEqual(['seat.status']);
    expect(h.state.attempts.w?.rateLimited).toEqual({
      since: at(60),
      evidence: 'worker-show',
      lastEvidenceAt: at(60),
    });
    h.given(
      limited(
        120,
        { since: at(120), evidence: 'transcript', resetsAt: at(600) },
        'working',
      ),
    );
    expect(h.state.attempts.w).toMatchObject({
      state: 'working',
      rateLimited: {
        since: at(60),
        evidence: 'transcript',
        resetsAt: at(600),
        lastEvidenceAt: at(120),
      },
      rateLimitWindows: [{ from: at(60) }],
    });
    expect(isRateLimited(h.state.attempts.w!)).toBe(true);
    expect(emitted(h, limited(600, null, 'working'))[0]).toMatchObject({
      type: 'seat.status',
      payload: { attemptId: 'w', state: 'working', rateLimited: null },
    });
    expect(h.state.attempts.w?.rateLimited).toBeUndefined();
    expect(h.state.attempts.w?.rateLimitWindows).toEqual([
      { from: at(60), to: at(600) },
    ]);
    expect(replay(h.events).state).toEqual(h.state);
    expect(h.warnings).toEqual([]);
  });
  test('lifting without a limit and evidence for an ended attempt are no-ops', () => {
    const h = worker();
    expect(emitted(h, limited(60, null))).toEqual([]);
    h.given({
      type: 'RecordAttemptExited',
      meta: meta(70),
      attemptId: 'w',
      reason: 'exit',
      expected: false,
    });
    expect(emitted(h, limited(80, undefined, 'exited'))).toEqual([]);
  });
  test('exit closes the open window', () => {
    const h = worker().given(limited(60), {
      type: 'RecordAttemptExited',
      meta: meta(90),
      attemptId: 'w',
      reason: 'exit',
      expected: false,
    });
    expect(h.state.attempts.w?.rateLimited).toBeUndefined();
    expect(h.state.attempts.w?.rateLimitWindows).toEqual([
      { from: at(60), to: at(90) },
    ]);
  });
  test('item wallclock excludes rate-limited time; overlaps with questions count once', () => {
    const h = worker().given(
      limited(600),
      {
        type: 'AskQuestion',
        meta: meta(1200),
        questionId: 'q',
        attemptId: 'w',
        body: 'Which?',
      },
      limited(1800, null, 'waiting_input'),
    );
    // Limited 600–1800 (open question 1200–now): 20 minutes plus 30 since 1800 at 3600.
    expect(suspendedMilliseconds(h.state, 'w', at(3600))).toBe(50 * 60_000);
    expect(emitted(h, itemClock(5400, 90))).toEqual([]);
    expect(suspendedMilliseconds(h.state, 'other', at(3600))).toBe(0);
  });
  test('a 45-minute item survives a 60-minute limit and times out after the remainder', () => {
    const h = worker().given(limited(600), limited(4200, null));
    // 104 elapsed minutes − 60 limited = 44 used; one minute later 45 = itemMin.
    expect(emitted(h, itemClock(6240, 104))).toEqual([]);
    expect(emitted(h, itemClock(6300, 105)).map((e) => e.type)).toEqual([
      'budget.exceeded',
    ]);
  });
});

describe('S26 timer pause (evolve)', () => {
  const timer = (h: Harness, second = 0) =>
    h.given(
      eventDraft(
        'timer.scheduled',
        {
          timerId: 't',
          fireAt: at(second + 2700),
          payload: { purpose: 'item-timeout', itemKey: 'T1', attemptId: 'w' },
        },
        { second },
      ),
    );
  test('a pause keeps the timer pending but unfired; rescheduling resumes it', () => {
    const h = timer(worker()).given(
      eventDraft(
        'timer.cancelled',
        { timerId: 't', reason: TIMER_PAUSE_REASON },
        { second: 600 },
      ),
    );
    expect(h.state.timers.t).toMatchObject({ pausedAt: at(600) });
    h.append(eventDraft('timer.fired', { timerId: 't' }));
    expect(h.warnings.map((w) => w.code)).toEqual(['timer_paused']);
    expect(h.state.timers.t?.pausedAt).toBe(at(600));
    h.append(
      eventDraft('timer.cancelled', {
        timerId: 't',
        reason: TIMER_PAUSE_REASON,
      }),
    );
    expect(h.warnings.map((w) => w.code)).toEqual([
      'timer_paused',
      'timer_paused',
    ]);
    h.warnings = [];
    h.given(
      eventDraft('timer.scheduled', {
        timerId: 't',
        fireAt: at(9000),
        payload: { purpose: 'item-timeout', itemKey: 'T1', attemptId: 'w' },
      }),
    );
    expect(h.state.timers.t).toEqual({
      id: 't',
      fireAt: at(9000),
      payload: { purpose: 'item-timeout', itemKey: 'T1', attemptId: 'w' },
    });
    h.append(
      eventDraft('timer.scheduled', {
        timerId: 't',
        fireAt: at(1),
        payload: { purpose: 'item-timeout', itemKey: 'T1', attemptId: 'w' },
      }),
    );
    expect(h.warnings.map((w) => w.code)).toEqual(['duplicate_timer']);
  });
  test('an ordinary cancel drops a paused timer', () => {
    const h = timer(worker()).given(
      eventDraft('timer.cancelled', {
        timerId: 't',
        reason: TIMER_PAUSE_REASON,
      }),
      eventDraft('timer.cancelled', { timerId: 't', reason: 'satisfied' }),
    );
    expect(h.state.timers).toEqual({});
  });
});
