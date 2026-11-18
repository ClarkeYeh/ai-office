import { afterEach, expect, test, vi } from 'vitest';
import { createTicker, TICK_MS } from './ticker.js';

afterEach(() => vi.useRealTimers());

test('ticks every 30 s only while subscribed', () => {
  vi.useFakeTimers();
  let time = 1_000;
  const ticker = createTicker({ clock: () => time });
  expect(ticker.now()).toBe(1_000);
  time = 2_000;
  const listener = vi.fn();
  const off = ticker.subscribe(listener);
  expect(ticker.now()).toBe(2_000);
  const second = ticker.subscribe(() => {});
  time = 3_000;
  vi.advanceTimersByTime(TICK_MS);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(ticker.now()).toBe(3_000);
  off();
  second();
  time = 4_000;
  vi.advanceTimersByTime(TICK_MS * 2);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(ticker.now()).toBe(3_000);
  expect(vi.getTimerCount()).toBe(0);
});

test('defaults to Date.now', () => {
  const before = Date.now();
  expect(createTicker().now()).toBeGreaterThanOrEqual(before);
});
