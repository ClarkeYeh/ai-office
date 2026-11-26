import { describe, expect, it } from 'vitest';
import { isTurnDone } from './index.js';
import type { Attempt } from './types.js';

const attempt = (patch: Partial<Attempt>): Attempt =>
  ({ attemptId: 'a', state: 'working', released: false, ...patch }) as Attempt;

describe('isTurnDone (T12 latch)', () => {
  it('is true while done, and through stale readings of the same turn', () => {
    expect(isTurnDone(attempt({ state: 'done', doneTurn: 0 }))).toBe(true);
    for (const state of ['working', 'idle', 'waiting_input'] as const)
      expect(isTurnDone(attempt({ state, doneTurn: 0 }))).toBe(true);
    expect(isTurnDone(attempt({ state: 'idle', turns: 2, doneTurn: 2 }))).toBe(
      true,
    );
  });
  it('is false after a new turn, before any done, and once gone', () => {
    expect(
      isTurnDone(attempt({ state: 'working', turns: 1, doneTurn: 0 })),
    ).toBe(false);
    expect(isTurnDone(attempt({ state: 'working' }))).toBe(false);
    for (const state of ['exited', 'lost', 'error', 'starting'] as const)
      expect(isTurnDone(attempt({ state, doneTurn: 0 }))).toBe(false);
    expect(
      isTurnDone(attempt({ state: 'idle', doneTurn: 0, released: true })),
    ).toBe(false);
  });
});
