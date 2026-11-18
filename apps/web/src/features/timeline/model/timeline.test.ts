import { expect, test } from 'vitest';
import { t } from '../../../shared/lib/i18n/index.js';
import { mainline } from '../../../test-support/office/mainline.js';
import {
  domainEvent,
  workflowEvents,
} from '../../../realtime/test-support/events.js';
import { messagesAt, positionAt, timelineModel } from './timeline.js';

test('segments preserve stage reruns, and gate/PR markers point to their exact events', () => {
  const log = mainline();
  const model = timelineModel(log.events, t);
  expect(model.segments.map((s) => s.label)).toEqual([
    t('timeline.start'),
    ...['meeting', 'planning', 'implement', 'integrate', 'final-pr'].map(
      (stage) =>
        t('timeline.attempt', {
          stage: t(`stage.${stage}` as 'stage.meeting'),
          attempt: 1,
        }),
    ),
  ]);
  for (const segment of model.segments)
    expect(segment.endIndex).toBeGreaterThanOrEqual(segment.index);
  for (const marker of model.markers)
    expect(log.events[marker.index]?.seq).toBe(marker.seq);
  expect(model.markers.some((m) => m.kind === 'gate')).toBe(true);
  expect(model.markers.some((m) => m.label.includes('已合併'))).toBe(true);
  const rerun = domainEvent('stage.started', log.events.length + 1, {
    stageId: 'meeting',
    kind: 'meeting',
    attempt: 2,
    mode: 'rerun',
  });
  expect(
    timelineModel([...log.events, rerun], t).segments.at(-1)?.label,
  ).toContain(t('timeline.attempt', { stage: t('stage.meeting'), attempt: 2 }));
});

test('coordination summaries cover messages, dispatch/rework/merge without exposing bodies', () => {
  const events = [
    domainEvent('message.question', 1, {
      questionId: 'q',
      attemptId: 'a',
      body: 'private body',
    }),
    domainEvent('message.forwarded', 2, {
      questionId: 'q',
      to: 'on-call',
      toAttemptId: 'b',
      retry: 0,
    }),
    domainEvent('message.answered', 3, {
      questionId: 'q',
      by: 'agent',
      attemptId: 'b',
      body: 'private body',
    }),
    domainEvent('message.answered', 4, {
      questionId: 'q',
      by: 'user',
      body: 'private body',
    }),
    domainEvent('message.answered', 5, {
      questionId: 'q',
      by: 'agent',
      body: 'private body',
    }),
    domainEvent('message.escalated', 6, {
      questionId: 'q',
      reason: 'timeout',
      gateId: 'g',
    }),
    domainEvent('message.nudge', 7, {
      attemptId: 'a',
      reason: 'item-timeout',
      subject: 's',
      body: 'private body',
    }),
    domainEvent('message.instruction', 8, {
      seatId: 'seat',
      attemptId: 'a',
      subject: 's',
      body: 'private body',
    }),
  ];
  const model = timelineModel(events, t);
  expect(model.messages).toHaveLength(8);
  expect(JSON.stringify(model)).not.toContain('private body');
  const main = timelineModel(mainline().events, t);
  expect(main.messages.some((m) => m.label.includes('rework'))).toBe(true);
  expect(
    main.messages.some(
      (m) => m.label === t('timeline.message.dispatch', { item: 'feature' }),
    ),
  ).toBe(true);
  expect(
    main.messages.some(
      (m) => m.label === t('timeline.message.merge', { item: 'feature' }),
    ),
  ).toBe(true);
});

test('only closed/merged PR statuses become markers, not routine status refreshes or other artifacts', () => {
  const log = mainline();
  const status = log.events.find((e) => e.type === 'pr.status')!;
  if (status.type !== 'pr.status') throw new Error('fixture');
  const model = timelineModel(
    [
      status,
      {
        ...status,
        seq: status.seq + 1,
        payload: { ...status.payload, state: 'closed' },
      },
    ],
    t,
  );
  expect(model.markers).toHaveLength(1);
  expect(model.markers[0]?.label).toBe(
    t('timeline.prClosed', { number: status.payload.pr }),
  );
});

test('sparse global seq maps to event ordinals, including empty/before/after bounds', () => {
  const { points } = timelineModel(workflowEvents(3, 'wf1', 20, 10), t);
  expect(
    [0, 20, 29, 30, 40, 999].map((seq) => positionAt(points, seq)),
  ).toEqual([0, 0, 0, 1, 2, 2]);
  expect(positionAt([], 999)).toBe(0);
  expect(timelineModel([], t)).toEqual({
    points: [],
    segments: [],
    markers: [],
    messages: [],
  });
});

test('coordination list is bounded and never shows future messages', () => {
  const messages = Array.from({ length: 100 }, (_, index) => ({
    index,
    seq: 10 + index * 2,
    at: '',
    label: '',
  }));
  expect(messagesAt([], 0)).toEqual([]);
  expect(messagesAt(messages, 0)).toEqual([]);
  expect(messagesAt(messages, 10)).toEqual([messages[0]]);
  expect(messagesAt(messages, 115)).toHaveLength(50);
  expect(messagesAt(messages, 115)[0]?.seq).toBe(114);
});
