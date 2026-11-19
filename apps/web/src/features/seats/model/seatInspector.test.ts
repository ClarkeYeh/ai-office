import { expect, test } from 'vitest';
import { mainline } from '../../../test-support/office/mainline.js';
import { createLog, seatId } from '../../../test-support/office/log.js';
import {
  seatsT as t,
  seatsMessagesZhTW,
} from '../../../shared/lib/i18n/seats.js';
import { messageDisabled, seatInspector } from './seatInspector.js';
const log = mainline();
const args = {
  seatId: seatId('engineer', 'feature'),
  now: log.now,
  replaying: false,
  events: log.events,
  t,
};

test('selects safe metadata, usage and history without mutating the model', () => {
  const rm = log.at('implement');
  const before = structuredClone(rm);
  const vm = seatInspector(rm, args)!;
  expect(vm.vendor).toBe('Codex');
  expect(vm.tokens).toBe('220,000');
  expect(vm.attempts).toHaveLength(1);
  expect(vm.disabledReason).toBeNull();
  expect(vm.doing).toBe('Item feature');
  expect(rm).toEqual(before);
  expect(seatInspector(null, args)).toBeNull();
  expect(seatInspector(rm, { ...args, seatId: 'missing' })).toBeNull();
});

test('history respects the replay watermark, current item and reviewer attempt', () => {
  expect(seatInspector(log.at('review'), args)!.reviews).toHaveLength(0);
  const vm = seatInspector(log.at('rework'), args)!;
  expect(vm.reviews[0]?.reasons).toEqual(['missing tests']);
  expect(vm.reworks).toBe(1);
  expect(vm.reviewCount).toBe(1);
  const reviewer = seatInspector(log.at('rework'), {
    ...args,
    seatId: seatId('integrator'),
  })!;
  expect(reviewer.reviews).toHaveLength(1);
  expect(reviewer.ondemand).toBe(t('seats.merge'));
  expect(
    seatInspector(log.at('rework'), {
      ...args,
      events: log.events.map((e) => ({ ...e, workflowId: 'other' })),
    })!.reviews,
  ).toHaveLength(0);
});

test('meeting positions include accepted artifact arguments and concerns', () => {
  const rm = structuredClone(log.at('meeting'));
  const statement = rm.stages[0]!.meeting!.statements.find(
    (s) => s.role === 'pm',
  )!;
  rm.acceptedSubmissions[statement.artifactId] = {
    kind: 'statement',
    payload: {
      round: 1,
      position: 'Proceed',
      arguments: ['Small change'],
      concerns: ['Check tests'],
      readyToConclude: false,
    },
    submissionId: 'sub1',
    seatId: seatId('pm'),
    acceptedAtSeq: 1,
  };
  const vm = seatInspector(rm, { ...args, seatId: seatId('pm') })!;
  expect(vm.statements[0]?.arguments).toEqual(['Small change']);
  expect(vm.statements[0]?.concerns).toEqual(['Check tests']);
  expect(vm.disabledReason).toBe(t('seats.disabled.meeting'));
  expect(vm.badge).toBe('CC');
});

test('aggregates metadata categories and tool names with most recent time', () => {
  const l = createLog()
    .stage('implement', 'implement')
    .dispatch('a', 'a1')
    .status('a1', 'working');
  l.activity('a1', 'read')
    .activity('a1', 'read')
    .tick(120)
    .activity('a1', 'edit');
  const seat = l.model.seats[0]!;
  seat.recentActivity[0]!.tool = 'Read';
  seat.recentActivity[1]!.tool = 'Read';
  const vm = seatInspector(l.model, {
    ...args,
    seatId: seat.seatId,
    now: l.now,
  })!;
  expect(vm.activity.map((a) => [a.category, a.count, a.age])).toEqual([
    ['edit', 1, t('seats.justNow')],
    ['read', 2, t('seats.ago', { n: 2 })],
  ]);
  expect(vm.doing).toBe(t('office.purpose.worker'));
});

test('optional camelCase rateLimited is detected without a future deadline guess', () => {
  const rm = structuredClone(log.at('implement'));
  const a = rm.seats.find((s) => s.seatId === args.seatId)!.attempts.at(-1)!;
  Object.assign(a, {
    rateLimited: { since: a.startedAt, resetsAt: a.startedAt },
  });
  expect(seatInspector(rm, args)!.state).toBe(t('seats.rateLimited'));
  Object.assign(a, {
    rateLimited: {
      since: a.startedAt,
      resetsAt: new Date(args.now + 90_000).toISOString(),
    },
  });
  expect(seatInspector(rm, args)!.state).toBe(
    t('seats.rateLimitedUntil', { n: 2 }),
  );
  Object.assign(a, { rateLimited: null });
  expect(seatInspector(rm, args)!.state).toBe(t('office.attemptState.working'));
});

test('all message disabling states, including replay before its snapshot exists', () => {
  const rm = structuredClone(log.at('implement'));
  const seat = rm.seats.find((s) => s.seatId === args.seatId)!;
  const attempt = seat.attempts.at(-1)!;
  expect(messageDisabled(rm, seat, true, t)).toBe(t('seats.disabled.replay'));
  for (const state of ['exited', 'lost'] as const) {
    attempt.state = state;
    expect(messageDisabled(rm, seat, false, t)).toBe(t('seats.disabled.away'));
  }
  attempt.state = 'done';
  expect(messageDisabled(rm, seat, false, t)).toBeNull();
  attempt.released = true;
  expect(messageDisabled(rm, seat, false, t)).toBe(t('seats.disabled.away'));
  attempt.released = false;
  attempt.endedAt = attempt.startedAt;
  expect(messageDisabled(rm, seat, false, t)).toBe(t('seats.disabled.away'));
  delete attempt.endedAt;
  attempt.purpose = 'facilitator';
  expect(messageDisabled(rm, seat, false, t)).toBe(t('seats.disabled.meeting'));
  attempt.purpose = 'worker';
  rm.stages.find((s) => s.stageId === attempt.stageId)!.kind = 'meeting';
  expect(messageDisabled(rm, seat, false, t)).toBe(t('seats.disabled.meeting'));
  seat.attempts = [];
  expect(messageDisabled(rm, seat, false, t)).toBe(t('seats.disabled.away'));
  expect(seatInspector(rm, args)!.state).toBe(t('office.seat.away'));
  seat.agent = null;
  delete seat.currentWorkItem;
  delete seat.itemKey;
  const empty = seatInspector(rm, args)!;
  expect(empty.vendor).toBe(t('office.vendor.unknown'));
  expect(empty.doing).toBe(t('seats.noWork'));
  expect(empty.badge).toBe('');
  rm.cancelRequested = true;
  expect(messageDisabled(rm, seat, false, t)).toBe(
    t('seats.disabled.workflow'),
  );
  rm.cancelRequested = false;
  rm.status = 'completed';
  expect(messageDisabled(rm, seat, false, t)).toBe(
    t('seats.disabled.workflow'),
  );
});

test('error records and oncall state remain readable', () => {
  const rm = structuredClone(log.at('waiting'));
  const seat = rm.seats.find((s) => s.role === 'lead')!;
  seat.errors = [
    {
      seq: 1,
      at: rm.startedAt,
      code: 'runtime_failed',
      category: 'permanent',
      message: 'Runtime unavailable',
    },
  ];
  expect(
    seatInspector(rm, { ...args, seatId: seat.seatId })!.errors[0]?.code,
  ).toBe('runtime_failed');
  expect(seatInspector(rm, { ...args, seatId: seat.seatId })!.ondemand).toBe(
    t('seats.oncall'),
  );
});

test('catalog keys translate and interpolate while retaining unspecified placeholders', () => {
  for (const key of Object.keys(
    seatsMessagesZhTW,
  ) as (keyof typeof seatsMessagesZhTW)[])
    expect(t(key)).toBe(seatsMessagesZhTW[key]);
  expect(t('seats.messageTo', { role: 'engineer' })).toContain('engineer');
  expect(t('app.retry')).toBeTruthy();
});
