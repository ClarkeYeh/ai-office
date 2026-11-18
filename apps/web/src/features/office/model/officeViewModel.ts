import type { SeatView } from '@ai-office/contracts/api';
import type { ReadModel } from '@ai-office/projection';
import { blockedByOf } from '@ai-office/projection';
import { formatElapsed, formatTokens, listOf } from './format.js';
import {
  COUNTER_PARCEL,
  COUNTER_PLATE,
  COUNTER_SEAT,
  DESKS_PER_ROW,
  LEAD_PLATE,
  LEAD_SEAT,
  LIT_AREA,
  MEETING_CHAIRS,
  MEETING_FACILITATOR,
  YOUR_DESK_PLATE,
  assignDesks,
  assignMeetingChairs,
  deskParcel,
  deskPlate,
  deskSeat,
  deskStack,
  fixedAnchors,
  loungeSeat,
  meetingPlate,
  placeFor,
  queueSlot,
  reserveDesks,
  roomPlan,
  rowsFor,
  sheetsFor,
  worldSize,
  type DeskAssignment,
} from './layout.js';
import type { Translate } from './messages.js';
import {
  badgeOf,
  rateLimited,
  screenOf,
  seatState,
  type SeatState,
} from './seat-state.js';
import type {
  AnchorId,
  Conveyor,
  InboxItem,
  Need,
  NameplateTone,
  OfficeSeat,
  OfficeViewModel,
  Parcel,
  PaperStack,
  Point,
  ReservedDesk,
  Room,
  SelectorArgs,
  Whiteboard,
  YourDesk,
} from './types.js';

type Ctx = SelectorArgs & {
  rm: ReadModel;
  rows: number;
  assignment: DeskAssignment;
  chairs: Map<string, number>;
};

/**
 * ReadModel → OfficeViewModel (M4_PLAN §3.5). Pure: time, strings and the
 * selection come in through `args`; pass the result through `stabilize`.
 */
export function officeViewModel(
  rm: ReadModel,
  args: SelectorArgs,
): OfficeViewModel {
  const capacity = deskCapacity(rm);
  const assignment = assignDesks(rm, capacity);
  const reservations = reserveDesks(reservableItems(rm), assignment, capacity);
  const highest = Math.max(
    -1,
    ...assignment.desks.values(),
    ...reservations.values(),
  );
  const rows = rowsFor(maxParallelOf(rm), highest);
  const chairs = assignMeetingChairs(rm);
  const ctx: Ctx = { ...args, rm, rows, assignment, chairs };
  const seats = officeSeats(ctx);
  const needs = needsOf(rm, args);
  const anchors: Record<string, Point> = { ...fixedAnchors(rows) };
  for (let desk = 0; desk < rows * DESKS_PER_ROW; desk++)
    anchors[`desk:${desk}`] = deskSeat(desk);
  for (const [seatId, chair] of chairs)
    anchors[`meeting:${seatId}`] = MEETING_CHAIRS[chair]!;
  for (const seat of rm.seats)
    if (seat.attempts.some((a) => a.purpose === 'facilitator'))
      anchors[`meeting:${seat.seatId}`] = MEETING_FACILITATOR;
  for (const seat of seats) {
    anchors[`seat:${seat.seatId}`] = { x: seat.x, y: seat.y };
    if (seat.itemKey !== undefined && seat.desk !== undefined)
      anchors[`workitem:${seat.itemKey}`] = deskSeat(seat.desk);
  }
  for (const [itemKey, desk] of reservations)
    anchors[`workitem:${itemKey}`] = deskSeat(desk);

  return {
    workflowId: rm.workflowId,
    world: worldSize(rows),
    stageKind: currentStage(rm)?.kind ?? null,
    seats,
    reserved: reservedDesks(ctx, reservations),
    rooms: rooms(ctx),
    whiteboard: whiteboard(ctx),
    inbox: inbox(rm, args.t),
    yourDesk: yourDesk(ctx, needs),
    conveyor: conveyor(rm, args.t),
    parcels: parcels(ctx),
    paperStacks: paperStacks(ctx),
    hush: hush(rm, args.t),
    door: door(rm, args.t),
    needs,
    usage: usage(rm, args.t),
    anchors: anchors as Record<AnchorId, Point>,
  };
}

// -- helpers shared with the board -----------------------------------------

export function maxParallelOf(rm: ReadModel): number {
  const stage = rm.template.stages.find((s) => s.kind === 'implement');
  return stage?.kind === 'implement' ? stage.maxParallel : 0;
}

/** Desks on the floor for the template's `maxParallel` (D10). */
export const deskCapacity = (rm: ReadModel) =>
  rowsFor(maxParallelOf(rm)) * DESKS_PER_ROW;

export const currentStage = (rm: ReadModel) =>
  rm.stages.find((s) => s.stageId === rm.currentStageId);

const implementView = (rm: ReadModel) =>
  rm.stages.find((s) => s.kind === 'implement');

/** Approved items without a seat yet keep a desk while the implement stage runs. */
function reservableItems(rm: ReadModel): string[] {
  if (implementView(rm)?.status !== 'running') return [];
  return rm.workItems
    .filter((w) => w.status === 'approved' && w.seatId === undefined)
    .map((w) => w.key);
}

export const whoOf = (
  t: Translate,
  seat: Pick<SeatView, 'role' | 'itemKey'>,
) =>
  seat.itemKey === undefined
    ? seat.role
    : t('office.seat.who', { role: seat.role, item: seat.itemKey });

const vendorName = (t: Translate, vendor: SeatView['agent']) =>
  t(vendor === null ? 'office.vendor.unknown' : `office.vendor.${vendor}`);

/** Gates and escalated questions waiting for the user, oldest first. */
export function needsOf(rm: ReadModel, { now, t }: SelectorArgs): Need[] {
  const needs: Need[] = [];
  const add = (need: Omit<Need, 'subtitle' | 'ariaLabel'>) => {
    const elapsed = formatElapsed(t, need.since, now, true);
    needs.push({
      ...need,
      subtitle: t('office.need.waited', { elapsed }),
      ariaLabel: t('office.need.aria', { title: need.title, elapsed }),
    });
  };
  const seatOf = (seatId: string) => rm.seats.find((s) => s.seatId === seatId);
  const questionTitle = (questionId: string) => {
    const q = rm.questions.find((q) => q.questionId === questionId);
    const seat = q && seatOf(q.seatId);
    return seat
      ? t('office.need.question', { who: whoOf(t, seat) })
      : undefined;
  };
  const open = rm.gates.filter((g) => g.status === 'open');
  for (const gate of open) {
    const questionId =
      gate.questionId ??
      (gate.content.type === 'exception' ? gate.content.questionId : undefined);
    add({
      id: `gate:${gate.gateId}`,
      kind: questionId === undefined ? 'gate' : 'question',
      gateId: gate.gateId,
      ...(questionId === undefined ? {} : { questionId }),
      title:
        (questionId === undefined ? undefined : questionTitle(questionId)) ??
        gate.title,
      href:
        questionId === undefined
          ? `/gates/${gate.gateId}`
          : `/questions/${questionId}`,
      since: gate.openedAt,
      testId: `need-gate-${gate.gateId}`,
    });
  }
  for (const q of rm.questions) {
    if (q.status !== 'escalated') continue;
    if (open.some((g) => g.gateId === q.escalation?.gateId)) continue;
    add({
      id: `question:${q.questionId}`,
      kind: 'question',
      questionId: q.questionId,
      seatId: q.seatId,
      title: questionTitle(q.questionId) ?? q.role,
      href: `/questions/${q.questionId}`,
      since: q.escalation?.at ?? q.askedAt,
      testId: `need-question-${q.questionId}`,
    });
  }
  for (const seat of rm.seats) {
    const attempt = seat.attempts.find(
      (a) => a.attemptId === seat.currentAttemptId,
    );
    if (attempt?.state !== 'waiting_input') continue;
    add({
      id: `seat:${seat.seatId}`,
      kind: 'seat',
      seatId: seat.seatId,
      title: t('office.need.seat', { who: whoOf(t, seat) }),
      since: attempt.waitingSince ?? attempt.startedAt,
      testId: `need-seat-${seat.seatId}`,
    });
  }
  return needs.sort(
    (a, b) =>
      Date.parse(a.since) - Date.parse(b.since) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

// -- seats -------------------------------------------------------------------

function officeSeats(ctx: Ctx): OfficeSeat[] {
  const { rm, rows, assignment, chairs } = ctx;
  let lounge = 0;
  return rm.seats.map((seat) => {
    const state = seatState(rm, seat);
    const placeAttempt = state.attempt ?? seat.attempts.at(-1);
    const ondemand = state.attempt?.ondemand?.purpose;
    const desk = assignment.desks.get(seat.seatId);
    const place = placeFor(
      placeAttempt?.purpose,
      placeAttempt?.ondemand?.purpose,
      desk !== undefined,
    );
    let pos: Point;
    let plate: Point;
    let chair: number | 'facilitator' | undefined;
    switch (place) {
      case 'desk':
        pos = deskSeat(desk!);
        plate = deskPlate(desk!);
        break;
      case 'meeting':
        if (placeAttempt?.purpose === 'facilitator') {
          chair = 'facilitator';
          pos = MEETING_FACILITATOR;
        } else {
          chair = chairs.get(seat.seatId) ?? 0;
          pos = MEETING_CHAIRS[chair]!;
        }
        plate = meetingPlate(pos);
        break;
      case 'lead':
        pos = LEAD_SEAT;
        plate = LEAD_PLATE;
        break;
      case 'counter':
        pos = COUNTER_SEAT;
        plate = COUNTER_PLATE;
        break;
      case 'lounge':
        pos = loungeSeat(lounge++, rows);
        plate = { x: pos.x + 8, y: pos.y + 34 };
        break;
    }
    const meeting = currentStage(rm)?.meeting;
    const statement =
      place === 'meeting' && state.pose !== 'away' && !meeting?.concluded
        ? meeting?.statements.findLast(
            (entry) =>
              entry.round === meeting.round &&
              entry.attemptId === seat.currentAttemptId,
          )
        : undefined;
    const selected = ctx.selectedSeatId === seat.seatId;
    const status = seatStatus(ctx, seat, state);
    const vendor = state.attempt?.agent ?? seat.agent;
    const who = whoOf(ctx.t, seat);
    const badge = badgeOf(vendor);
    const tone: NameplateTone = selected
      ? 'selected'
      : state.pose === 'needs-you'
        ? 'need'
        : state.pose === 'error'
          ? 'error'
          : 'plain';
    return {
      ...(statement && meeting
        ? {
            bubble: {
              position: statement.position,
              round: statement.round,
              maxRounds: meeting.maxRounds,
              label: ctx.t('office.meeting.bubble', {
                role: seat.role,
                round: statement.round,
                max: meeting.maxRounds,
                position: statement.position,
              }),
            },
          }
        : {}),
      seatId: seat.seatId,
      attemptId: seat.currentAttemptId ?? null,
      role: seat.role,
      ...(seat.itemKey === undefined ? {} : { itemKey: seat.itemKey }),
      vendor,
      accessory: assignment.accessories.get(seat.seatId) ?? 'default',
      pose: state.pose,
      screen: screenOf(seat, state),
      lamp: state.pose === 'needs-you' ? 'amber' : 'off',
      place,
      ...(desk === undefined || place !== 'desk' ? {} : { desk }),
      ...(chair === undefined ? {} : { chair }),
      x: pos.x,
      y: pos.y,
      nameplate: {
        title: seat.itemKey ?? seat.role,
        subtitle: status,
        ...(badge ? { badge } : {}),
        tone,
        ...plate,
      },
      ariaLabel:
        state.pose === 'away'
          ? ctx.t('office.seat.ariaAway', { who, status })
          : ctx.t('office.seat.aria', {
              who,
              vendor: vendorName(ctx.t, vendor),
              status,
            }),
      testId: `seat-${seat.seatId}`,
      needsYou: state.pose === 'needs-you',
      error: state.pose === 'error',
      degraded: state.pose !== 'away' && (state.attempt?.degraded ?? false),
      ...(ondemand === undefined ? {} : { ondemand }),
      selected,
      state: state.attempt?.state ?? null,
    };
  });
}

function seatStatus(ctx: Ctx, seat: SeatView, state: SeatState): string {
  const { rm, t, now } = ctx;
  const attempt = state.attempt;
  const item = rm.workItems.find((w) => w.key === seat.itemKey);
  let status: string;
  switch (state.pose) {
    case 'needs-you': {
      const need = state.need!;
      const reason =
        need.kind === 'waiting'
          ? t('office.seat.waitingInput')
          : need.kind === 'question'
            ? t('office.seat.question')
            : t('office.seat.exception', { title: need.gate.title });
      status = t('office.seat.statusElapsed', {
        status: reason,
        elapsed: formatElapsed(t, need.since, now, true),
      });
      break;
    }
    case 'error':
      status = t('office.pose.error');
      break;
    case 'working': {
      const a = attempt!;
      const merging =
        a.ondemand?.purpose === 'merge' ? mergingPr(rm) : undefined;
      const doing =
        merging === undefined
          ? t(`office.purpose.${a.purpose}`)
          : t('office.purpose.merge', { pr: merging });
      status = t('office.seat.statusElapsed', {
        status: doing,
        elapsed: formatElapsed(t, a.startedAt, now),
      });
      if (a.usage.budgetTokens > 0)
        status = t('office.seat.withTokens', {
          status,
          tokens: formatTokens(a.usage.budgetTokens),
        });
      break;
    }
    case 'idle':
      status = t('office.pose.idle');
      break;
    case 'away':
      status =
        item?.pr !== undefined &&
        (item.status === 'merge_queued' || item.status === 'in_review')
          ? t('office.seat.awayAtCounter', { pr: item.pr.number })
          : t('office.seat.away');
      break;
  }
  if (state.pose === 'away') return status;
  if (rateLimited(attempt, now))
    status = t('office.seat.tagged', {
      tag: t('office.seat.rateLimited'),
      status,
    });
  if (attempt?.degraded)
    status = t('office.seat.tagged', {
      tag: t('office.seat.degraded'),
      status,
    });
  if (attempt?.ondemand?.purpose === 'oncall')
    status = t('office.seat.tagged', { tag: t('office.seat.oncall'), status });
  return status;
}

/** PR number the merge-queue integrator is reviewing, if any. */
function mergingPr(rm: ReadModel): number | undefined {
  const current = implementView(rm)?.ondemand?.merge?.current;
  const item =
    rm.workItems.find((w) => w.key === current) ??
    rm.workItems.find((w) => w.status === 'in_review');
  return item?.pr?.number;
}

function reservedDesks(
  ctx: Ctx,
  reservations: Map<string, number>,
): ReservedDesk[] {
  const { rm, t } = ctx;
  return [...reservations].map(([itemKey, desk]) => {
    const blockedBy = blockedByOf(rm, itemKey);
    const status =
      blockedBy.length > 0
        ? t('office.reserved.blocked', { deps: listOf(t, blockedBy) })
        : t('office.reserved.ready');
    return {
      itemKey,
      desk,
      ...deskSeat(desk),
      blockedBy,
      nameplate: {
        title: itemKey,
        subtitle: t('office.reserved.plate', { status }),
        tone: 'plain',
        ...deskPlate(desk),
      },
      ariaLabel: t('office.reserved.aria', { item: itemKey, status }),
      testId: `desk-reserved-${itemKey}`,
    };
  });
}

// -- rooms and props -----------------------------------------------------------

function rooms({ rows, t }: Ctx): Room[] {
  return roomPlan(rows).map(({ id, rect, plate }) => {
    const label = t(`office.room.${id}`);
    return {
      id,
      rect,
      label,
      plate,
      ariaLabel: t('office.room.zoom', { room: label }),
      testId: `room-${id}`,
    };
  });
}

const ACTIVE = new Set([
  'dispatched',
  'in_progress',
  'pushed',
  'pr_open',
  'rework',
  'needs_attention',
]);

function whiteboard({ rm, t }: Ctx): Whiteboard {
  const tokens = t('office.whiteboard.tokens', {
    tokens: formatTokens(rm.usage.total.budgetTokens),
  });
  const stage = currentStage(rm);
  const stageGate = rm.gates.find(
    (g) => g.status === 'open' && g.kind === 'stage',
  );
  const counts = () =>
    t('office.whiteboard.counts', {
      active: rm.workItems.filter((w) => ACTIVE.has(w.status)).length,
      review: rm.workItems.filter(
        (w) => w.status === 'merge_queued' || w.status === 'in_review',
      ).length,
      waiting: rm.workItems.filter((w) => w.status === 'approved').length,
    });
  let title: string;
  let lines: string[];
  if (rm.status !== 'running') {
    title = t(`office.stage.${rm.status}`);
    lines = rm.workItems.length > 0 ? [counts(), tokens] : [tokens];
  } else if (stageGate) {
    title = t('office.stage.awaiting-gate');
    lines = [
      t('office.whiteboard.gate', { title: stageGate.title }),
      t('office.whiteboard.quiet'),
      tokens,
    ];
  } else if (stage?.kind === 'meeting' && stage.meeting) {
    const { round, maxRounds, statements } = stage.meeting;
    lines = [
      t('office.whiteboard.round', { round, max: maxRounds }),
      t('office.whiteboard.ready', {
        n: statements.filter((s) => s.round === round && s.readyToConclude)
          .length,
      }),
      tokens,
    ];
    title = t('office.stage.meeting');
  } else if (stage) {
    title = t(`office.stage.${stage.kind}`);
    lines = stage.kind === 'implement' ? [counts(), tokens] : [tokens];
  } else {
    title = t('office.stage.none');
    lines = [tokens];
  }
  return {
    title,
    lines,
    ariaLabel: t('office.whiteboard.aria'),
    testId: 'office-whiteboard',
  };
}

const INBOX_LIMIT = 6;

function inbox(rm: ReadModel, t: Translate): OfficeViewModel['inbox'] {
  // Newest first; the sort is stable, so equal timestamps keep creation order.
  const items: InboxItem[] = rm.artifacts
    .filter((a) => a.kind === 'issue' || a.kind === 'pr')
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .flatMap((a) =>
      (a.kind === 'issue' || a.kind === 'pr') && a.number !== undefined
        ? [
            {
              artifactId: a.artifactId,
              kind: a.kind,
              number: a.number,
              ...(a.url === undefined ? {} : { url: a.url }),
              label: t(
                a.kind === 'pr' ? 'office.inbox.pr' : 'office.inbox.issue',
                {
                  n: a.number,
                },
              ),
              testId: `inbox-${a.artifactId}`,
            },
          ]
        : [],
    )
    .slice(0, INBOX_LIMIT);
  return {
    label: t('office.inbox.title'),
    items,
    ariaLabel: t('office.inbox.aria', { n: items.length }),
    testId: 'office-inbox',
  };
}

function yourDesk({ rm, t, now }: Ctx, needs: Need[]): YourDesk {
  const waiting = needs.filter((n) => n.kind !== 'seat');
  const first = waiting[0];
  if (first) {
    const elapsed = formatElapsed(t, first.since, now, true);
    const status =
      waiting.length > 1
        ? t('office.desk.more', { title: first.title, n: waiting.length })
        : t('office.desk.waiting', { title: first.title, elapsed });
    return {
      lamp: 'amber',
      paper: true,
      bang: true,
      nameplate: {
        title: first.title,
        subtitle: t('office.need.waited', { elapsed }),
        tone: 'need',
        ...YOUR_DESK_PLATE,
      },
      ariaLabel: t('office.desk.aria', { status }),
      testId: 'office-your-desk',
    };
  }
  const next = rm.status === 'running' ? nextGateTitle(rm) : undefined;
  const status =
    next === undefined
      ? t('office.desk.idle')
      : t('office.desk.next', { title: next });
  return {
    lamp: 'off',
    paper: false,
    bang: false,
    nameplate: {
      title: t('office.desk.title'),
      subtitle: status,
      tone: 'plain',
      ...YOUR_DESK_PLATE,
    },
    ariaLabel: t('office.desk.aria', { status }),
    testId: 'office-your-desk',
  };
}

/** The current stage's own gate, when enabled: "next: conclusion" on your desk. */
function nextGateTitle(rm: ReadModel): string | undefined {
  const stage = rm.template.stages.find((s) => s.id === rm.currentStageId);
  if (!stage || !('gate' in stage)) return undefined;
  return rm.gateToggles[stage.gate.id] === false ? undefined : stage.gate.title;
}

function queueOf(rm: ReadModel): { queue: string[]; current?: string } {
  const merge = implementView(rm)?.ondemand?.merge;
  const known = new Set(rm.workItems.map((w) => w.key));
  const queue = (merge?.queue ?? []).filter((k) => known.has(k));
  for (const w of rm.workItems)
    if (w.status === 'merge_queued' && !queue.includes(w.key))
      queue.push(w.key);
  const current =
    merge?.current !== undefined && known.has(merge.current)
      ? merge.current
      : rm.workItems.find(
          (w) => w.status === 'in_review' && !queue.includes(w.key),
        )?.key;
  return current === undefined ? { queue } : { queue, current };
}

function conveyor(rm: ReadModel, t: Translate): Conveyor {
  const stage = implementView(rm);
  const open = stage !== undefined && stage.status !== 'pending';
  const { queue, current } = queueOf(rm);
  const merged = rm.workItems.filter((w) => w.status === 'merged').length;
  return {
    open,
    queue,
    ...(current === undefined ? {} : { current }),
    label: !open
      ? t('office.conveyor.closed')
      : queue.length > 0
        ? t('office.conveyor.queued', { n: queue.length })
        : t('office.conveyor.empty'),
    merged,
    cartLabel: t('office.cart.merged', { n: merged }),
  };
}

function parcels({ rm, assignment }: Ctx): Parcel[] {
  const pr = (key: string) => {
    const n = rm.workItems.find((w) => w.key === key)?.pr?.number;
    return n === undefined ? {} : { pr: n };
  };
  const { queue, current } = queueOf(rm);
  const out: Parcel[] = queue.map((itemKey, slot) => ({
    itemKey,
    ...pr(itemKey),
    place: 'queue',
    slot,
    ...queueSlot(slot),
  }));
  if (current !== undefined)
    out.push({
      itemKey: current,
      ...pr(current),
      place: 'counter',
      slot: 0,
      ...COUNTER_PARCEL,
    });
  for (const w of rm.workItems) {
    if (w.status !== 'rework' || w.seatId === undefined) continue;
    const desk = assignment.desks.get(w.seatId);
    if (desk === undefined) continue;
    out.push({
      itemKey: w.key,
      ...pr(w.key),
      place: 'desk',
      slot: desk,
      ...deskParcel(desk),
    });
  }
  return out;
}

function paperStacks({ rm, assignment }: Ctx): PaperStack[] {
  return [...assignment.lastSeatAt]
    .sort(([a], [b]) => a - b)
    .flatMap(([desk, seatId]) => {
      const tokens =
        rm.seats.find((s) => s.seatId === seatId)?.usage.budgetTokens ?? 0;
      const sheets = sheetsFor(tokens);
      return sheets === 0 ? [] : [{ desk, sheets, ...deskStack(desk) }];
    });
}

function hush(rm: ReadModel, t: Translate): OfficeViewModel['hush'] {
  const gate = rm.gates.find((g) => g.status === 'open' && g.kind === 'stage');
  return {
    active: gate !== undefined,
    ...(gate ? { gateId: gate.gateId } : {}),
    lit: LIT_AREA,
    label: t('office.hush.label'),
  };
}

function door(rm: ReadModel, t: Translate): OfficeViewModel['door'] {
  const open =
    rm.status === 'completed' ||
    rm.gates.some(
      (g) => g.stageKind === 'final-pr' && g.closeReason === 'merged',
    );
  return { open, label: t(open ? 'office.door.open' : 'office.door.closed') };
}

/** D12: usage only; G8 marks "budget disabled" when the optional flag says off. */
function usage(rm: ReadModel, t: Translate): OfficeViewModel['usage'] {
  const total = rm.usage.total.budgetTokens;
  const enforcement = (rm.limits as { budgetEnforcement?: unknown })
    .budgetEnforcement;
  const budgetDisabled = enforcement === 'off';
  return {
    totalTokens: total,
    label: t('office.usage.total', { tokens: formatTokens(total) }),
    sheets: sheetsFor(total),
    budgetDisabled,
    ...(budgetDisabled
      ? { budgetLabel: t('office.usage.budgetDisabled') }
      : {}),
  };
}
