import { replay } from '@ai-office/projection';
import { describe, expect, test } from 'vitest';
import { keyT } from '../../../test-support/office/log.js';
import { mainline, SEATS } from '../../../test-support/office/mainline.js';
import type { Anchor, Effect } from './effect-types.js';
import { effects } from './effects.js';
import { boardViewModel } from './boardViewModel.js';
import { officeViewModel } from './officeViewModel.js';

// Golden VM, semantics only (M4_PLAN §7.1): at every gate opening and at the end,
// assert seat states, the needs-you list, board columns, desk mapping and the door.
// No whole-VM snapshots and no event-sequence comparison, so fake-world changes in
// M2 (re-recorded fixtures) do not churn this file.

const log = mainline();
const view = (mark: string) => {
  const args = { now: log.nowAt(mark), t: keyT };
  return {
    office: officeViewModel(log.at(mark), args),
    board: boardViewModel(log.at(mark), args),
  };
};
const poses = (mark: string) =>
  Object.fromEntries(view(mark).office.seats.map((s) => [s.seatId, s.pose]));
const needs = (mark: string) => view(mark).office.needs.map((n) => n.id);
const columns = (mark: string) =>
  Object.fromEntries(
    view(mark).board.columns.map((c) => [
      c.id,
      c.cards.map((card) => card.itemKey),
    ]),
  );
const desks = (mark: string) =>
  Object.fromEntries(
    view(mark)
      .office.seats.filter((s) => s.desk !== undefined)
      .map((s) => [s.itemKey, s.desk]),
  );

describe('golden: hand-written mainline', () => {
  test('meeting: four people in the meeting room, nothing waiting', () => {
    const { office } = view('meeting');
    expect(poses('meeting')).toEqual({
      [SEATS.lead]: 'working',
      [SEATS.pm]: 'working',
      [SEATS.architect]: 'working',
      [SEATS.engineer]: 'working',
    });
    expect(office.seats.map((s) => s.place)).toEqual([
      'meeting',
      'meeting',
      'meeting',
      'meeting',
    ]);
    expect(office.seats[0]!.chair).toBe('facilitator');
    expect(new Set(office.seats.slice(1).map((s) => s.chair)).size).toBe(3);
    expect(office.stageKind).toBe('meeting');
    expect(needs('meeting')).toEqual([]);
    expect(office.hush.active).toBe(false);
    expect(office.door.open).toBe(false);
  });

  test('conclusion gate: everyone gone, hush, your desk lit', () => {
    const { office } = view('gate:conclusion');
    expect(Object.values(poses('gate:conclusion'))).toEqual(
      Array(4).fill('away'),
    );
    expect(needs('gate:conclusion')).toEqual(['gate:g-conclusion']);
    expect(office.hush).toMatchObject({ active: true, gateId: 'g-conclusion' });
    expect(office.yourDesk).toMatchObject({
      lamp: 'amber',
      paper: true,
      bang: true,
    });
    expect(office.inbox.items.map((i) => i.number)).toEqual([1]);
  });

  test('plan gate: proposals on the board, dependent waits for feature', () => {
    const { board } = view('gate:plan');
    expect(needs('gate:plan')).toEqual(['gate:g-plan']);
    expect(columns('gate:plan').waiting).toEqual([
      'feature',
      'persist',
      'dependent',
    ]);
    expect(board.columns[0]!.cards[2]!.blockedBy).toEqual(['feature']);
    expect(view('gate:plan').office.hush.active).toBe(true);
  });

  test('implement: two at desks, dependent keeps a reserved desk', () => {
    const { office } = view('implement');
    expect(poses('implement')).toMatchObject({
      [SEATS.feature]: 'working',
      [SEATS.persist]: 'working',
      [SEATS.lead]: 'away',
    });
    expect(desks('implement')).toEqual({ feature: 0, persist: 1 });
    expect(office.reserved).toMatchObject([
      { itemKey: 'dependent', desk: 2, blockedBy: ['feature'] },
    ]);
    expect(columns('implement')).toMatchObject({
      waiting: ['dependent'],
      active: ['feature', 'persist'],
    });
    expect(office.seats.find((s) => s.seatId === SEATS.feature)!.screen).toBe(
      'edit',
    );
    expect(office.seats.find((s) => s.seatId === SEATS.persist)!.screen).toBe(
      'shell',
    );
  });

  test('waiting_input: persist needs you while on-call works in the lead office', () => {
    const { office } = view('waiting');
    expect(poses('waiting')[SEATS.persist]).toBe('needs-you');
    expect(needs('waiting')).toEqual([`seat:${SEATS.persist}`]);
    expect(office.seats.find((s) => s.seatId === SEATS.lead)).toMatchObject({
      pose: 'working',
      place: 'lead',
      ondemand: 'oncall',
    });
    // A seat waiting on its own question does not light your desk.
    expect(office.yourDesk.lamp).toBe('off');
  });

  test('review and rework: the parcel goes to the counter and back to the desk', () => {
    expect(view('review').office.parcels).toMatchObject([
      { itemKey: 'feature', place: 'counter', pr: 5 },
    ]);
    expect(poses('review')).toMatchObject({
      [SEATS.integrator]: 'working',
      [SEATS.feature]: 'away',
    });
    expect(columns('review').review).toEqual(['feature']);
    expect(view('rework').office.parcels).toMatchObject([
      { itemKey: 'feature', place: 'desk', slot: 0 },
    ]);
    expect(columns('rework').active).toEqual(['feature', 'persist']);
  });

  test('feature merged: dependent becomes ready on its reserved desk', () => {
    const { office } = view('feature-merged');
    expect(columns('feature-merged').merged).toEqual(['feature']);
    expect(office.reserved).toMatchObject([
      { itemKey: 'dependent', desk: 2, blockedBy: [] },
    ]);
    expect(office.conveyor.merged).toBe(1);
  });

  test('final PR gate and the end', () => {
    expect(needs('gate:final')).toEqual(['gate:g-final']);
    expect(Object.values(poses('gate:final')).every((p) => p === 'away')).toBe(
      true,
    );
    expect(columns('gate:final').merged).toEqual([
      'feature',
      'persist',
      'dependent',
    ]);
    const end = view('end').office;
    expect(needs('end')).toEqual([]);
    expect(end.door.open).toBe(true);
    expect(end.hush.active).toBe(false);
    expect(end.whiteboard.title).toBe('office.stage.completed');
    expect(end.conveyor.merged).toBe(3);
  });

  test('every item keeps one desk and one colour across all checkpoints', () => {
    const seen = new Map<string, string>();
    for (const mark of log.marks.keys())
      for (const seat of view(mark).office.seats) {
        if (seat.desk === undefined) continue;
        const key = `${seat.desk}/${seat.accessory}`;
        expect(seen.get(seat.seatId) ?? key).toBe(key);
        seen.set(seat.seatId, key);
      }
    expect(desks('end')).toEqual({ feature: 0, persist: 1, dependent: 2 });
  });

  test('replaying to a checkpoint gives the live view of that moment', () => {
    for (const [mark, seq] of log.marks) {
      const args = { now: log.nowAt(mark), t: keyT };
      const replayed = replay(log.events.slice(0, seq));
      expect(officeViewModel(replayed!, args)).toEqual(view(mark).office);
    }
  });
});

describe('effects resolve on the floor', () => {
  // Every anchor M4-T6 emits must be a key of `vm.anchors` in the read model the
  // effect is played against (`next`), so the scene can place it.
  test('all mainline effect anchors resolve', () => {
    const key = (a: Anchor) =>
      'seatId' in a
        ? `${a.kind}:${a.seatId}`
        : 'itemKey' in a
          ? `${a.kind}:${a.itemKey}`
          : a.kind;
    const missing: string[] = [];
    let checked = 0;
    log.events.forEach((event, i) => {
      const next = log.models[i]!;
      const vm = officeViewModel(next, { now: 0, t: keyT });
      for (const effect of effects(event, log.models[i - 1] ?? null, next))
        for (const anchor of anchorsOf(effect)) {
          checked++;
          if (!(key(anchor) in vm.anchors))
            missing.push(`${event.seq} ${event.type} ${key(anchor)}`);
        }
    });
    expect(missing).toEqual([]);
    expect(checked).toBeGreaterThan(40);
  });
});

function anchorsOf(effect: Effect): Anchor[] {
  switch (effect.kind) {
    case 'envelope':
      return [...effect.route, effect.reducedMotion.at];
    case 'print':
    case 'paper-grow':
    case 'door-open':
    case 'flash-nameplate':
      return [effect.at];
    default:
      return [effect.from, effect.to];
  }
}
