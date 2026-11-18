import type { Timer, TimerPayload, WorkflowState } from '@ai-office/domain';
import type { ReactContext } from './context.js';
import type { CancelTimerEffect, TimerEffect } from './effects.js';

export const MINUTE_MS = 60_000;

/**
 * Deterministic timer id from the payload (keys sorted) plus optional
 * discriminators, so the same event sequence always yields the same ids.
 */
export const timerId = (
  workflowId: string,
  payload: TimerPayload,
  ...discriminators: (string | number)[]
): string => {
  const fields = Object.entries(payload)
    .filter(([key]) => key !== 'purpose')
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${String(value)}`);
  return [
    workflowId,
    'timer',
    payload.purpose,
    ...fields,
    ...discriminators,
  ].join('/');
};

/** `fireAt` counts from the triggering event's `occurredAt`; engine never reads a clock. */
export const fireAt = (occurredAt: string, delayMs: number): string =>
  new Date(Date.parse(occurredAt) + delayMs).toISOString();

export const schedule = (
  ctx: ReactContext,
  payload: TimerPayload,
  delayMs: number,
  ...discriminators: (string | number)[]
): TimerEffect => ({
  kind: 'timer',
  timer: {
    id: timerId(ctx.workflowId, payload, ...discriminators),
    fireAt: fireAt(ctx.event.occurredAt, delayMs),
    payload,
  },
});

export const cancelTimer = (id: string, reason?: string): CancelTimerEffect =>
  reason === undefined
    ? { kind: 'cancelTimer', id }
    : { kind: 'cancelTimer', id, reason };

/** Pending timers of one purpose, in id order. */
export const pendingTimers = <P extends TimerPayload['purpose']>(
  state: WorkflowState,
  purpose: P,
): (Timer & { payload: Extract<TimerPayload, { purpose: P }> })[] =>
  Object.values(state.timers)
    .filter(
      (
        timer,
      ): timer is Timer & {
        payload: Extract<TimerPayload, { purpose: P }>;
      } => timer.payload.purpose === purpose,
    )
    .sort((a, b) => (a.id < b.id ? -1 : 1));

/** The fired timer when it has the given purpose. */
export const firedTimer = <P extends TimerPayload['purpose']>(
  ctx: ReactContext,
  purpose: P,
): (Timer & { payload: Extract<TimerPayload, { purpose: P }> }) | undefined =>
  ctx.timer?.payload.purpose === purpose
    ? (ctx.timer as Timer & { payload: Extract<TimerPayload, { purpose: P }> })
    : undefined;
