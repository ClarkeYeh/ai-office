import type { ReadModel } from '@ai-office/projection';
import { describe, expect, test } from 'vitest';
import {
  createLog,
  CONCLUSION_CONTENT,
  iso,
  keyT,
  seatId,
  zhT,
  type Log,
} from '../../../test-support/office/log.js';
import { stabilize } from '../../../shared/lib/stabilize.js';
import { officeViewModel } from './officeViewModel.js';
import type { OfficeSeat, OfficeViewModel } from './types.js';

const W = seatId('engineer', 'w1');

/** Implement stage with one dispatched item `w1` (attempt `w1-1`, working). */
function implementLog(options: { maxParallel?: number } = {}) {
  const log = createLog(options);
  log.stage('implement', 'implement');
  log.items('workitem.approved', [{ key: 'w1' }, { key: 'w2', deps: ['w1'] }]);
  log.tick().dispatch('w1', 'w1-1').status('w1-1', 'working');
  return log;
}
const vmOf = (log: Log, extra: { selectedSeatId?: string } = {}) =>
  officeViewModel(log.model, { now: log.now, t: keyT, ...extra });
const seatOf = (vm: OfficeViewModel, id = W): OfficeSeat =>
  vm.seats.find((s) => s.seatId === id)!;

describe('§2.6 seat state truth table', () => {
  type Row = {
    name: string;
    arrange: (log: Log) => void;
    pose: OfficeSeat['pose'];
    screen: OfficeSeat['screen'];
  };
  const rows: Row[] = [
    {
      name: 'waiting_input → needs you',
      arrange: (log) => log.tick(30).status('w1-1', 'waiting_input'),
      pose: 'needs-you',
      screen: 'dark',
    },
    {
      name: 'escalated question on the seat → needs you',
      arrange: (log) => {
        log.push('message.question', {
          questionId: 'q1',
          attemptId: 'w1-1',
          itemKey: 'w1',
          body: '?',
        });
        log.exceptionGate('g-q', 'question-escalation', 'Question', {
          questionId: 'q1',
        });
        log.push('message.escalated', {
          questionId: 'q1',
          reason: 'timeout',
          gateId: 'g-q',
        });
      },
      pose: 'needs-you',
      screen: 'dark',
    },
    {
      name: 'open exception gate on the attempt → needs you',
      arrange: (log) =>
        log.exceptionGate('g-a', 'decision-request', 'Decide', {
          attemptId: 'w1-1',
        }),
      pose: 'needs-you',
      screen: 'dark',
    },
    {
      name: 'open exception gate on the work item → needs you (beats error)',
      arrange: (log) => {
        log.status('w1-1', 'error');
        log.exceptionGate('g-i', 'workitem-failed', 'Failed', {
          itemKey: 'w1',
        });
      },
      pose: 'needs-you',
      screen: 'dark',
    },
    {
      name: 'decided exception gate no longer needs you',
      arrange: (log) => {
        log.exceptionGate('g-i', 'workitem-failed', 'Failed', {
          itemKey: 'w1',
        });
        log.decide('g-i', 'proceed');
      },
      pose: 'working',
      screen: 'other',
    },
    {
      name: 'gate for another item does not apply',
      arrange: (log) =>
        log.exceptionGate('g-o', 'workitem-failed', 'Failed', {
          itemKey: 'w2',
        }),
      pose: 'working',
      screen: 'other',
    },
    {
      name: 'error → error',
      arrange: (log) => log.status('w1-1', 'error'),
      pose: 'error',
      screen: 'error',
    },
    {
      name: 'lost → error',
      arrange: (log) => log.status('w1-1', 'lost'),
      pose: 'error',
      screen: 'error',
    },
    {
      name: 'starting → working',
      arrange: (log) => log.status('w1-1', 'starting'),
      pose: 'working',
      screen: 'other',
    },
    {
      name: 'working → working',
      arrange: () => {},
      pose: 'working',
      screen: 'other',
    },
    {
      name: 'idle → idle',
      arrange: (log) => log.status('w1-1', 'idle'),
      pose: 'idle',
      screen: 'dark',
    },
    {
      name: 'done → idle',
      arrange: (log) => log.status('w1-1', 'done'),
      pose: 'idle',
      screen: 'dark',
    },
    {
      name: 'idle but released → away',
      arrange: (log) => {
        log.status('w1-1', 'idle');
        log.push('seat.released', {
          attemptId: 'w1-1',
          removeWorkspace: false,
        });
      },
      pose: 'away',
      screen: 'off',
    },
    {
      name: 'exited → away',
      arrange: (log) => log.exit('w1-1', false),
      pose: 'away',
      screen: 'off',
    },
  ];
  test.each(rows)('$name', ({ arrange, pose, screen }) => {
    const log = implementLog();
    arrange(log);
    const seat = seatOf(vmOf(log));
    expect(seat.pose).toBe(pose);
    expect(seat.screen).toBe(screen);
    expect(seat.needsYou).toBe(pose === 'needs-you');
    expect(seat.error).toBe(pose === 'error');
    expect(seat.lamp).toBe(pose === 'needs-you' ? 'amber' : 'off');
    expect(seat.nameplate.tone).toBe(
      pose === 'needs-you' ? 'need' : pose === 'error' ? 'error' : 'plain',
    );
  });

  test('a seat without a current attempt is away', () => {
    const log = implementLog();
    const rm = structuredClone(log.model) as ReadModel;
    delete rm.seats[0]!.currentAttemptId;
    const seat = officeViewModel(rm, { now: log.now, t: keyT }).seats[0]!;
    expect(seat).toMatchObject({ pose: 'away', attemptId: null, state: null });
  });

  test('falls back to attempt and question timestamps; ignores malformed gates', () => {
    const log = implementLog();
    log.status('w1-1', 'waiting_input');
    log.push('message.question', {
      questionId: 'q1',
      attemptId: 'w1-1',
      body: '?',
    });
    log.push('message.escalated', {
      questionId: 'q1',
      reason: 'timeout',
      gateId: 'x',
    });
    const rm = structuredClone(log.model) as ReadModel;
    delete rm.seats[0]!.attempts[0]!.waitingSince;
    expect(
      officeViewModel(rm, { now: log.now, t: keyT }).needs.find(
        (n) => n.kind === 'seat',
      )!.since,
    ).toBe(rm.seats[0]!.attempts[0]!.startedAt);
    rm.seats[0]!.attempts[0]!.state = 'working';
    delete rm.questions[0]!.escalation;
    expect(seatOf(officeViewModel(rm, { now: log.now, t: keyT })).pose).toBe(
      'needs-you',
    );
    rm.questions = [];
    rm.gates.push({
      gateId: 'odd',
      workflowId: 'wf1',
      stageId: 'implement',
      kind: 'exception',
      title: 'odd',
      status: 'open',
      version: 1,
      options: [],
      content: { type: 'work-items', artifactId: 'a' },
      openedAt: rm.startedAt,
    });
    expect(seatOf(officeViewModel(rm, { now: log.now, t: keyT })).pose).toBe(
      'working',
    );
  });

  test('degraded overlays the pose and tags the nameplate', () => {
    const log = implementLog();
    log.push('seat.degraded', { attemptId: 'w1-1', reason: 'source_changed' });
    const seat = seatOf(vmOf(log));
    expect(seat).toMatchObject({ pose: 'working', degraded: true });
    expect(seat.nameplate.subtitle).toContain('office.seat.degraded');
    log.exit('w1-1');
    expect(seatOf(vmOf(log)).degraded).toBe(false);
  });

  test('selection inverts the nameplate', () => {
    const log = implementLog();
    log.status('w1-1', 'error');
    const seat = seatOf(vmOf(log, { selectedSeatId: W }));
    expect(seat).toMatchObject({ selected: true, pose: 'error' });
    expect(seat.nameplate.tone).toBe('selected');
  });
});

describe('§2.7 screen colour', () => {
  test.each([
    ['edit', 'edit'],
    ['shell', 'shell'],
    ['read', 'read'],
    ['git', 'git'],
    ['network', 'network'],
    ['orca', 'other'],
    ['other', 'other'],
  ] as const)('%s → %s', (category, screen) => {
    const log = implementLog();
    log.activity('w1-1', 'read').activity('w1-1', category);
    expect(seatOf(vmOf(log)).screen).toBe(screen);
  });

  test("only the current attempt's activity counts", () => {
    const log = implementLog();
    log.activity('w1-1', 'git').exit('w1-1');
    log.tick().dispatch('w1', 'w1-2', 2).status('w1-2', 'working');
    expect(seatOf(vmOf(log)).screen).toBe('other');
  });
});

describe('nameplates and aria labels', () => {
  test('working worker: purpose, elapsed and tokens (zh-TW)', () => {
    const log = implementLog();
    log.tokens('w1-1', 148_000).tick(12 * 60);
    const seat = officeViewModel(log.model, { now: log.now, t: zhT }).seats[0]!;
    expect(seat.nameplate).toMatchObject({
      title: 'w1',
      subtitle: '實作中 12 分　148k',
      badge: 'CX',
    });
    expect(seat.ariaLabel).toBe('engineer w1，Codex，實作中 12 分　148k');
  });

  test('away seat with its PR at the counter', () => {
    const log = implementLog();
    log.openPr('w1', 'w1-1', 5).exit('w1-1').mergeQueued('w1', 'w1-1', 5);
    const seat = officeViewModel(log.model, { now: log.now, t: zhT }).seats[0]!;
    expect(seat.ariaLabel).toBe('engineer w1 的座位：離座　PR #5 在整合台');
  });

  test('needs-you reasons carry precise waiting time', () => {
    const log = implementLog();
    log.status('w1-1', 'waiting_input').tick(192);
    const t = zhT;
    expect(
      officeViewModel(log.model, { now: log.now, t }).seats[0]!.nameplate
        .subtitle,
    ).toBe('在等回覆 3 分 12 秒');
    const other = implementLog();
    other.exceptionGate('g', 'decision-request', '要不要改 API', {
      attemptId: 'w1-1',
    });
    expect(
      officeViewModel(other.model, { now: other.now, t }).seats[0]!.nameplate
        .subtitle,
    ).toBe('要不要改 API 0 秒');
  });

  test('on-call and merge-queue instances', () => {
    const log = implementLog();
    log.spawn({
      attemptId: 'oc',
      role: 'lead',
      stageId: 'implement',
      purpose: 'oncall',
      ondemand: 'oncall',
    });
    log.spawn({
      attemptId: 'mq',
      role: 'integrator',
      stageId: 'implement',
      purpose: 'integrator',
      ondemand: 'merge',
    });
    log.status('oc', 'working').status('mq', 'working');
    let vm = officeViewModel(log.model, { now: log.now, t: zhT });
    expect(seatOf(vm, seatId('lead'))).toMatchObject({
      place: 'lead',
      ondemand: 'oncall',
      nameplate: { subtitle: '值班　回答提問 0 秒', badge: 'CC' },
    });
    expect(seatOf(vm, seatId('integrator'))).toMatchObject({
      place: 'counter',
      ondemand: 'merge',
      nameplate: { subtitle: '審查中 0 秒' },
    });
    log.openPr('w1', 'w1-1', 5).mergeQueued('w1', 'w1-1', 5).queue([], 'w1');
    vm = officeViewModel(log.model, { now: log.now, t: zhT });
    expect(seatOf(vm, seatId('integrator')).nameplate.subtitle).toBe(
      '審查 PR #5 0 秒',
    );
  });

  test('G9: AttemptView.rateLimited tags the nameplate until it is lifted (null or absent)', () => {
    const log = implementLog();
    const rm = structuredClone(log.model) as ReadModel;
    const attempt = rm.seats[0]!.attempts[0]!;
    attempt.rateLimited = {
      since: iso(log.now - 1000),
      resetsAt: iso(log.now - 1),
    };
    const tagged = officeViewModel(rm, { now: log.now, t: zhT }).seats[0]!;
    expect(tagged.nameplate.subtitle).toBe('等額度　實作中 0 秒');
    for (const lifted of [null, undefined]) {
      if (lifted === null) attempt.rateLimited = null;
      else delete attempt.rateLimited;
      expect(
        officeViewModel(rm, { now: log.now, t: zhT }).seats[0]!.nameplate
          .subtitle,
      ).toBe('實作中 0 秒');
    }
  });

  test('a seat with an unknown vendor and the lounge fallback', () => {
    const log = implementLog();
    const rm = structuredClone(log.model) as ReadModel;
    rm.seats.push({
      ...rm.seats[0]!,
      seatId: 'wf1:visitor',
      role: 'visitor',
      agent: null,
      attempts: [],
    });
    delete rm.seats[1]!.itemKey;
    delete rm.seats[1]!.currentAttemptId;
    const vm = officeViewModel(rm, { now: log.now, t: zhT });
    expect(seatOf(vm, 'wf1:visitor')).toMatchObject({
      place: 'lounge',
      vendor: null,
      pose: 'away',
    });
    expect(seatOf(vm, 'wf1:visitor').nameplate.badge).toBeUndefined();
  });
});

describe('floor', () => {
  test('rows follow maxParallel; the lower band shifts down 64 px per extra row', () => {
    const one = vmOf(implementLog({ maxParallel: 3 }));
    const two = vmOf(implementLog({ maxParallel: 4 }));
    expect(one.world).toEqual({ width: 352, height: 224, rows: 1 });
    expect(two.world).toEqual({ width: 352, height: 288, rows: 2 });
    const pantry = (vm: OfficeViewModel) =>
      vm.rooms.find((r) => r.id === 'pantry')!;
    expect(pantry(two).rect.y - pantry(one).rect.y).toBe(64);
    expect(two.anchors.entrance.y - one.anchors.entrance.y).toBe(64);
    expect(two.anchors['desk:5']).toEqual({ x: 132, y: 188 });
    expect(one.anchors['desk:5']).toBeUndefined();
    expect(one.rooms.map((r) => r.testId)).toContain('room-counter');
  });

  test('templates without an implement stage still get one row', () => {
    const log = createLog();
    const rm = structuredClone(log.model) as ReadModel;
    rm.template.stages = rm.template.stages.filter(
      (s) => s.kind !== 'implement',
    );
    rm.stages = rm.stages.filter((s) => s.kind !== 'implement');
    const vm = officeViewModel(rm, { now: log.now, t: keyT });
    expect(vm.world.rows).toBe(1);
    expect(vm.conveyor).toMatchObject({
      open: false,
      label: 'office.conveyor.closed',
    });
  });

  test('anchors cover seats, desks, chairs and fixed props', () => {
    const vm = vmOf(implementLog());
    expect(vm.anchors[`seat:${W}`]).toEqual({ x: 20, y: 124 });
    expect(vm.anchors['workitem:w1']).toEqual({ x: 20, y: 124 });
    expect(vm.anchors['workitem:w2']).toEqual({ x: 76, y: 124 });
    for (const id of [
      'inbox',
      'your-desk',
      'counter',
      'entrance',
      'main-door',
      'integration-cart',
      'conveyor',
      'printer',
    ] as const)
      expect(vm.anchors[id]).toBeDefined();
  });

  test('paper stacks: min(12, ceil(tokens / 50k)) per desk', () => {
    const cases: [number, number][] = [
      [1, 1],
      [50_000, 1],
      [50_001, 2],
      [1_000_000, 12],
    ];
    for (const [tokens, sheets] of cases) {
      const log = implementLog();
      log.tokens('w1-1', tokens);
      expect(vmOf(log).paperStacks).toEqual([
        { desk: 0, sheets, x: 37, y: 128 },
      ]);
    }
    expect(vmOf(implementLog()).paperStacks).toEqual([]);
  });

  test('reservations stop at the desk capacity', () => {
    const log = createLog({ maxParallel: 1 });
    log.stage('implement', 'implement');
    log.items('workitem.approved', [{ key: 'a' }, { key: 'b' }]);
    expect(vmOf(log).reserved.map((r) => [r.itemKey, r.desk])).toEqual([
      ['a', 0],
      ['b', 1],
      // maxParallel 1 still has a full row of three desks
    ]);
    log.items('workitem.approved', [
      { key: 'a' },
      { key: 'b' },
      { key: 'c' },
      { key: 'd' },
    ]);
    expect(vmOf(log).reserved.map((r) => r.itemKey)).toEqual(['a', 'b', 'c']);
    expect(vmOf(log).reserved[0]).toMatchObject({
      testId: 'desk-reserved-a',
      ariaLabel:
        'office.reserved.aria{"item":"a","status":"office.reserved.ready"}',
    });
  });
});

describe('needs, your desk, hush and door', () => {
  test('needs are ordered oldest first and link to their pages', () => {
    const log = implementLog();
    log.exceptionGate('g-x', 'decision-request', 'Decide', { itemKey: 'w1' });
    log.tick(10).push('message.question', {
      questionId: 'q1',
      attemptId: 'w1-1',
      body: '?',
    });
    log.exceptionGate('g-q', 'question-escalation', 'Q', { questionId: 'q1' });
    log.push('message.escalated', {
      questionId: 'q1',
      reason: 'timeout',
      gateId: 'g-q',
    });
    log.tick(10).spawn({
      attemptId: 'w3',
      role: 'pm',
      stageId: 'implement',
      purpose: 'worker',
    });
    log.status('w3', 'waiting_input');
    const vm = officeViewModel(log.model, { now: log.now, t: zhT });
    expect(vm.needs.map((n) => [n.kind, n.href, n.title])).toEqual([
      ['gate', '/gates/g-x', 'Decide'],
      ['question', '/questions/q1', 'engineer w1 的提問'],
      ['seat', undefined, 'pm 在等回覆'],
    ]);
    expect(vm.yourDesk).toMatchObject({
      lamp: 'amber',
      nameplate: { title: 'Decide', tone: 'need' },
      ariaLabel: '你的桌：Decide 等你 20 秒，共 2 件在等你',
    });
  });

  test('an escalated question whose gate is gone still needs you', () => {
    const log = implementLog();
    log.push('message.question', {
      questionId: 'q1',
      attemptId: 'w1-1',
      body: '?',
    });
    log.push('message.escalated', {
      questionId: 'q1',
      reason: 'timeout',
      gateId: 'gone',
    });
    const vm = officeViewModel(log.model, { now: log.now, t: zhT });
    expect(vm.needs).toMatchObject([
      { kind: 'question', href: '/questions/q1', title: 'engineer w1 的提問' },
    ]);
    const orphan = structuredClone(log.model) as ReadModel;
    orphan.questions[0]!.seatId = 'nobody';
    expect(
      officeViewModel(orphan, { now: log.now, t: zhT }).needs[0]!.title,
    ).toBe('engineer');
  });

  test('stage gates hush the floor; exception gates do not', () => {
    const log = createLog();
    log.stage('meeting', 'meeting');
    expect(vmOf(log).yourDesk.ariaLabel).toBe(
      'office.desk.aria{"status":"office.desk.next{\\"title\\":\\"結論定案\\"}"}',
    );
    log.stageGate('g1', 'meeting', 'meeting', 'Conclusion', CONCLUSION_CONTENT);
    expect(vmOf(log).hush).toMatchObject({ active: true, gateId: 'g1' });
    expect(vmOf(log).whiteboard.title).toBe('office.stage.awaiting-gate');
    const ex = implementLog();
    ex.exceptionGate('g2', 'decision-request', 'D', { itemKey: 'w1' });
    expect(vmOf(ex).hush.active).toBe(false);
  });

  test('a disabled gate is not announced as next', () => {
    const log = createLog();
    log.stage('meeting', 'meeting');
    const rm = structuredClone(log.model) as ReadModel;
    rm.gateToggles = { conclusion: false };
    expect(
      officeViewModel(rm, { now: log.now, t: keyT }).yourDesk.nameplate
        .subtitle,
    ).toBe('office.desk.idle');
  });

  test('the door opens when the final PR gate closes merged', () => {
    const log = createLog();
    log.stage('final-pr', 'final-pr');
    log.stageGate('gf', 'final-pr', 'final-pr', 'Final', {
      type: 'final-pr',
      artifactId: 'a',
    });
    expect(vmOf(log).door.open).toBe(false);
    log.push('gate.closed', { gateId: 'gf', reason: 'merged' });
    expect(vmOf(log).door).toEqual({ open: true, label: 'office.door.open' });
  });
});

describe('whiteboard, inbox, conveyor, usage', () => {
  test('whiteboard by stage', () => {
    const log = createLog();
    expect(vmOf(log).whiteboard).toMatchObject({
      title: 'office.stage.none',
      testId: 'office-whiteboard',
    });
    log.stage('planning', 'planning');
    expect(vmOf(log).whiteboard.title).toBe('office.stage.planning');
    expect(vmOf(log).whiteboard.lines).toHaveLength(1);
    const impl = implementLog();
    expect(vmOf(impl).whiteboard.lines[0]).toBe(
      'office.whiteboard.counts{"active":1,"review":0,"waiting":1}',
    );
    impl.push('workflow.failed', {
      reason: 'max_reruns_exceeded',
      stageId: 'implement',
    });
    expect(vmOf(impl).whiteboard).toMatchObject({
      title: 'office.stage.failed',
      lines: [
        expect.stringContaining('counts'),
        expect.stringContaining('tokens'),
      ],
    });
    const cancelled = createLog();
    cancelled.push('workflow.cancelled', {});
    expect(vmOf(cancelled).whiteboard.lines).toHaveLength(1);
  });

  test('inbox lists issues and PRs, newest first, at most six', () => {
    const log = implementLog();
    for (let n = 1; n <= 7; n++)
      log.tick().push('artifact.created', {
        artifactId: `i${n}`,
        kind: 'issue',
        number: n,
        url: `https://github.com/octo/demo/issues/${n}`,
        purpose: 'work-item',
      });
    log.push('artifact.created', {
      artifactId: 'b1',
      kind: 'branch',
      name: 'x',
      purpose: 'worker',
    });
    const vm = officeViewModel(log.model, { now: log.now, t: zhT });
    expect(vm.inbox.items.map((i) => i.label)).toEqual([
      'Issue #7',
      'Issue #6',
      'Issue #5',
      'Issue #4',
      'Issue #3',
      'Issue #2',
    ]);
    expect(vm.inbox).toMatchObject({
      label: '交件匣',
      ariaLabel: '交件匣：6 件',
    });
    const rm = structuredClone(log.model) as ReadModel;
    rm.artifacts.push({ artifactId: 'p', kind: 'pr', at: iso(log.now + 1000) });
    expect(
      officeViewModel(rm, { now: log.now, t: zhT }).inbox.items[0]!.artifactId,
    ).toBe('i7');
  });

  test('conveyor queue and parcels', () => {
    const log = implementLog();
    expect(vmOf(log).conveyor).toMatchObject({
      open: true,
      label: 'office.conveyor.empty',
    });
    log.openPr('w1', 'w1-1', 5).mergeQueued('w1', 'w1-1', 5);
    // Queued items not yet in the on-demand queue view still ride the belt.
    expect(vmOf(log).parcels).toEqual([
      { itemKey: 'w1', pr: 5, place: 'queue', slot: 0, x: 266, y: 144 },
    ]);
    log.queue(['w1', 'ghost']);
    expect(vmOf(log).conveyor).toMatchObject({
      queue: ['w1'],
      label: 'office.conveyor.queued{"n":1}',
    });
    log.queue([], 'w1').itemStatus('w1', 'in_review');
    expect(vmOf(log).parcels).toMatchObject([
      { place: 'counter', itemKey: 'w1' },
    ]);
    const rm = structuredClone(log.model) as ReadModel;
    delete rm.stages.find((s) => s.kind === 'implement')!.ondemand!.merge!
      .current;
    expect(
      officeViewModel(rm, { now: log.now, t: keyT }).conveyor.current,
    ).toBe('w1');
  });

  test('rework parcels stay off the floor when the desk is unknown', () => {
    const log = implementLog();
    const rm = structuredClone(log.model) as ReadModel;
    rm.workItems[0]!.status = 'rework';
    rm.workItems[1]!.status = 'rework';
    rm.workItems[1]!.seatId = 'nowhere';
    expect(officeViewModel(rm, { now: log.now, t: keyT }).parcels).toEqual([
      { itemKey: 'w1', place: 'desk', slot: 0, x: 11, y: 118 },
    ]);
  });

  test('usage shows totals only; G8 marks a disabled budget', () => {
    const log = implementLog();
    log.tokens('w1-1', 120_000);
    expect(vmOf(log).usage).toEqual({
      totalTokens: 120_000,
      label: 'office.usage.total{"tokens":"120k"}',
      sheets: 3,
      budgetDisabled: false,
    });
    const rm = structuredClone(log.model) as ReadModel;
    (rm.limits as { budgetEnforcement?: string }).budgetEnforcement = 'off';
    expect(officeViewModel(rm, { now: log.now, t: keyT }).usage).toMatchObject({
      budgetDisabled: true,
      budgetLabel: 'office.usage.budgetDisabled',
    });
  });
});

describe('stabilize integration (§3.3)', () => {
  test('one activity event replaces only the affected seat', () => {
    const log = implementLog();
    log.tick().dispatch('w2', 'w2-1').status('w2-1', 'working');
    const before = vmOf(log);
    log.activity('w2-1', 'git');
    const after = stabilize(before, vmOf(log));
    expect(after).not.toBe(before);
    expect(after.seats[0]).toBe(before.seats[0]);
    expect(after.seats[1]).not.toBe(before.seats[1]);
    expect(after.rooms).toBe(before.rooms);
    expect(stabilize(after, vmOf(log))).toBe(after);
  });
});
