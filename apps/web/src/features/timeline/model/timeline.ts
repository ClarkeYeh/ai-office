import type { DomainEvent } from '@ai-office/contracts/events';
import { hasMessage, type Translator } from '../../../shared/lib/i18n/index.js';

export interface TimelinePoint {
  index: number;
  seq: number;
  at: string;
  label: string;
}
export interface TimelineSegment extends TimelinePoint {
  endIndex: number;
}
export interface TimelineMarker extends TimelinePoint {
  kind: 'gate' | 'pr';
}
export interface TimelineModel {
  points: TimelinePoint[];
  segments: TimelineSegment[];
  markers: TimelineMarker[];
  messages: TimelinePoint[];
}

/** Build once per event-log snapshot, never on every scrubber movement. */
export function timelineModel(
  events: readonly DomainEvent[],
  t: Translator,
): TimelineModel {
  const points: TimelinePoint[] = [];
  const segments: TimelineSegment[] = [];
  const markers: TimelineMarker[] = [];
  const messages: TimelinePoint[] = [];
  for (const [index, event] of events.entries()) {
    const point = { index, seq: event.seq, at: event.occurredAt, label: '' };
    points.push(point);
    if (event.type === 'workflow.started' || event.type === 'stage.started') {
      const previous = segments.at(-1);
      if (previous) previous.endIndex = index - 1;
      const label =
        event.type === 'workflow.started'
          ? t('timeline.start')
          : t('timeline.attempt', {
              stage: t(`stage.${event.payload.kind}`),
              attempt: event.payload.attempt,
            });
      segments.push({ ...point, label, endIndex: events.length - 1 });
    }
    if (event.type === 'gate.opened') {
      markers.push({
        ...point,
        kind: 'gate',
        label: t('timeline.gate', { title: event.payload.title }),
      });
    } else if (
      event.type === 'artifact.created' &&
      event.payload.kind === 'pr'
    ) {
      markers.push({
        ...point,
        kind: 'pr',
        label: t('timeline.pr', { number: event.payload.number }),
      });
    } else if (event.type === 'pr.status' && event.payload.state !== 'open') {
      markers.push({
        ...point,
        kind: 'pr',
        label: t(
          event.payload.state === 'merged'
            ? 'timeline.prMerged'
            : 'timeline.prClosed',
          { number: event.payload.pr },
        ),
      });
    }
    const label = coordinationLabel(event, t);
    if (label) messages.push({ ...point, label });
  }
  return { points, segments, markers, messages };
}

/** Metadata summaries only: never display runtime transcripts or command bodies. */
function coordinationLabel(event: DomainEvent, t: Translator): string | null {
  switch (event.type) {
    case 'message.question':
      return t('timeline.message.question', { who: event.payload.attemptId });
    case 'message.forwarded':
      return t('timeline.message.forwarded', {
        who: event.payload.toAttemptId,
      });
    case 'message.answered':
      return t('timeline.message.answered', {
        who:
          event.payload.by === 'user'
            ? t('timeline.user')
            : (event.payload.attemptId ?? t('timeline.agent')),
      });
    case 'message.escalated':
      return t('timeline.message.escalated');
    case 'message.nudge': {
      const reason = `nudge.${event.payload.reason}`;
      return hasMessage(reason)
        ? t('timeline.message.nudgeReason', {
            who: event.payload.attemptId,
            reason: t(reason),
          })
        : t('timeline.message.nudge', { who: event.payload.attemptId });
    }
    case 'message.instruction':
      return t('timeline.message.instruction', {
        who: event.payload.attemptId,
      });
    case 'workitem.dispatched':
      return t('timeline.message.dispatch', { item: event.payload.itemKey });
    case 'workitem.rework_requested':
      return t('timeline.message.rework', { item: event.payload.itemKey });
    case 'workitem.merged':
      return t('timeline.message.merge', { item: event.payload.itemKey });
    default:
      return null;
  }
}

/** Event ordinal, not global seq: other workflows may leave large gaps in seq. */
export function positionAt(
  points: readonly TimelinePoint[],
  seq: number,
): number {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (points[mid]!.seq <= seq) low = mid + 1;
    else high = mid;
  }
  return Math.max(0, low - 1);
}

/** Bounded DOM while retaining the whole history for arbitrary seeks. */
export function messagesAt(
  messages: readonly TimelinePoint[],
  seq: number,
): readonly TimelinePoint[] {
  const end =
    messages.length && messages[0]!.seq <= seq
      ? positionAt(messages, seq) + 1
      : 0;
  return messages.slice(Math.max(0, end - 50), end).reverse();
}
