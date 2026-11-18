import type { WorkItemStatus } from '@ai-office/contracts/events';
import type { ReadModel } from '@ai-office/projection';
import { blockedByOf } from '@ai-office/projection';
import { listOf } from './format.js';
import { assignDesks } from './layout.js';
import { deskCapacity, needsOf, whoOf } from './officeViewModel.js';
import { badgeOf, poseOf, seatState } from './seat-state.js';
import type {
  BoardCard,
  BoardColumn,
  BoardColumnId,
  BoardLane,
  BoardViewModel,
  LaneSegment,
  SelectorArgs,
} from './types.js';

// D2 / M4_DESIGN §4.4: the plain, dense board over the same read model.

const COLUMNS: readonly BoardColumnId[] = [
  'waiting',
  'active',
  'queued',
  'review',
  'merged',
];

/**
 * Column per status. Failed and needs-attention items stay "in progress" (marked as
 * errors, they can be retried); skipped items close out with the merged ones.
 */
export const columnOf = (status: WorkItemStatus): BoardColumnId => {
  switch (status) {
    case 'proposed':
    case 'approved':
      return 'waiting';
    case 'merge_queued':
      return 'queued';
    case 'in_review':
      return 'review';
    case 'merged':
    case 'skipped':
      return 'merged';
    case 'dispatched':
    case 'in_progress':
    case 'pushed':
    case 'pr_open':
    case 'rework':
    case 'needs_attention':
    case 'failed':
      return 'active';
  }
};

export function boardViewModel(
  rm: ReadModel,
  args: SelectorArgs,
): BoardViewModel {
  const { t, now } = args;
  const { accessories } = assignDesks(rm, deskCapacity(rm));
  const cards: BoardCard[] = rm.workItems.map((item) => {
    const seat = rm.seats.find((s) => s.seatId === item.seatId);
    const state = seat ? seatState(rm, seat) : undefined;
    const itemGate = rm.gates.some(
      (g) =>
        g.status === 'open' &&
        g.kind === 'exception' &&
        g.content.type === 'exception' &&
        g.content.itemKey === item.key,
    );
    const needsYou = itemGate || state?.pose === 'needs-you';
    const error =
      item.status === 'failed' ||
      item.status === 'needs_attention' ||
      state?.pose === 'error';
    const blockedBy = blockedByOf(rm, item.key);
    const column = columnOf(item.status);
    const statusLabel = t(`office.itemStatus.${item.status}`);
    const note =
      column === 'waiting'
        ? blockedBy.length > 0
          ? t('board.card.blocked', { deps: listOf(t, blockedBy) })
          : t('board.card.ready')
        : item.reworks > 0
          ? t('board.card.rework', { n: item.reworks })
          : item.attempts > 1
            ? t('board.card.attempt', { n: item.attempts })
            : undefined;
    const badge = badgeOf(item.agent);
    return {
      itemKey: item.key,
      title: item.title,
      status: item.status,
      statusLabel,
      column,
      blockedBy,
      ready: blockedBy.length === 0,
      ...(note === undefined ? {} : { note }),
      ...(item.pr
        ? {
            pr: {
              number: item.pr.number,
              ...(item.pr.url === undefined ? {} : { url: item.pr.url }),
            },
          }
        : {}),
      attempts: item.attempts,
      reworks: item.reworks,
      ...(item.agent === undefined ? {} : { vendor: item.agent }),
      ...(badge ? { badge } : {}),
      accessory: (seat && accessories.get(seat.seatId)) ?? 'default',
      ...(seat ? { seatId: seat.seatId } : {}),
      needsYou,
      error,
      tone: needsYou
        ? 'need'
        : error
          ? 'error'
          : item.status === 'skipped'
            ? 'muted'
            : 'plain',
      ariaLabel: t('board.card.aria', { item: item.key, status: statusLabel }),
      testId: `board-card-${item.key}`,
    };
  });
  const columns: BoardColumn[] = COLUMNS.map((id) => ({
    id,
    label: t(`board.column.${id}`),
    cards: cards.filter((c) => c.column === id),
    testId: `board-column-${id}`,
  }));

  const origin = Date.parse(rm.startedAt);
  const end = rm.endedAt === undefined ? now : Date.parse(rm.endedAt);
  let span = Math.max(0, end - origin);
  const lanes: BoardLane[] = rm.seats.map((seat) => {
    const who = whoOf(t, seat);
    const segments: LaneSegment[] = seat.attempts.map((a) => {
      const alive = a.endedAt === undefined && !a.released;
      const start = Date.parse(a.startedAt) - origin;
      const stop =
        a.endedAt !== undefined
          ? Date.parse(a.endedAt) - origin
          : alive
            ? end - origin
            : start;
      span = Math.max(span, stop);
      return {
        attemptId: a.attemptId,
        attempt: a.attempt,
        stageId: a.stageId,
        purpose: a.purpose,
        state: a.state,
        pose: poseOf(a),
        start,
        end: Math.max(start, stop),
        alive,
        ariaLabel: t('board.segment.aria', {
          n: a.attempt,
          purpose: t(`office.purpose.${a.purpose}`),
          state: t(`office.attemptState.${a.state}`),
        }),
        testId: `board-segment-${a.attemptId}`,
      };
    });
    const badge = badgeOf(seat.agent);
    return {
      seatId: seat.seatId,
      title: seat.itemKey ?? seat.role,
      ...(badge ? { badge } : {}),
      pose: seatState(rm, seat).pose,
      selected: args.selectedSeatId === seat.seatId,
      segments,
      ariaLabel: t('board.lane.aria', { who }),
      testId: `board-lane-${seat.seatId}`,
    };
  });
  return {
    workflowId: rm.workflowId,
    columns,
    lanes,
    span,
    needs: needsOf(rm, args),
  };
}
