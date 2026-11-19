import { isRateLimited, TIMER_PAUSE_REASON } from '@ai-office/domain';
import type { Attempt, TimerPayload, WorkflowState } from '@ai-office/domain';
import { metaFor } from '../context.js';
import type { ReactContext } from '../context.js';
import { internal } from '../effects.js';
import type { Effect } from '../effects.js';
import {
  cancelTimer,
  fireAt,
  firedTimer,
  MINUTE_MS,
  pendingTimers,
  schedule,
} from '../timers.js';
import type { Policy } from '../stages/types.js';

/** §7.1 (S26): without a reset time, a limit lifts 30 minutes after its last evidence. */
export const RATE_LIMIT_QUIET_MS = 30 * MINUTE_MS;

/**
 * The timers S26 suspends (§7.1): review, question and item timeouts, nudges
 * and spawn stall. Stage and round timeouts are not on the list.
 */
const PAUSABLE: ReadonlySet<TimerPayload['purpose']> = new Set([
  'item-timeout',
  'review-timeout',
  'question-timeout',
  'nudge-grace',
  'spawn-stall',
]);

/** The attempt whose clock a pausable timer measures; `undefined` for any other timer. */
export const timerAttemptId = (
  state: WorkflowState,
  payload: TimerPayload,
): string | undefined => {
  if (!PAUSABLE.has(payload.purpose)) return undefined;
  if (payload.purpose === 'question-timeout')
    // The on-call instance answering the question owns its timeout.
    return Object.values(state.ondemand)
      .map((byPurpose) => byPurpose.oncall)
      .find((oncall) => oncall?.current === payload.questionId)?.attemptId;
  return 'attemptId' in payload ? payload.attemptId : undefined;
};

const limitedAttempt = (
  state: WorkflowState,
  payload: TimerPayload,
): Attempt | undefined => {
  const id = timerAttemptId(state, payload);
  const attempt = id === undefined ? undefined : state.attempts[id];
  return attempt !== undefined && isRateLimited(attempt) ? attempt : undefined;
};

const liftTimers = (ctx: ReactContext, attemptId: string): Effect[] =>
  pendingTimers(ctx.state, 'rate-limit-lift')
    .filter((t) => t.payload.attemptId === attemptId)
    .map((t) => cancelTimer(t.id, 'superseded'));

/** Enter or refresh: pause the attempt's running timers and re-arm the lift. */
const pause = (ctx: ReactContext, attempt: Attempt): Effect[] => {
  const limit = attempt.rateLimited!;
  const delay =
    limit.resetsAt === undefined
      ? RATE_LIMIT_QUIET_MS
      : Math.max(
          0,
          Date.parse(limit.resetsAt) - Date.parse(ctx.event.occurredAt),
        );
  return [
    ...Object.values(ctx.state.timers)
      .filter(
        (t) =>
          t.pausedAt === undefined &&
          timerAttemptId(ctx.state, t.payload) === attempt.attemptId,
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((t) => cancelTimer(t.id, TIMER_PAUSE_REASON)),
    ...liftTimers(ctx, attempt.attemptId),
    schedule(
      ctx,
      { purpose: 'rate-limit-lift', attemptId: attempt.attemptId },
      delay,
      ctx.event.seq,
    ),
  ];
};

/** Lifted (or the attempt ended): resume paused timers with their remaining time. */
const resume = (ctx: ReactContext, attemptId: string): Effect[] => [
  ...liftTimers(ctx, attemptId),
  ...Object.values(ctx.state.timers)
    .filter(
      (t) =>
        t.pausedAt !== undefined &&
        timerAttemptId(ctx.state, t.payload) === attemptId,
    )
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((t): Effect => ({
      kind: 'timer',
      timer: {
        // Same id, so stage modules that match timers by id still find it.
        id: t.id,
        fireAt: fireAt(
          ctx.event.occurredAt,
          Math.max(0, Date.parse(t.fireAt) - Date.parse(t.pausedAt!)),
        ),
        payload: t.payload,
      },
    })),
];

/**
 * §7.1 S26 provider rate limit (provisional): while an attempt is rate-limited
 * its engine timers are paused, not counted, and nothing treats it as a
 * failure. The limit lifts on `seat.status{rateLimited:null}`, which engine
 * itself records at the evidence's `resetsAt` or 30 quiet minutes later.
 */
export const rateLimitPolicy: Policy = (ctx) => {
  const workflow = ctx.state.workflow;
  if (!workflow || workflow.status !== 'running') return [];
  const fired = firedTimer(ctx, 'rate-limit-lift');
  if (fired) {
    const attempt = ctx.state.attempts[fired.payload.attemptId];
    return attempt && isRateLimited(attempt)
      ? [
          internal({
            type: 'ObserveAttemptStatus',
            meta: metaFor(ctx),
            attemptId: attempt.attemptId,
            state: attempt.state,
            ...(attempt.waitingSince === undefined
              ? {}
              : { waitingSince: attempt.waitingSince }),
            rateLimited: null,
          }),
        ]
      : [];
  }
  const event = ctx.event;
  if (
    event.type !== 'seat.status' &&
    event.type !== 'seat.exited' &&
    event.type !== 'seat.released'
  )
    return [];
  const before = ctx.before.attempts[event.payload.attemptId];
  // Applied, so the attempt exists: evolve skips unknown attempts and react stops.
  const after = ctx.state.attempts[event.payload.attemptId]!;
  if (isRateLimited(after))
    return event.type === 'seat.status' && event.payload.rateLimited
      ? pause(ctx, after)
      : [];
  return before && isRateLimited(before) ? resume(ctx, after.attemptId) : [];
};

/**
 * Timers that modules arm for an attempt that is rate-limited right now start
 * paused: each schedule is followed by its pause, so the full delay remains.
 */
export const pauseRateLimitedTimers = (
  ctx: ReactContext,
  effects: Effect[],
): Effect[] =>
  effects.flatMap((effect) =>
    effect.kind === 'timer' &&
    limitedAttempt(ctx.state, effect.timer.payload) !== undefined
      ? [effect, cancelTimer(effect.timer.id, TIMER_PAUSE_REASON)]
      : [effect],
  );
