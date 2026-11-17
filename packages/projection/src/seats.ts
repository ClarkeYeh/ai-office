import { SEAT_RECENT_ACTIVITY_LIMIT } from '@ai-office/contracts/api';
import type { DomainEvent } from '@ai-office/contracts/events';
import { emptyUsage, findAttempt, type ReadModel } from './model.js';

export function applySeats(m: ReadModel, e: DomainEvent): void {
  if (e.type === 'seat.spawned') {
    const p = e.payload;
    if (findAttempt(m, p.attemptId)) return;
    let seat = m.seats.find((s) => s.seatId === p.seatId);
    if (!seat) {
      seat = {
        seatId: p.seatId,
        workflowId: m.workflowId,
        role: p.role,
        ...(p.itemKey === undefined ? {} : { itemKey: p.itemKey }),
        agent: null,
        state: null,
        degraded: false,
        recentActivity: [],
        attempts: [],
        policyHits: [],
        usage: emptyUsage(),
        errors: [],
      };
      m.seats.push(seat);
    }
    seat.agent = p.agent;
    seat.state = 'starting';
    seat.degraded = false;
    seat.currentAttemptId = p.attemptId;
    if (p.itemKey !== undefined) seat.currentWorkItem = p.itemKey;
    else delete seat.currentWorkItem;
    seat.attempts.push({
      attemptId: p.attemptId,
      attempt: p.attempt,
      stageId: p.stageId,
      role: p.role,
      agent: p.agent,
      purpose: p.purpose,
      oncall: p.oncall,
      ...(p.itemKey === undefined ? {} : { itemKey: p.itemKey }),
      ...(p.retryOf === undefined ? {} : { retryOf: p.retryOf }),
      state: 'starting',
      degraded: false,
      startedAt: e.occurredAt,
      released: false,
      usage: emptyUsage(),
    });
    const item = m.workItems.find((w) => w.key === p.itemKey);
    if (item) item.seatId = p.seatId;
    return;
  }
  if (!('attemptId' in e.payload) || typeof e.payload.attemptId !== 'string')
    return;
  const found = findAttempt(m, e.payload.attemptId);
  if (!found) return;
  const { seat, attempt } = found;
  switch (e.type) {
    case 'seat.status':
      attempt.state = e.payload.state;
      if (
        e.payload.state === 'waiting_input' &&
        e.payload.waitingSince !== undefined
      )
        attempt.waitingSince = e.payload.waitingSince;
      else delete attempt.waitingSince;
      break;
    case 'seat.activity':
      seat.recentActivity = [
        ...seat.recentActivity,
        ...e.payload.activity.map((a) => ({
          ...a,
          attemptId: attempt.attemptId,
          at: e.occurredAt,
        })),
      ].slice(-SEAT_RECENT_ACTIVITY_LIMIT);
      break;
    case 'seat.degraded':
      attempt.degraded = true;
      attempt.degradedReason = e.payload.reason;
      break;
    case 'seat.policy_violation':
      seat.policyHits.push(
        ...e.payload.hits.map((h) => ({ ...h, attemptId: attempt.attemptId })),
      );
      break;
    case 'seat.exited':
      attempt.state = 'exited';
      attempt.endedAt = e.occurredAt;
      attempt.exitReason = e.payload.reason;
      delete attempt.waitingSince;
      break;
    case 'seat.released':
      attempt.released = true;
      break;
  }
  if (seat.currentAttemptId === attempt.attemptId) {
    seat.state = attempt.state;
    seat.degraded = attempt.degraded;
  }
}
