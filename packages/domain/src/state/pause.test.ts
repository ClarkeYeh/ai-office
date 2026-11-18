import { describe, expect, test } from 'vitest';
import { suspendedMilliseconds } from '../decide/question.js';
import { replay } from '../evolve.js';
import {
  at,
  eventDraft,
  Harness,
  meta,
  spawn,
  startCommand,
  startStage,
} from '../test-support/fixtures.js';
import { initialState } from './index.js';
import { heldTimerShifts, isTimerHeld, pausedMilliseconds } from './pause.js';

const TIMER = 'wf-1/timer/test';
const pause = (second: number, reason: 'hijacked' | 'budget' = 'hijacked') =>
  ({ type: 'PauseWorkflow', meta: meta(second, 'user'), reason }) as const;
const resume = (second: number, reason: 'hijacked' | 'budget' = 'hijacked') =>
  ({ type: 'ResumeWorkflow', meta: meta(second, 'user'), reason }) as const;
const schedule = (second: number, fireAt: number, timerId = TIMER) =>
  eventDraft(
    'timer.scheduled',
    {
      timerId,
      fireAt: at(fireAt),
      payload: { purpose: 'stage-timeout', stageId: 'meeting', attempt: 1 },
    },
    { second },
  );
const started = () =>
  new Harness().given(startCommand(), startStage('meeting', 0));

describe('workflow pause windows (FX8b)', () => {
  test('overlapping reasons share one window from the first to full unpause', () => {
    const h = started().given(
      pause(10),
      pause(20, 'budget'),
      resume(30),
      resume(50, 'budget'),
      pause(70, 'budget'),
    );
    expect(h.state.workflow?.pauseWindows).toEqual([
      { from: at(10), to: at(50) },
      { from: at(70) },
    ]);
    expect(pausedMilliseconds(h.state.workflow, at(0), at(80))).toBe(50_000);
    expect(pausedMilliseconds(h.state.workflow, at(40), at(75))).toBe(15_000);
    expect(replay(h.events).state).toEqual(h.state);
  });

  test('a timer is held from the pause until rescheduled with its remaining time', () => {
    const h = started().given(schedule(0, 60), pause(40));
    const timer = () => h.state.timers[TIMER]!;
    expect(timer().scheduledAt).toBe(at(0));
    expect(isTimerHeld(h.state, timer())).toBe(true);
    expect(heldTimerShifts(h.state, at(100))).toEqual([]);
    h.given(resume(100));
    expect(isTimerHeld(h.state, timer())).toBe(true);
    // 20 s were left at the pause: fireAt 60 + 60 s paused.
    expect(heldTimerShifts(h.state, at(100))).toEqual([
      { timer: timer(), fireAt: at(120), repause: false },
    ]);
    h.given(schedule(100, 120));
    expect(timer()).toMatchObject({ fireAt: at(120), scheduledAt: at(100) });
    expect(isTimerHeld(h.state, timer())).toBe(false);
    expect(heldTimerShifts(h.state, at(100))).toEqual([]);
  });

  test('a timer armed during a pause keeps its full delay; overdue ones fire now', () => {
    const h = started().given(pause(10), schedule(30, 50), resume(100));
    // Armed at 30 for 20 s; the 70 s of pause after it do not count.
    expect(heldTimerShifts(h.state, at(100))[0]?.fireAt).toBe(at(120));
    // Restart long after the resume: never earlier than now.
    expect(heldTimerShifts(h.state, at(200))[0]?.fireAt).toBe(at(200));
  });

  test('shifts every held timer in id order; nothing without a pause', () => {
    expect(pausedMilliseconds(null, at(0), at(10))).toBe(0);
    expect(heldTimerShifts(initialState(), at(10))).toEqual([]);
    const h = started().given(
      ...['c', 'a', 'b'].map((id) => schedule(0, 60, id)),
      pause(10),
      resume(20),
    );
    expect(heldTimerShifts(h.state, at(20)).map((s) => s.timer.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    const { id, fireAt, payload } = h.state.timers.a!;
    const unscheduled = { id, fireAt, payload };
    expect(isTimerHeld(h.state, unscheduled)).toBe(false);
    expect(isTimerHeld(initialState(), h.state.timers.a!)).toBe(false);
  });

  test('only a timer a past pause held may be rescheduled under its id', () => {
    const h = started().given(schedule(0, 60));
    h.append(schedule(5, 90));
    expect(h.warnings.map((w) => w.code)).toEqual(['duplicate_timer']);
    h.warnings = [];
    h.given(pause(10));
    h.append(schedule(15, 90));
    expect(h.warnings.map((w) => w.code)).toEqual(['duplicate_timer']);
  });

  test('an item wallclock does not count pause time since the attempt spawned', () => {
    const h = started().given(
      pause(5),
      resume(8),
      spawn('att-1', 'pm', 'meeting', { meta: meta(10) }),
      pause(20),
      resume(50),
    );
    expect(suspendedMilliseconds(h.state, 'att-1', at(60))).toBe(30_000);
    expect(suspendedMilliseconds(h.state, 'att-1', at(60), false)).toBe(0);
    h.given(pause(70));
    expect(suspendedMilliseconds(h.state, 'att-1', at(80))).toBe(40_000);
  });
});
