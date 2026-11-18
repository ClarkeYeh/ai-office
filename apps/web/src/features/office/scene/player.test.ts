import { describe, expect, test } from 'vitest';
import type { Effect } from '../model/index.js';
import {
  emptyQueue,
  enqueue,
  finish,
  MAX_PLAYING,
  MAX_WAITING,
  reduceAll,
  reduceEffect,
  type QueuedEffect,
} from './player.js';

const walk: Effect = {
  kind: 'walk-in',
  attemptId: 'a',
  from: { kind: 'entrance' },
  to: { kind: 'seat', seatId: 's' },
};
const envelope: Effect = {
  kind: 'envelope',
  route: [{ kind: 'inbox' }, { kind: 'your-desk' }],
  reducedMotion: { kind: 'flash-nameplate', at: { kind: 'your-desk' } },
};
const batch = (n: number, from = 0, effect: Effect = walk): QueuedEffect[] =>
  Array.from({ length: n }, (_, i) => ({ id: from + i, effect }));

describe('effect queue', () => {
  test('plays at most 8 at once and keeps the rest waiting', () => {
    const q = enqueue(emptyQueue(), batch(12), false);
    expect(q.playing).toHaveLength(MAX_PLAYING);
    expect(q.waiting).toHaveLength(4);
    expect(q.skipped).toBe(0);
  });

  test('more than 20 waiting: the rest jump to their result', () => {
    const q = enqueue(emptyQueue(), batch(40), false);
    expect(q.playing).toHaveLength(MAX_PLAYING);
    expect(q.waiting).toHaveLength(MAX_WAITING);
    expect(q.skipped).toBe(40 - MAX_PLAYING - MAX_WAITING);
    expect(q.waiting.at(-1)!.id).toBe(MAX_PLAYING + MAX_WAITING - 1);
  });

  test('a finished effect frees its slot for the next one', () => {
    let q = enqueue(emptyQueue(), batch(9), false);
    q = finish(q, 0);
    expect(q.playing.map((p) => p.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(q.waiting).toEqual([]);
    expect(finish(q, 99)).toBe(q);
  });

  test('ids already seen are ignored (re-renders pass the same list)', () => {
    const q = enqueue(emptyQueue(), batch(3), false);
    expect(enqueue(q, batch(3), false)).toBe(q);
    expect(enqueue(q, batch(4), false).playing).toHaveLength(4);
  });

  test('reduced motion: envelopes flash, walks and parcels are skipped', () => {
    const q = enqueue(
      emptyQueue(),
      [
        { id: 0, effect: walk },
        { id: 1, effect: envelope },
        {
          id: 2,
          effect: { kind: 'print', artifactId: 'p', at: { kind: 'printer' } },
        },
        {
          id: 3,
          effect: {
            kind: 'merge',
            itemKey: 'k',
            from: { kind: 'counter' },
            to: { kind: 'integration-cart' },
            confetti: true,
          },
        },
        {
          id: 4,
          effect: {
            kind: 'door-open',
            at: { kind: 'main-door' },
            confetti: true,
          },
        },
      ],
      true,
    );
    expect(q.playing.map((p) => [p.id, p.effect.kind])).toEqual([
      [1, 'flash-nameplate'],
      [2, 'print'],
    ]);
    expect(q.lastId).toBe(4);
  });

  test('turning reduced motion on drops what has no reduced form', () => {
    const q = reduceAll(
      enqueue(emptyQueue(), [...batch(9), { id: 9, effect: envelope }], false),
    );
    expect(q.playing.map((p) => p.effect.kind)).toEqual(['flash-nameplate']);
    expect(q.waiting).toEqual([]);
  });

  test('per-kind reduced forms (M4_DESIGN §3.3)', () => {
    expect(reduceEffect(walk)).toBeNull();
    expect(reduceEffect(envelope)).toEqual(envelope.reducedMotion);
    expect(
      reduceEffect({
        kind: 'paper-grow',
        at: { kind: 'seat', seatId: 's' },
        fromSheets: 1,
        toSheets: 2,
      }),
    ).toBeNull();
  });
});
