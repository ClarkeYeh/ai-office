import { describe, expect, it } from 'vitest';
import { TIMER_PAUSE_REASON } from '@ai-office/domain';
import type { DomainCommand, WorkItem } from '@ai-office/domain';
import { createReact, DEFAULT_MODULES } from '../react.js';
import { cooperativeWorld, Simulator } from '../test-support/simulator.js';
import { startWorkflow } from '../test-support/fixtures.js';
import { schedule } from '../timers.js';
import {
  pauseRateLimitedTimers,
  RATE_LIMIT_QUIET_MS,
  rateLimitPolicy,
  timerAttemptId,
} from './rate-limit.js';

const MIN = 60_000;
const sha = (n: number) => n.toString(16).padStart(40, 'a');
const item = (key: string): WorkItem => ({
  key,
  title: key,
  body: `Implement ${key}`,
  acceptance: ['Works'],
  deps: [],
  role: 'engineer',
  agent: 'codex',
  status: 'approved',
  approvedGateId: 'approved',
  attemptIds: [],
  attempt: 0,
  issue: 10,
});

/** One implement worker (itemMin 45, spawnStallMs 10 min); the agent does nothing by itself. */
function setup() {
  const empty = { react: () => [] };
  const sim = new Simulator({
    react: createReact({
      ...DEFAULT_MODULES,
      stages: {
        ...DEFAULT_MODULES.stages,
        meeting: empty,
        planning: empty,
        integrate: empty,
        ondemand: empty,
      },
    }),
    world: (issued, current) =>
      issued.command.kind === 'scm.compareBranch'
        ? { ok: true, result: { ahead: 0, headSha: sha(1) } }
        : cooperativeWorld(issued, current),
  });
  const start = startWorkflow();
  start.limits.spawnStallMs = 10 * MIN;
  sim.dispatch(start);
  sim.state.stages.meeting!.status = 'done';
  sim.state.stages.breakdown!.status = 'done';
  sim.state.workItems = { A: item('A') };
  sim.state.workItemOrder = ['A'];
  sim.dispatch({ type: 'StartStage', stageId: 'implement' });
  return sim;
}
const current = (sim: Simulator) =>
  sim.state.attempts[sim.state.workItems.A!.currentAttemptId!]!;
const limit = (
  sim: Simulator,
  rateLimited: Extract<
    DomainCommand,
    { type: 'ObserveAttemptStatus' }
  >['rateLimited'] = { since: sim.clock, evidence: 'worker-show' },
) =>
  sim.dispatch(
    {
      type: 'ObserveAttemptStatus',
      attemptId: current(sim).attemptId,
      state: current(sim).state,
      rateLimited,
    },
    'runtime',
  );
const work = (sim: Simulator) =>
  sim.dispatch(
    {
      type: 'RecordAttemptActivity',
      attemptId: current(sim).attemptId,
      activity: [
        {
          messageId: 'm1',
          category: 'edit',
          inputLen: 1,
          outputLen: 1,
          inputHash: 'h1',
        },
      ],
    },
    'runtime',
  );
const nudges = (sim: Simulator, reason: string) =>
  sim.eventsOf('message.nudge').filter((e) => e.payload.reason === reason);
const lifts = (sim: Simulator) =>
  sim.eventsOf('seat.status').filter((e) => e.payload.rateLimited === null);
const timerOf = (sim: Simulator, purpose: string) =>
  Object.values(sim.state.timers).find((t) => t.payload.purpose === purpose);
/** S26: never a failure, an exception gate or a rejected command. */
const noFailure = (sim: Simulator) => {
  expect(
    sim.eventsOf('seat.status').filter((e) => e.payload.state === 'error'),
  ).toEqual([]);
  expect(sim.eventsOf('gate.opened')).toEqual([]);
  expect(sim.eventsOf('error.recorded')).toEqual([]);
  expect(sim.rejections).toEqual([]);
  expect(sim.warnings).toEqual([]);
};

describe('S26 provider rate limit (§7.1, provisional)', () => {
  it('spawn stall and item timeout never expire while limited; resetsAt lifts and they resume with the remaining time', () => {
    const sim = setup();
    sim.advance(4 * MIN);
    const resetsAt = new Date(sim.now + 60 * MIN).toISOString();
    limit(sim, { since: sim.clock, evidence: 'transcript', resetsAt });
    expect(timerOf(sim, 'spawn-stall')?.pausedAt).toBe(sim.clock);
    expect(timerOf(sim, 'item-timeout')?.pausedAt).toBe(sim.clock);
    sim.advance(60 * MIN - 1);
    expect(nudges(sim, 'spawn-stall')).toEqual([]);
    expect(sim.eventsOf('budget.exceeded')).toEqual([]);
    expect(lifts(sim)).toEqual([]);
    expect(current(sim).rateLimited).toBeDefined();

    sim.advance(1);
    expect(lifts(sim)).toHaveLength(1);
    expect(current(sim).rateLimited).toBeUndefined();
    // 6 of the 10 spawn-stall minutes and 41 of the 45 item minutes remain.
    expect(timerOf(sim, 'spawn-stall')).toMatchObject({
      fireAt: new Date(sim.now + 6 * MIN).toISOString(),
    });
    expect(timerOf(sim, 'spawn-stall')?.pausedAt).toBeUndefined();
    expect(timerOf(sim, 'item-timeout')?.fireAt).toBe(
      new Date(sim.now + 41 * MIN).toISOString(),
    );
    sim.advance(6 * MIN - 1);
    expect(nudges(sim, 'spawn-stall')).toEqual([]);
    sim.advance(1);
    expect(nudges(sim, 'spawn-stall')).toHaveLength(1);
    noFailure(sim);
  });

  it('without resetsAt it lifts 30 quiet minutes after the latest evidence', () => {
    const sim = setup();
    work(sim);
    limit(sim);
    sim.advance(20 * MIN);
    limit(sim);
    sim.advance(RATE_LIMIT_QUIET_MS - 1);
    expect(lifts(sim)).toEqual([]);
    sim.advance(1);
    expect(lifts(sim)).toHaveLength(1);
    // Only the latest lift timer was live; the superseded one was cancelled.
    expect(
      sim
        .eventsOf('timer.scheduled')
        .filter((e) => e.payload.payload.purpose === 'rate-limit-lift'),
    ).toHaveLength(2);
    expect(timerOf(sim, 'rate-limit-lift')).toBeUndefined();
    noFailure(sim);
  });

  it('the item timeout counts only unlimited time, then follows the normal violation protocol', () => {
    const sim = setup();
    work(sim);
    sim.advance(30 * MIN);
    limit(sim, {
      since: sim.clock,
      evidence: 'worker-show',
      resetsAt: new Date(sim.now + 60 * MIN).toISOString(),
    });
    sim.advance(60 * MIN + 15 * MIN - 1);
    expect(sim.eventsOf('budget.exceeded')).toEqual([]);
    expect(nudges(sim, 'item-timeout')).toEqual([]);
    noFailure(sim);
    sim.advance(1);
    expect(sim.eventsOf('budget.exceeded')).toMatchObject([
      { payload: { scope: 'item', metric: 'wallclock', used: 45 } },
    ]);
  });

  it('a limit during the nudge grace pauses the grace too', () => {
    const sim = setup();
    work(sim);
    sim.advance(45 * MIN);
    expect(nudges(sim, 'item-timeout')).toHaveLength(1);
    sim.advance(2 * MIN);
    limit(sim);
    expect(timerOf(sim, 'nudge-grace')?.pausedAt).toBe(sim.clock);
    sim.advance(RATE_LIMIT_QUIET_MS);
    expect(lifts(sim)).toHaveLength(1);
    // 3 of the 5 grace minutes remain after the lift.
    const id = timerOf(sim, 'nudge-grace')!.id;
    const fired = () =>
      sim.eventsOf('timer.fired').filter((e) => e.payload.timerId === id);
    sim.advance(3 * MIN - 1);
    expect(fired()).toEqual([]);
    sim.advance(1);
    expect(fired()).toHaveLength(1);
  });

  it('an attempt that exits while limited resumes its timers and drops the lift', () => {
    const sim = setup();
    limit(sim);
    sim.dispatch(
      {
        type: 'RecordAttemptExited',
        attemptId: current(sim).attemptId,
        reason: 'crashed',
        expected: true,
      },
      'runtime',
    );
    expect(
      Object.values(sim.state.timers).filter((t) => t.pausedAt !== undefined),
    ).toEqual([]);
    expect(timerOf(sim, 'rate-limit-lift')).toBeUndefined();
    sim.advance(2 * RATE_LIMIT_QUIET_MS);
    expect(lifts(sim)).toEqual([]);
  });

  it('other status changes keep the pause; a lift while waiting keeps waitingSince', () => {
    const sim = setup();
    limit(sim);
    sim.dispatch(
      {
        type: 'ObserveAttemptStatus',
        attemptId: current(sim).attemptId,
        state: 'waiting_input',
        waitingSince: sim.clock,
      },
      'runtime',
    );
    expect(timerOf(sim, 'item-timeout')?.pausedAt).toBeDefined();
    const since = sim.clock;
    sim.advance(RATE_LIMIT_QUIET_MS);
    expect(lifts(sim).at(-1)?.payload).toMatchObject({
      state: 'waiting_input',
      waitingSince: since,
      rateLimited: null,
    });
    expect(current(sim).waitingSince).toBe(since);
    noFailure(sim);
  });

  it('a stale lift timer or a finished workflow does nothing', () => {
    const sim = setup();
    const a = current(sim);
    const lift = {
      id: 'lift',
      fireAt: sim.clock,
      payload: { purpose: 'rate-limit-lift' as const, attemptId: a.attemptId },
    };
    const ctx = {
      workflowId: sim.state.workflowId!,
      event: {
        ...sim.events.at(-1)!,
        type: 'timer.fired' as const,
        payload: { timerId: 'lift' },
      },
      before: sim.state,
      state: sim.state,
      timer: lift,
    };
    expect(rateLimitPolicy(ctx)).toEqual([]);
    expect(
      rateLimitPolicy({
        ...ctx,
        state: {
          ...sim.state,
          workflow: { ...sim.state.workflow!, status: 'completed' },
        },
      }),
    ).toEqual([]);
  });

  it('a timer armed for a limited attempt starts paused; others are untouched', () => {
    const sim = setup();
    limit(sim);
    const a = current(sim);
    const ctx = {
      workflowId: sim.state.workflowId!,
      event: sim.events.at(-1)!,
      before: sim.state,
      state: sim.state,
    };
    const mine = schedule(
      ctx,
      { purpose: 'review-timeout', itemKey: 'A', attemptId: a.attemptId },
      MIN,
    );
    const stage = schedule(
      ctx,
      { purpose: 'stage-timeout', stageId: 'implement', attempt: 1 },
      MIN,
    );
    expect(pauseRateLimitedTimers(ctx, [mine, stage])).toEqual([
      mine,
      { kind: 'cancelTimer', id: mine.timer.id, reason: TIMER_PAUSE_REASON },
      stage,
    ]);
  });

  it('question timeouts belong to the on-call instance answering them', () => {
    const sim = setup();
    sim.state.ondemand.implement = {
      oncall: {
        stageId: 'implement',
        attemptId: 'lead',
        queue: [],
        current: 'q',
      },
    };
    expect(
      timerAttemptId(sim.state, {
        purpose: 'question-timeout',
        questionId: 'q',
      }),
    ).toBe('lead');
    expect(
      timerAttemptId(sim.state, {
        purpose: 'question-timeout',
        questionId: 'x',
      }),
    ).toBeUndefined();
    expect(
      timerAttemptId(sim.state, {
        purpose: 'round-timeout',
        stageId: 'meeting',
        round: 1,
      }),
    ).toBeUndefined();
  });
});

describe('S26 composed with a workflow pause (FX8b)', () => {
  const itemTimer = (sim: Simulator) => timerOf(sim, 'item-timeout')!;
  const exceeded = (sim: Simulator) => sim.eventsOf('budget.exceeded');

  it('a limit that starts during a workflow pause is not counted twice', () => {
    const sim = setup();
    work(sim);
    sim.advance(10 * MIN);
    sim.dispatch({ type: 'PauseWorkflow', reason: 'budget' });
    sim.advance(10 * MIN);
    limit(sim, {
      since: sim.clock,
      evidence: 'worker-show',
      resetsAt: new Date(sim.now + 60 * MIN).toISOString(),
    });
    sim.advance(10 * MIN);
    sim.dispatch({ type: 'ResumeWorkflow', reason: 'budget' });
    // Clock stopped at the pause (35 minutes left), not at the limit: still
    // limited, so paused again now with those 35 minutes for S26 to resume.
    expect(itemTimer(sim).pausedAt).toBe(sim.clock);
    expect(
      Date.parse(itemTimer(sim).fireAt) - Date.parse(itemTimer(sim).pausedAt!),
    ).toBe(35 * MIN);
    sim.advance(50 * MIN);
    expect(lifts(sim)).toHaveLength(1);
    expect(itemTimer(sim).fireAt).toBe(
      new Date(sim.now + 35 * MIN).toISOString(),
    );
    sim.advance(35 * MIN - 1);
    expect(exceeded(sim)).toEqual([]);
    sim.advance(1);
    expect(exceeded(sim)).toMatchObject([
      { payload: { scope: 'item', metric: 'wallclock', used: 45 } },
    ]);
    expect(sim.rejections).toEqual([]);
  });

  it('a lift during a workflow pause resumes the timer, then the pause shift credits the rest', () => {
    const sim = setup();
    work(sim);
    sim.advance(10 * MIN);
    limit(sim, {
      since: sim.clock,
      evidence: 'worker-show',
      resetsAt: new Date(sim.now + 30 * MIN).toISOString(),
    });
    sim.advance(10 * MIN);
    sim.dispatch({ type: 'PauseWorkflow', reason: 'hijacked' });
    // The lift tracks the provider's real reset, so the pause does not hold it.
    sim.advance(20 * MIN);
    expect(lifts(sim)).toHaveLength(1);
    expect(itemTimer(sim).pausedAt).toBeUndefined();
    sim.advance(20 * MIN);
    sim.dispatch({ type: 'ResumeWorkflow', reason: 'hijacked' });
    // 35 minutes were left at the limit; neither pause counted.
    expect(itemTimer(sim).fireAt).toBe(
      new Date(sim.now + 35 * MIN).toISOString(),
    );
    sim.advance(35 * MIN - 1);
    expect(exceeded(sim)).toEqual([]);
    sim.advance(1);
    expect(exceeded(sim)).toMatchObject([
      { payload: { scope: 'item', metric: 'wallclock', used: 45 } },
    ]);
    expect(sim.rejections).toEqual([]);
  });

  it('a limit that ended before the workflow pause leaves only the pause to shift', () => {
    const sim = setup();
    work(sim);
    limit(sim, {
      since: sim.clock,
      evidence: 'worker-show',
      resetsAt: new Date(sim.now + 10 * MIN).toISOString(),
    });
    sim.advance(20 * MIN);
    sim.dispatch({ type: 'PauseWorkflow', reason: 'hijacked' });
    sim.advance(30 * MIN);
    sim.dispatch({ type: 'ResumeWorkflow', reason: 'hijacked' });
    // 10 working minutes used of 45.
    expect(itemTimer(sim).fireAt).toBe(
      new Date(sim.now + 35 * MIN).toISOString(),
    );
    expect(sim.rejections).toEqual([]);
  });
});

describe('S25 budget enforcement off (§10.1)', () => {
  it('records usage without budget events or gates', () => {
    const sim = new Simulator();
    const start = startWorkflow();
    start.limits.budgetEnforcement = 'off';
    sim.dispatch(start);
    sim.dispatch({ type: 'StartStage', stageId: 'meeting' });
    const attempt = Object.values(sim.state.attempts)[0]!;
    sim.dispatch(
      {
        type: 'RecordUsageTokens',
        usage: {
          attemptId: attempt.attemptId,
          inputUncached: 50_000_000,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          budgetTokens: 50_000_000,
        },
      },
      'runtime',
    );
    expect(sim.eventsOf('usage.tokens')).toHaveLength(1);
    expect(sim.events.filter((e) => e.type.startsWith('budget.'))).toEqual([]);
    expect(sim.eventsOf('gate.opened')).toEqual([]);
  });
});
