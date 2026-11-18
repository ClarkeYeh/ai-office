import type { WorkItemStatus } from '@ai-office/contracts/events';
import type { ReadModel } from '@ai-office/projection';
import { describe, expect, test } from 'vitest';
import {
  createLog,
  keyT,
  seatId,
  zhT,
} from '../../../test-support/office/log.js';
import { boardViewModel, columnOf } from './boardViewModel.js';

const ALL: [WorkItemStatus, string][] = [
  ['proposed', 'waiting'],
  ['approved', 'waiting'],
  ['dispatched', 'active'],
  ['in_progress', 'active'],
  ['pushed', 'active'],
  ['pr_open', 'active'],
  ['rework', 'active'],
  ['needs_attention', 'active'],
  ['failed', 'active'],
  ['merge_queued', 'queued'],
  ['in_review', 'review'],
  ['merged', 'merged'],
  ['skipped', 'merged'],
];

function board() {
  const log = createLog();
  log.stage('implement', 'implement');
  log.items('workitem.approved', [
    { key: 'a' },
    { key: 'b', deps: ['a'] },
    { key: 'c' },
  ]);
  log.tick(60).dispatch('a', 'a1').status('a1', 'working');
  return log;
}

describe('board view model (D2)', () => {
  test.each(ALL)('%s goes to %s', (status, column) => {
    expect(columnOf(status)).toBe(column);
  });

  test('cards: blocked and ready notes, PR links, tones', () => {
    const log = board();
    log.tick(60).openPr('a', 'a1', 5);
    let vm = boardViewModel(log.model, { now: log.now, t: zhT });
    expect(
      vm.columns.map((c) => [c.id, c.label, c.cards.map((x) => x.itemKey)]),
    ).toEqual([
      ['waiting', '等待依賴', ['b', 'c']],
      ['active', '進行中', ['a']],
      ['queued', '合併佇列', []],
      ['review', '審查中', []],
      ['merged', '已合併', []],
    ]);
    const [b, c] = vm.columns[0]!.cards;
    expect(b).toMatchObject({
      note: '等 a 合併',
      ready: false,
      blockedBy: ['a'],
    });
    expect(c).toMatchObject({ note: '可以派工', ready: true, tone: 'plain' });
    expect(vm.columns[1]!.cards[0]).toMatchObject({
      pr: { number: 5, url: 'https://github.com/octo/demo/pull/5' },
      badge: 'CX',
      vendor: 'codex',
      seatId: seatId('engineer', 'a'),
      accessory: 'default',
      statusLabel: 'PR 已開',
      ariaLabel: 'a：PR 已開',
      testId: 'board-card-a',
    });
    log.exceptionGate('g', 'merge-blocked', 'Blocked', { itemKey: 'a' });
    vm = boardViewModel(log.model, { now: log.now, t: keyT });
    expect(vm.columns[1]!.cards[0]).toMatchObject({
      needsYou: true,
      tone: 'need',
    });
    expect(vm.needs.map((n) => n.id)).toEqual(['gate:g']);
  });

  test('error, rework, retry and skipped tones', () => {
    const log = board();
    log.status('a1', 'error');
    let card = boardViewModel(log.model, { now: log.now, t: keyT }).columns[1]!
      .cards[0]!;
    expect(card).toMatchObject({ error: true, tone: 'error' });
    const rm = structuredClone(log.model) as ReadModel;
    rm.workItems[0]!.reworks = 2;
    rm.workItems[1]!.status = 'dispatched';
    rm.workItems[1]!.attempts = 3;
    rm.workItems[2]!.status = 'skipped';
    rm.seats[0]!.attempts[0]!.state = 'working';
    const cols = boardViewModel(rm, { now: log.now, t: keyT }).columns;
    expect(cols[1]!.cards.map((x) => [x.itemKey, x.note, x.tone])).toEqual([
      ['a', 'board.card.rework{"n":2}', 'plain'],
      ['b', 'board.card.attempt{"n":3}', 'plain'],
    ]);
    card = cols[4]!.cards[0]!;
    expect(card).toMatchObject({
      itemKey: 'c',
      tone: 'muted',
      accessory: 'default',
    });
    expect(card.badge).toBe('CX');
    const failed = structuredClone(rm) as ReadModel;
    failed.workItems[1]!.status = 'needs_attention';
    delete failed.workItems[1]!.agent;
    const nb = boardViewModel(failed, { now: log.now, t: keyT }).columns[1]!
      .cards[1]!;
    expect(nb).toMatchObject({ error: true, tone: 'error' });
    expect(nb.badge).toBeUndefined();
  });

  test('lanes: one segment per attempt, measured from the workflow start', () => {
    const log = board();
    log.tick(120).exit('a1');
    log.tick(30).dispatch('a', 'a2', 2).status('a2', 'working');
    log.tick(90);
    const vm = boardViewModel(log.model, {
      now: log.now,
      t: keyT,
      selectedSeatId: seatId('engineer', 'a'),
    });
    expect(vm.lanes).toHaveLength(1);
    const lane = vm.lanes[0]!;
    expect(lane).toMatchObject({
      title: 'a',
      badge: 'CX',
      pose: 'working',
      selected: true,
      testId: `board-lane-${seatId('engineer', 'a')}`,
    });
    expect(
      lane.segments.map((s) => [s.attempt, s.start, s.end, s.alive, s.pose]),
    ).toEqual([
      [1, 60_000, 180_000, false, 'away'],
      [2, 210_000, 300_000, true, 'working'],
    ]);
    expect(vm.span).toBe(300_000);
    expect(lane.segments[0]!.ariaLabel).toBe(
      'board.segment.aria{"n":1,"purpose":"office.purpose.worker","state":"office.attemptState.exited"}',
    );
  });

  test('released attempts without an end and finished workflows', () => {
    const log = board();
    log.push('seat.released', { attemptId: 'a1', removeWorkspace: false });
    log.tick(60).push('workflow.cancelled', {});
    const vm = boardViewModel(log.model, { now: log.now + 999_999, t: keyT });
    expect(vm.lanes[0]!.segments[0]).toMatchObject({
      start: 60_000,
      end: 60_000,
      alive: false,
    });
    expect(vm.span).toBe(120_000);
    const rm = structuredClone(log.model) as ReadModel;
    rm.seats[0]!.agent = null;
    expect(
      boardViewModel(rm, { now: 0, t: keyT }).lanes[0]!.badge,
    ).toBeUndefined();
  });
});
