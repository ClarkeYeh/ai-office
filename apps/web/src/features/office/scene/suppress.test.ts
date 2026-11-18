import { describe, expect, test } from 'vitest';
import { harnessFixtures } from '../../../test-support/harness/fixtures.js';
import { neighbour, rovingId } from './roving.js';
import { NOTHING_SUPPRESSED, plateKey, suppressed } from './suppress.js';

const {
  implement,
  'two-rows': rows,
  'error-needs-you': trouble,
} = harnessFixtures();

describe('suppressed floor while effects play', () => {
  test('nothing playing hides nothing', () => {
    expect(suppressed(implement, [])).toBe(NOTHING_SUPPRESSED);
  });

  test('walk-in hides the figure; parcels, stacks and the door hide too', () => {
    const hidden = suppressed(implement, [
      {
        id: 0,
        effect: {
          kind: 'walk-in',
          attemptId: 'f-1',
          from: { kind: 'entrance' },
          to: { kind: 'seat', seatId: 'wf1:engineer:feature' },
        },
      },
      {
        id: 1,
        effect: {
          kind: 'parcel-return',
          itemKey: 'feature',
          from: { kind: 'counter' },
          to: { kind: 'workitem', itemKey: 'feature' },
        },
      },
      {
        id: 2,
        effect: {
          kind: 'paper-grow',
          at: { kind: 'seat', seatId: 'wf1:engineer:persist' },
          fromSheets: 2,
          toSheets: 3,
        },
      },
      {
        id: 3,
        effect: {
          kind: 'door-open',
          at: { kind: 'main-door' },
          confetti: true,
        },
      },
      {
        id: 4,
        effect: { kind: 'flash-nameplate', at: { kind: 'your-desk' } },
      },
    ]);
    expect([...hidden.seats]).toEqual(['wf1:engineer:feature']);
    expect([...hidden.parcels]).toEqual(['feature']);
    expect([...hidden.stacks]).toEqual([1]);
    expect(hidden.door).toBe(true);
    expect([...hidden.flash]).toEqual(['your-desk']);
  });

  test('flash targets: seats, items, reserved desks, the counter, trays', () => {
    expect(plateKey(implement, { kind: 'workitem', itemKey: 'theme' })).toBe(
      'seat:wf1:engineer:theme',
    );
    expect(plateKey(rows, { kind: 'workitem', itemKey: 'foxtrot' })).toBe(
      'reserved:foxtrot',
    );
    expect(plateKey(rows, { kind: 'workitem', itemKey: 'nope' })).toBe(
      undefined,
    );
    expect(plateKey(trouble, { kind: 'counter' })).toBe('seat:wf1:integrator');
    expect(plateKey(rows, { kind: 'counter' })).toBe(undefined);
    expect(plateKey(rows, { kind: 'inbox' })).toBe('inbox');
    expect(plateKey(rows, { kind: 'printer' })).toBe(undefined);
    expect(plateKey(rows, { kind: 'meeting', seatId: 'x' })).toBe(undefined);
  });
});

describe('roving tabindex', () => {
  const points = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 50, y: 0 },
    { id: 'c', x: 100, y: 0 },
    { id: 'd', x: 0, y: 60 },
    { id: 'e', x: 45, y: 70 },
  ];
  test('arrows move to the nearest seat in that direction', () => {
    expect(neighbour(points, 'a', 'right')).toBe('b');
    expect(neighbour(points, 'b', 'right')).toBe('c');
    expect(neighbour(points, 'c', 'right')).toBeUndefined();
    expect(neighbour(points, 'b', 'down')).toBe('e');
    expect(neighbour(points, 'd', 'up')).toBe('a');
    expect(neighbour(points, 'e', 'left')).toBe('d');
    expect(neighbour(points, 'missing', 'left')).toBe('a');
  });

  test('tabbable seat: remembered, then selected, then first', () => {
    expect(rovingId(['a', 'b'], 'b', 'a')).toBe('b');
    expect(rovingId(['a', 'b'], 'gone', 'b')).toBe('b');
    expect(rovingId(['a', 'b'], null, undefined)).toBe('a');
    expect(rovingId([], null, undefined)).toBeUndefined();
  });
});
