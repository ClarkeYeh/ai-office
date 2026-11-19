import type { AttemptView, GateView, SeatView } from '@ai-office/contracts/api';
import type { ReadModel } from '@ai-office/projection';
import type { Pose, Screen, VendorBadge, Vendor } from './types.js';

// M4_DESIGN §2.6 (seat state, first match wins) and §2.7 (screen colour).

export type NeedReason =
  | { kind: 'waiting'; since: string }
  | { kind: 'question'; since: string; questionId: string }
  | { kind: 'exception'; since: string; gate: GateView };

export type SeatState = {
  pose: Pose;
  attempt?: AttemptView;
  need?: NeedReason;
};

export const currentAttempt = (seat: SeatView): AttemptView | undefined =>
  seat.attempts.find((a) => a.attemptId === seat.currentAttemptId);

/** Open exception gates linked to the seat by attempt or work item. */
export function exceptionGatesFor(rm: ReadModel, seat: SeatView): GateView[] {
  return rm.gates.filter((g) => {
    if (g.status !== 'open' || g.kind !== 'exception') return false;
    if (g.content.type !== 'exception') return false;
    const { attemptId, itemKey } = g.content;
    return (
      (attemptId !== undefined &&
        seat.attempts.some((a) => a.attemptId === attemptId)) ||
      (itemKey !== undefined && itemKey === seat.itemKey)
    );
  });
}

function needOf(
  rm: ReadModel,
  seat: SeatView,
  attempt: AttemptView | undefined,
): NeedReason | undefined {
  if (attempt?.state === 'waiting_input')
    return {
      kind: 'waiting',
      since: attempt.waitingSince ?? attempt.startedAt,
    };
  const question = rm.questions.find(
    (q) => q.seatId === seat.seatId && q.status === 'escalated',
  );
  if (question)
    return {
      kind: 'question',
      since: question.escalation?.at ?? question.askedAt,
      questionId: question.questionId,
    };
  const gate = exceptionGatesFor(rm, seat)[0];
  if (gate) return { kind: 'exception', since: gate.openedAt, gate };
  return undefined;
}

export function seatState(rm: ReadModel, seat: SeatView): SeatState {
  const attempt = currentAttempt(seat);
  const need = needOf(rm, seat, attempt);
  const base = attempt ? { attempt } : {};
  if (need) return { ...base, pose: 'needs-you', need };
  return { ...base, pose: poseOf(attempt) };
}

/** §2.6 rows 2–5 for one attempt (the board's lane segments use this alone). */
export function poseOf(attempt: AttemptView | undefined): Pose {
  if (!attempt) return 'away';
  switch (attempt.state) {
    case 'waiting_input':
      return 'needs-you';
    case 'error':
    case 'lost':
      return 'error';
    case 'starting':
    case 'working':
      return 'working';
    case 'idle':
    case 'done':
      return attempt.released ? 'away' : 'idle';
    case 'exited':
      return 'away';
  }
}

/** §2.7: the latest activity of the current attempt picks the screen colour. */
export function screenOf(seat: SeatView, state: SeatState): Screen {
  switch (state.pose) {
    case 'away':
      return 'off';
    case 'error':
      return 'error';
    case 'idle':
    case 'needs-you':
      return 'dark';
    case 'working': {
      const last = seat.recentActivity.findLast(
        (a) => a.attemptId === state.attempt?.attemptId,
      );
      if (!last || last.category === 'orca') return 'other';
      return last.category;
    }
  }
}

export const badgeOf = (
  vendor: Vendor | null | undefined,
): VendorBadge | undefined =>
  vendor === 'claude-code' ? 'CC' : vendor === 'codex' ? 'CX' : undefined;

/**
 * G9 (S26): `AttemptView.rateLimited` is set while the provider limit holds and
 * reset to `null` when it lifts; `resetsAt` is only an estimate.
 */
export const rateLimited = (attempt: AttemptView | undefined): boolean =>
  attempt?.rateLimited != null;
