import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { stabilize } from './stabilize.js';

describe('stabilize', () => {
  test('returns prev for deeply equal values', () => {
    const prev = { a: [1, { b: 'x' }], c: null };
    expect(stabilize(prev, { a: [1, { b: 'x' }], c: null })).toBe(prev);
  });

  test('keeps unchanged subtrees and replaces changed ones', () => {
    const prev = {
      seats: [
        { id: 's1', pose: 'working' },
        { id: 's2', pose: 'idle' },
      ],
      meta: { rows: 1 },
    };
    const next = stabilize(prev, {
      seats: [
        { id: 's1', pose: 'working' },
        { id: 's2', pose: 'needs-you' },
      ],
      meta: { rows: 1 },
    });
    expect(next).not.toBe(prev);
    expect(next.seats).not.toBe(prev.seats);
    expect(next.seats[0]).toBe(prev.seats[0]);
    expect(next.seats[1]).toEqual({ id: 's2', pose: 'needs-you' });
    expect(next.meta).toBe(prev.meta);
  });

  test('detects added, removed and resized members', () => {
    const prev = { a: 1, list: [1, 2] } as Record<string, unknown>;
    expect(stabilize(prev, { a: 1 })).toEqual({ a: 1 });
    expect(stabilize(prev, { a: 1, list: [1, 2], b: 2 })).toEqual({
      a: 1,
      list: [1, 2],
      b: 2,
    });
    expect(stabilize(prev, { a: 1, b: [1, 2] })).toEqual({ a: 1, b: [1, 2] });
    const grown = stabilize(prev, { a: 1, list: [1, 2, 3] });
    expect(grown.list).toEqual([1, 2, 3]);
  });

  test('handles null prev, primitives and mismatched shapes', () => {
    const next = { a: 1 };
    expect(stabilize(null, next)).toBe(next);
    expect(stabilize(undefined, next)).toBe(next);
    expect(stabilize(1, 2)).toBe(2);
    expect(stabilize<unknown>([1], { 0: 1 })).toEqual({ 0: 1 });
    expect(stabilize(Number.NaN, Number.NaN)).toBeNaN();
    const date = new Date(0);
    expect(stabilize<unknown>(new Date(0), date)).toBe(date);
    const bare = Object.assign(Object.create(null) as object, { a: 1 });
    expect(stabilize(bare, { a: 1 })).toBe(bare);
  });

  test('own keys such as __proto__ and constructor round-trip exactly', () => {
    // JSON.parse creates `__proto__` as an own key, like agent-supplied item keys.
    const prev = JSON.parse(
      '{"__proto__":{"a":1},"constructor":1,"x":[1]}',
    ) as Record<string, unknown>;
    const next = JSON.parse(
      '{"__proto__":{"a":2},"constructor":1,"x":[1]}',
    ) as Record<string, unknown>;
    const out = stabilize(prev, next);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toEqual(['__proto__', 'constructor', 'x']);
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toEqual({
      a: 2,
    });
    expect(out.constructor).toBe(1);
    expect(out.x).toBe(prev.x);
    expect(out).toStrictEqual(next);
    expect(stabilize(prev, structuredClone(prev))).toBe(prev);
  });

  test('property: the result always deep-equals next and never mutates prev', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), (prev, next) => {
        const snapshot = JSON.stringify(prev);
        const out = stabilize(prev, next);
        expect(out).toEqual(next);
        expect(JSON.stringify(prev)).toBe(snapshot);
        expect(stabilize(out, structuredClone(next))).toBe(out);
      }),
    );
  });
});
