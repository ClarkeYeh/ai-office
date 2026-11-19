import type { DomainEvent } from '@ai-office/contracts/events';
import type { ReadModel } from '@ai-office/projection';
import type { Anchor, Effect } from './effect-types.js';

const inbox: Anchor = { kind: 'inbox' };
const yourDesk: Anchor = { kind: 'your-desk' };
const counter: Anchor = { kind: 'counter' };
const entrance: Anchor = { kind: 'entrance' };
const seat = (seatId: string): Anchor => ({ kind: 'seat', seatId });
const item = (itemKey: string): Anchor => ({ kind: 'workitem', itemKey });
const sheets = (tokens: number) => Math.min(12, Math.ceil(tokens / 50_000));

/** Applied events only. Connect suppresses background/replay-scrub events;
 * scene handles reduced motion. Persistent poses, lamps and bubbles are VM state.
 */
export function effects(
  event: DomainEvent,
  prev: ReadModel | null,
  next: ReadModel | null,
): Effect[] {
  if (!next || event.workflowId !== next.workflowId) return [];
  const attemptSeat = (id: string | undefined) => {
    if (id === undefined) return undefined;
    const found =
      next.seats.find((s) => s.attempts.some((a) => a.attemptId === id)) ??
      prev?.seats.find((s) => s.attempts.some((a) => a.attemptId === id));
    return found ? seat(found.seatId) : undefined;
  };
  const envelope = (
    from: Anchor | undefined,
    to: Anchor | undefined,
  ): Effect[] => {
    if (!from || !to) return [];
    const route: [Anchor, Anchor, ...Anchor[]] =
      from.kind === 'inbox' || to.kind === 'inbox'
        ? [from, to]
        : [from, inbox, to];
    return [
      {
        kind: 'envelope',
        route,
        reducedMotion: { kind: 'flash-nameplate', at: to },
      },
    ];
  };
  switch (event.type) {
    case 'seat.spawned': {
      const p = event.payload;
      const meeting = next.stages.some(
        (s) => s.stageId === p.stageId && s.kind === 'meeting',
      );
      return [
        {
          kind: meeting ? 'walk-to-meeting' : 'walk-in',
          attemptId: p.attemptId,
          from: entrance,
          to: meeting ? { kind: 'meeting', seatId: p.seatId } : seat(p.seatId),
        },
      ];
    }
    case 'seat.exited':
    case 'seat.released': {
      const id = event.payload.attemptId;
      const before = prev?.seats
        .flatMap((s) => s.attempts)
        .find((a) => a.attemptId === id);
      // release commonly follows exit: do not walk the same avatar out twice.
      if (before?.endedAt || before?.released) return [];
      const from = attemptSeat(id);
      return from
        ? [{ kind: 'walk-out', attemptId: id, from, to: entrance }]
        : [];
    }
    case 'workitem.dispatched':
      return envelope(inbox, item(event.payload.itemKey));
    case 'message.question':
      return envelope(attemptSeat(event.payload.attemptId), inbox);
    case 'message.forwarded':
      return envelope(inbox, attemptSeat(event.payload.toAttemptId));
    case 'message.answered': {
      const p = event.payload;
      const question =
        next.questions.find((q) => q.questionId === p.questionId) ??
        prev?.questions.find((q) => q.questionId === p.questionId);
      return envelope(
        p.by === 'user' ? yourDesk : attemptSeat(p.attemptId),
        question ? seat(question.seatId) : undefined,
      );
    }
    case 'message.escalated':
      return envelope(inbox, yourDesk);
    case 'message.instruction':
      return envelope(yourDesk, seat(event.payload.seatId));
    case 'message.nudge':
      return envelope(inbox, attemptSeat(event.payload.attemptId));
    case 'artifact.created':
      return event.payload.kind === 'pr'
        ? [
            {
              kind: 'print',
              artifactId: event.payload.artifactId,
              at: { kind: 'printer' },
            },
          ]
        : [];
    case 'workitem.merge_queued':
      return [
        {
          kind: 'conveyor',
          itemKey: event.payload.itemKey,
          from: item(event.payload.itemKey),
          to: { kind: 'conveyor' },
        },
      ];
    case 'workitem.status': {
      const p = event.payload;
      if (
        p.status !== 'in_review' ||
        prev?.workItems.find((w) => w.key === p.itemKey)?.status ===
          'in_review' ||
        prev?.stages.some((s) => s.ondemand?.merge?.current === p.itemKey)
      )
        return [];
      return [
        {
          kind: 'parcel-to-counter',
          itemKey: p.itemKey,
          from: { kind: 'conveyor' },
          to: counter,
        },
      ];
    }
    case 'ondemand.queue_changed': {
      const p = event.payload;
      if (
        p.purpose !== 'merge' ||
        p.current === undefined ||
        prev?.stages.find((s) => s.stageId === p.stageId)?.ondemand?.merge
          ?.current === p.current
      )
        return [];
      // The status event may already have moved this parcel; still deliver the assignment.
      const moved =
        prev?.workItems.find((w) => w.key === p.current)?.status ===
        'in_review';
      return [
        ...(moved
          ? []
          : [
              {
                kind: 'parcel-to-counter' as const,
                itemKey: p.current,
                from: { kind: 'conveyor' as const },
                to: counter,
              },
            ]),
        ...envelope(inbox, counter),
      ];
    }
    case 'workitem.rework_requested':
      return [
        {
          kind: 'parcel-return',
          itemKey: event.payload.itemKey,
          from: counter,
          to: item(event.payload.itemKey),
        },
      ];
    case 'workitem.merged':
      return [
        {
          kind: 'merge',
          itemKey: event.payload.itemKey,
          from: counter,
          to: { kind: 'integration-cart' },
          confetti: true,
        },
      ];
    case 'usage.tokens': {
      const anchor = attemptSeat(event.payload.attemptId);
      if (anchor?.kind !== 'seat') return [];
      const before =
        prev?.seats.find((s) => s.seatId === anchor.seatId)?.usage
          .budgetTokens ?? 0;
      const after =
        next.seats.find((s) => s.seatId === anchor.seatId)?.usage
          .budgetTokens ?? 0;
      return after > before
        ? [
            {
              kind: 'paper-grow',
              at: anchor,
              fromSheets: sheets(before),
              toSheets: sheets(after),
            },
          ]
        : [];
    }
    // workflow.completed is deliberately not another celebration.
    case 'gate.closed':
      return event.payload.reason === 'merged'
        ? [{ kind: 'door-open', at: { kind: 'main-door' }, confetti: true }]
        : [];
    default:
      return [];
  }
}
