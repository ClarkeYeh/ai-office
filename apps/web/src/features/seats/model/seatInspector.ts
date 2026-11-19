import type { SeatView } from '@ai-office/contracts/api';
import type { DomainEvent } from '@ai-office/contracts/events';
import type { ReadModel } from '@ai-office/projection';
import type { SeatsTranslator } from '../../../shared/lib/i18n/seats.js';

export type InspectorArgs = {
  seatId: string | null;
  now: number;
  replaying: boolean;
  events: readonly DomainEvent[];
  t: SeatsTranslator;
};
export function messageDisabled(
  model: ReadModel,
  seat: SeatView,
  replaying: boolean,
  t: SeatsTranslator,
): string | null {
  if (replaying) return t('seats.disabled.replay');
  if (model.status !== 'running' || model.cancelRequested)
    return t('seats.disabled.workflow');
  const a = seat.attempts.find((a) => a.attemptId === seat.currentAttemptId);
  if (
    !a ||
    a.released ||
    a.endedAt ||
    a.state === 'exited' ||
    a.state === 'lost'
  )
    return t('seats.disabled.away');
  if (
    a.purpose === 'facilitator' ||
    a.purpose === 'participant' ||
    model.stages.find((s) => s.stageId === a.stageId)?.kind === 'meeting'
  )
    return t('seats.disabled.meeting');
  return null;
}

export function seatInspector(model: ReadModel | null, args: InspectorArgs) {
  const { seatId, now, t, events, replaying } = args;
  const seat = model?.seats.find((s) => s.seatId === seatId);
  if (!model || !seat) return null;
  const attempt = seat.attempts.find(
    (a) => a.attemptId === seat.currentAttemptId,
  );
  const stage = model.stages.find((s) => s.stageId === attempt?.stageId);
  const ownAttempts = new Set(seat.attempts.map((a) => a.attemptId));
  const relevant = events.filter(
    (e) => e.workflowId === model.workflowId && e.seq <= model.lastSeq,
  );
  const lastReview = relevant.findLast(
    (e) =>
      e.type === 'workitem.rework_requested' &&
      ownAttempts.has(e.payload.attemptId),
  );
  const itemKey =
    seat.currentWorkItem ??
    seat.itemKey ??
    (attempt?.ondemand?.purpose === 'merge'
      ? stage?.ondemand?.merge?.current
      : undefined) ??
    (lastReview?.type === 'workitem.rework_requested'
      ? lastReview.payload.itemKey
      : undefined);
  const item = model.workItems.find((i) => i.key === itemKey);
  // M4_PLAN §5.3: M2's optional camelCase object is authoritative until explicitly cleared.
  const rateLimited = attempt?.rateLimited;
  // G9: an estimated reset still ahead is shown in whole minutes, rounded up.
  const resetsIn = rateLimited?.resetsAt
    ? Math.ceil((Date.parse(rateLimited.resetsAt) - now) / 60_000)
    : 0;
  const state = rateLimited
    ? resetsIn > 0
      ? t('seats.rateLimitedUntil', { n: resetsIn })
      : t('seats.rateLimited')
    : attempt
      ? t(`office.attemptState.${attempt.state}`)
      : t('office.seat.away');
  const age = (at: string) => {
    const n = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
    return n ? t('seats.ago', { n }) : t('seats.justNow');
  };
  const activity = new Map<
    string,
    {
      id: string;
      category: SeatView['recentActivity'][number]['category'];
      label: string;
      count: number;
      at: string;
      age: string;
    }
  >();
  for (const a of seat.recentActivity) {
    const id = `${a.category}:${a.tool ?? ''}`;
    const previous = activity.get(id);
    activity.set(id, {
      id,
      category: a.category,
      label: a.tool ?? t(`seats.${a.category}`),
      count: (previous?.count ?? 0) + 1,
      at: a.at,
      age: age(a.at),
    });
  }
  const reviews = relevant.flatMap((e) =>
    e.type === 'workitem.rework_requested' &&
    (ownAttempts.has(e.payload.attemptId) || e.payload.itemKey === itemKey)
      ? [
          {
            id: e.seq,
            title: t('seats.review', { pr: e.payload.pr, n: e.payload.rework }),
            reasons: e.payload.reasons,
            at: e.occurredAt,
          },
        ]
      : [],
  );
  const reviewCount = relevant.filter(
    (e) =>
      e.type === 'workitem.status' &&
      e.payload.status === 'in_review' &&
      e.payload.itemKey === itemKey,
  ).length;
  const statements = model.stages.flatMap((s) =>
    (s.meeting?.statements ?? [])
      .filter((s) => ownAttempts.has(s.attemptId))
      .map((s) => {
        const artifact = model.acceptedSubmissions[s.artifactId];
        return {
          id: s.artifactId,
          round: t('seats.round', { n: s.round }),
          position: s.position,
          arguments:
            artifact?.kind === 'statement' ? artifact.payload.arguments : [],
          concerns:
            artifact?.kind === 'statement' ? artifact.payload.concerns : [],
        };
      }),
  );
  return {
    seatId: seat.seatId,
    workflowId: model.workflowId,
    attemptId: attempt?.attemptId ?? null,
    role: seat.role,
    vendor: t(`office.vendor.${seat.agent ?? 'unknown'}`),
    agent: seat.agent,
    badge:
      seat.agent === 'codex' ? 'CX' : seat.agent === 'claude-code' ? 'CC' : '',
    ondemand: attempt?.ondemand ? t(`seats.${attempt.ondemand.purpose}`) : null,
    state,
    degraded: seat.degraded,
    doing:
      item?.title ??
      (attempt ? t(`office.purpose.${attempt.purpose}`) : t('seats.noWork')),
    attempt: t('seats.attempt', { n: attempt?.attempt ?? 0 }),
    reworks: item?.reworks ?? 0,
    tokens: seat.usage.budgetTokens.toLocaleString('zh-TW'),
    activity: [...activity.values()].sort((a, b) => b.at.localeCompare(a.at)),
    reviews,
    reviewCount,
    statements,
    errors: seat.errors.map((e) => ({
      id: e.seq,
      code: e.code,
      message: e.message,
      at: e.at,
    })),
    attempts: seat.attempts.toReversed().map((a) => ({
      id: a.attemptId,
      label: t('seats.historyEntry', {
        n: a.attempt,
        state: t(`office.attemptState.${a.state}`),
      }),
      at: a.startedAt,
      tokens: a.usage.budgetTokens.toLocaleString('zh-TW'),
    })),
    disabledReason: messageDisabled(model, seat, replaying, t),
  };
}
export type SeatInspectorVM = NonNullable<ReturnType<typeof seatInspector>>;

export type InspectorEvent = DomainEvent;
