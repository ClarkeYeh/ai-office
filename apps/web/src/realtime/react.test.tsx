import { act, render, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { replay, type ReadModel } from '@ai-office/projection';
import { createAppliedBus } from './bus.js';
import {
  RealtimeProvider,
  shallowEqual,
  useAppliedEvents,
  useDisplayedModel,
  useNow,
  useRealtime,
  useViewModel,
  useWebState,
} from './react.js';
import type { Realtime } from './realtime.js';
import { createWebStore } from './store.js';
import { workflowEvents } from './test-support/events.js';
import { createTicker } from './ticker.js';
import type { Stabilize } from './types.js';

afterEach(() => vi.useRealTimers());

function fakeRealtime(): Realtime {
  return {
    store: createWebStore(),
    bus: createAppliedBus(),
    ticker: createTicker({ intervalMs: 1_000 }),
  } as Realtime;
}

function wrapper(realtime: Realtime) {
  return ({ children }: { children: ReactNode }) => (
    <RealtimeProvider realtime={realtime}>{children}</RealtimeProvider>
  );
}

const live = replay(workflowEvents(3))!;
const past = replay(workflowEvents(2))!;

test('hooks require the provider', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => renderHook(() => useRealtime())).toThrow('RealtimeProvider');
});

test('useDisplayedModel follows live, then a replay, with stable references', () => {
  const realtime = fakeRealtime();
  const { result } = renderHook(
    () => ({ model: useDisplayedModel(), auth: useWebState((s) => s.auth) }),
    { wrapper: wrapper(realtime) },
  );
  expect(result.current).toEqual({ model: null, auth: 'unknown' });
  act(() =>
    realtime.store.setState({
      active: { workflowId: 'wf1', live, status: 'ready' },
    }),
  );
  expect(result.current.model).toBe(live);
  act(() =>
    realtime.store.setState({
      replay: {
        workflowId: 'wf1',
        eventCount: 3,
        seq: 2,
        model: past,
        loading: false,
        progress: 1,
      },
    }),
  );
  expect(result.current.model).toBe(past);
});

test('useViewModel recomputes only for a new model, selector or shallow args', () => {
  const realtime = fakeRealtime();
  const selector = vi.fn(
    (model: ReadModel | null, args: { label: string }) => ({
      label: args.label,
      seq: model?.lastSeq ?? 0,
    }),
  );
  const { result, rerender } = renderHook(
    ({ label }: { label: string }) => useViewModel(selector, { label }),
    { wrapper: wrapper(realtime), initialProps: { label: 'a' } },
  );
  expect(result.current).toEqual({ label: 'a', seq: 0 });
  const first = result.current;
  rerender({ label: 'a' });
  expect(result.current).toBe(first);
  expect(selector).toHaveBeenCalledTimes(1);
  rerender({ label: 'b' });
  expect(result.current).toEqual({ label: 'b', seq: 0 });
  act(() =>
    realtime.store.setState({
      active: { workflowId: 'wf1', live, status: 'ready' },
    }),
  );
  expect(result.current).toEqual({ label: 'b', seq: 3 });
  expect(selector).toHaveBeenCalledTimes(3);
  // Unrelated store updates do not recompute.
  act(() => realtime.store.setState({ auth: 'ok' }));
  expect(selector).toHaveBeenCalledTimes(3);
});

test('useViewModel passes the previous VM to stabilize', () => {
  const realtime = fakeRealtime();
  const calls: unknown[] = [];
  const keepIfSameSeq: Stabilize = <T,>(prev: T | undefined, next: T): T => {
    calls.push(prev);
    return prev !== undefined &&
      (prev as { seq: number }).seq === (next as { seq: number }).seq
      ? prev
      : next;
  };
  const select = (model: ReadModel | null, args: { n: number }) => ({
    seq: model?.lastSeq ?? 0,
    n: args.n,
  });
  const { result, rerender } = renderHook(
    ({ n }: { n: number }) => useViewModel(select, { n }, keepIfSameSeq),
    { wrapper: wrapper(realtime), initialProps: { n: 1 } },
  );
  const first = result.current;
  rerender({ n: 2 });
  expect(result.current).toBe(first);
  expect(calls).toEqual([undefined, first]);
});

test('useNow ticks with the global ticker', () => {
  vi.useFakeTimers();
  const realtime = fakeRealtime();
  const { result } = renderHook(() => useNow(), {
    wrapper: wrapper(realtime),
  });
  const start = result.current;
  act(() => vi.advanceTimersByTime(1_000));
  expect(result.current).toBeGreaterThan(start);
});

test('useAppliedEvents delivers to the latest listener until unmount', () => {
  const realtime = fakeRealtime();
  const seen: string[] = [];
  function Probe({ tag }: { tag: string }) {
    useAppliedEvents((a) => seen.push(`${tag}:${a.event.seq}`));
    return null;
  }
  const { rerender, unmount } = render(
    <RealtimeProvider realtime={realtime}>
      <Probe tag="a" />
    </RealtimeProvider>,
  );
  const applied = {
    event: workflowEvents(1)[0]!,
    prev: null,
    next: null,
    background: false,
  };
  realtime.bus.emit(applied);
  rerender(
    <RealtimeProvider realtime={realtime}>
      <Probe tag="b" />
    </RealtimeProvider>,
  );
  realtime.bus.emit(applied);
  unmount();
  realtime.bus.emit(applied);
  expect(seen).toEqual(['a:1', 'b:1']);
});

test('shallowEqual compares own keys by Object.is', () => {
  const same = {};
  expect(shallowEqual(same, same)).toBe(true);
  expect(shallowEqual({ a: 1, b: same }, { a: 1, b: same })).toBe(true);
  expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  expect(shallowEqual({ a: 1, c: undefined }, { a: 1, b: undefined })).toBe(
    false,
  );
  expect(shallowEqual({ a: NaN }, { a: NaN })).toBe(true);
  expect(shallowEqual({ a: {} }, { a: {} })).toBe(false);
});
