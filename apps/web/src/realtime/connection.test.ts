import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createStreamConnection, type ProbeResult } from './connection.js';
import { usageTokens } from './test-support/events.js';
import { FakeEventSource, resetFakes } from './test-support/fakes.js';

beforeEach(() => {
  resetFakes();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

function setup(probe: () => Promise<ProbeResult> = async () => 'ok') {
  const handlers = {
    onOpen: vi.fn(),
    onDomain: vi.fn(),
    onResync: vi.fn(),
    onDown: vi.fn(),
    onUnauthorized: vi.fn(),
  };
  let cursor = 0;
  const connection = createStreamConnection({
    open: (url) => new FakeEventSource(url),
    probe: vi.fn(probe),
    cursor: () => cursor,
    handlers,
  });
  return {
    handlers,
    connection,
    setCursor: (seq: number) => (cursor = seq),
  };
}

test('opens the global stream at afterSeq and forwards domain frames', () => {
  const { connection, handlers } = setup();
  connection.connect(7);
  const es = FakeEventSource.latest();
  expect(es.url).toBe('/api/v1/stream?afterSeq=7');
  expect(es.url).not.toContain('workflowId');
  es.open();
  expect(handlers.onOpen).toHaveBeenCalledTimes(1);
  es.domain(usageTokens(8, 'a1'));
  es.message('domain', 'not json');
  es.message('domain', '{"no":"seq"}');
  expect(handlers.onDomain).toHaveBeenCalledTimes(1);
  expect(handlers.onDomain.mock.calls[0]![0].seq).toBe(8);
});

test('native reconnect (CONNECTING) is left to the browser', () => {
  const { connection, handlers } = setup();
  connection.connect(0);
  const es = FakeEventSource.latest();
  es.fail(false);
  expect(handlers.onDown).toHaveBeenCalledWith('reconnecting');
  expect(es.closed).toBe(false);
  vi.advanceTimersByTime(60_000);
  expect(FakeEventSource.instances).toHaveLength(1);
});

test('CLOSED: exponential backoff 1 → 30 s, probing health, reopening at cursor', async () => {
  const results: ProbeResult[] = ['unreachable', 'unreachable'];
  const { connection, handlers, setCursor } = setup(
    async () => results.shift() ?? 'ok',
  );
  connection.connect(0);
  setCursor(42);
  FakeEventSource.latest().fail(true);
  expect(FakeEventSource.latest().closed).toBe(true);
  await vi.advanceTimersByTimeAsync(999);
  expect(FakeEventSource.instances).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(handlers.onDown).toHaveBeenLastCalledWith('offline');
  await vi.advanceTimersByTimeAsync(2_000);
  expect(FakeEventSource.instances).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(4_000);
  expect(FakeEventSource.instances).toHaveLength(2);
  const reopened = FakeEventSource.latest();
  expect(reopened.afterSeq).toBe(42);
  // A failure before any open keeps growing the delay…
  reopened.fail(true);
  await vi.advanceTimersByTimeAsync(7_999);
  expect(FakeEventSource.instances).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(FakeEventSource.instances).toHaveLength(3);
  // …and a successful open resets it.
  FakeEventSource.latest().open();
  FakeEventSource.latest().fail(true);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(FakeEventSource.instances).toHaveLength(4);
});

test('backoff is capped at 30 s and a rejected probe counts as offline', async () => {
  const { connection, handlers } = setup(async () => {
    throw new Error('down');
  });
  connection.connect(0);
  FakeEventSource.latest().fail(true);
  // 1 + 2 + 4 + 8 + 16 + 30 + 30
  await vi.advanceTimersByTimeAsync(91_000);
  expect(handlers.onDown).toHaveBeenCalledTimes(8);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(handlers.onDown).toHaveBeenCalledTimes(8);
  await vi.advanceTimersByTimeAsync(1);
  expect(handlers.onDown).toHaveBeenCalledTimes(9);
  expect(FakeEventSource.instances).toHaveLength(1);
});

test('a 401 probe stops reconnecting', async () => {
  const { connection, handlers } = setup(async () => 'unauthorized');
  connection.connect(0);
  FakeEventSource.latest().fail(true);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(handlers.onUnauthorized).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(FakeEventSource.instances).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

test('resync_required closes at once and ignores the dead source', () => {
  const { connection, handlers } = setup();
  connection.connect(0);
  const es = FakeEventSource.latest();
  es.open();
  es.resync();
  expect(es.closed).toBe(true);
  expect(handlers.onResync).toHaveBeenCalledTimes(1);
  es.domain(usageTokens(1, 'a1'));
  es.resync();
  expect(handlers.onDomain).not.toHaveBeenCalled();
  expect(handlers.onResync).toHaveBeenCalledTimes(1);
});

test('close() cancels retries and silences late callbacks', async () => {
  const { connection, handlers } = setup();
  connection.connect(0);
  const first = FakeEventSource.latest();
  connection.connect(5);
  expect(first.closed).toBe(true);
  connection.close();
  const second = FakeEventSource.latest();
  expect(second.closed).toBe(true);
  // Handlers were detached; simulate a browser that still fires them.
  first.domain(usageTokens(1, 'a1'));
  second.message('resync_required', '{}');
  expect(handlers.onDomain).not.toHaveBeenCalled();
  expect(handlers.onResync).not.toHaveBeenCalled();
  connection.connect(0);
  FakeEventSource.latest().fail(true);
  connection.close();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(FakeEventSource.instances).toHaveLength(3);
});

test('late open/error from a replaced source are ignored', async () => {
  let release!: (value: ProbeResult) => void;
  const { connection, handlers } = setup(
    () => new Promise((resolve) => (release = resolve)),
  );
  connection.connect(0);
  const es = FakeEventSource.latest();
  const { onopen, onerror } = es;
  es.fail(true);
  await vi.advanceTimersByTimeAsync(1_000);
  connection.connect(9);
  release('unreachable');
  await vi.advanceTimersByTimeAsync(0);
  onopen!(new Event('open'));
  onerror!(new Event('error'));
  expect(handlers.onOpen).not.toHaveBeenCalled();
  expect(handlers.onDown).toHaveBeenCalledTimes(1);
  expect(FakeEventSource.instances).toHaveLength(2);
});

test('a rejected probe for a replaced connection is ignored', async () => {
  let reject!: (error: Error) => void;
  const { connection, handlers } = setup(
    () => new Promise((_, no) => (reject = no)),
  );
  connection.connect(0);
  FakeEventSource.latest().fail(true);
  await vi.advanceTimersByTimeAsync(1_000);
  connection.close();
  reject(new Error('late'));
  await vi.advanceTimersByTimeAsync(0);
  expect(handlers.onDown).toHaveBeenCalledTimes(1);
});
