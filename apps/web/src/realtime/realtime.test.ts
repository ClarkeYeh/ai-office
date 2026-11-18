import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import fc from 'fast-check';
import type { DomainEvent } from '@ai-office/contracts/events';
import { evolve, replay } from '@ai-office/projection';
import {
  CATCH_UP_MAX_MS,
  CATCH_UP_QUIET_MS,
  createRealtime,
  defaultRequestFrame,
  STALE_EVENT_MS,
} from './realtime.js';
import { OVERVIEW_DEBOUNCE_MS } from './overview.js';
import {
  at,
  domainEvent,
  healthChanged,
  usageTokens,
  workflowEvents,
} from './test-support/events.js';
import {
  apiError,
  createFakeServer,
  FakeEventSource,
  FakeWorker,
  resetFakes,
} from './test-support/fakes.js';
import type { AppliedEvent } from './types.js';

const NOW = Date.parse(at);
const fresh = (seq: number, workflowId = 'wf1') =>
  usageTokens(seq, 'a1', workflowId, at);

/** A second workflow that started later, so it is the newest (lower-bound source). */
const newer = (count: number, workflowId: string, firstSeq: number) =>
  workflowEvents(count, workflowId, firstSeq).map((e) => ({
    ...e,
    occurredAt: '2026-11-18T01:00:00.000Z',
  }));

/** Generous: the CI/dev machine may be heavily loaded. */
const eventually = (check: () => void) =>
  vi.waitFor(check, { timeout: 10_000 });

beforeEach(() => resetFakes());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(log: DomainEvent[] = workflowEvents(5)) {
  const server = createFakeServer(log);
  const frames: (() => void)[] = [];
  let hidden = false;
  let now = NOW;
  const openEventSource = vi.fn((url: string) => new FakeEventSource(url));
  const realtime = createRealtime({
    api: server.api,
    openEventSource,
    createWorker: () => new FakeWorker(),
    clock: () => now,
    isHidden: () => hidden,
    requestFrame: (flush) => {
      frames.push(flush);
      return () => frames.splice(frames.indexOf(flush), 1);
    },
  });
  const applied: AppliedEvent[] = [];
  realtime.bus.subscribe((a) => applied.push(a));
  const flush = () => {
    while (frames.length) frames.shift()!();
  };
  /** Append to the server log and push over the current stream. */
  const publish = (...events: DomainEvent[]) => {
    server.log.push(...events);
    FakeEventSource.latest().domain(...events);
  };
  return {
    ...server,
    realtime,
    openEventSource,
    store: realtime.store,
    applied,
    frames,
    flush,
    publish,
    setHidden: (value: boolean) => (hidden = value),
    advanceClock: (ms: number) => (now += ms),
  };
}

/** Open the stream and let its catch-up window close. */
async function goLive() {
  FakeEventSource.latest().open();
  await vi.advanceTimersByTimeAsync(CATCH_UP_QUIET_MS);
}

test('lower-bound start: newest snapshot → open global stream → overview', async () => {
  vi.useFakeTimers();
  const log = [
    ...workflowEvents(3, 'old'),
    ...newer(2, 'wf1', 10),
    healthChanged(20),
  ];
  const t = setup(log);
  await t.realtime.start();
  const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
    fn.mock.invocationCallOrder[0]!;
  expect(order(t.api.listWorkflows)).toBeLessThan(order(t.api.getWorkflow));
  expect(order(t.api.getWorkflow)).toBeLessThan(order(t.openEventSource));
  for (const fetch of [
    t.api.listGates,
    t.api.listQuestions,
    t.api.getHealth,
    t.api.listRepos,
  ])
    expect(order(t.openEventSource)).toBeLessThan(order(fetch));
  expect(t.api.listWorkflows).toHaveBeenCalledTimes(2);
  expect(order(t.openEventSource)).toBeLessThan(
    t.api.listWorkflows.mock.invocationCallOrder[1]!,
  );
  // `old` started first; wf1's snapshot (asOfSeq 11) is the lower bound.
  expect(t.api.getWorkflow).toHaveBeenCalledWith('wf1');
  expect(t.openEventSource).toHaveBeenCalledTimes(1);
  expect(FakeEventSource.latest().url).toBe('/api/v1/stream?afterSeq=11');
  expect(t.store.getState().connection).toMatchObject({
    status: 'connecting',
    cursor: 0,
  });
  await goLive();
  expect(t.store.getState()).toMatchObject({
    auth: 'ok',
    connection: { status: 'live', catchingUp: false },
  });
  t.publish(healthChanged(20));
  t.flush();
  expect(t.store.getState().connection.cursor).toBe(20);
});

test('no workflows: the stream starts at 0', async () => {
  vi.useFakeTimers();
  const t = setup([healthChanged(1)]);
  await t.realtime.start();
  expect(FakeEventSource.latest().afterSeq).toBe(0);
  expect(t.store.getState().active.status).toBe('idle');
  // start() is idempotent while running.
  await t.realtime.start();
  expect(FakeEventSource.instances).toHaveLength(1);
});

test('an active workflow chosen before start is the lower-bound snapshot', async () => {
  vi.useFakeTimers();
  const t = setup([...workflowEvents(4), ...newer(2, 'wf2', 10)]);
  await t.realtime.setActiveWorkflow('wf1');
  expect(t.store.getState().active).toMatchObject({
    workflowId: 'wf1',
    status: 'loading',
  });
  await t.realtime.start();
  expect(t.api.listWorkflows).toHaveBeenCalledTimes(1); // overview only
  expect(FakeEventSource.latest().afterSeq).toBe(4);
  expect(t.store.getState().active).toMatchObject({ status: 'ready' });
  expect(t.store.getState().active.live).toEqual(replay(workflowEvents(4)));
});

test('a missing active workflow falls back to the newest one for the bound', async () => {
  vi.useFakeTimers();
  const t = setup(workflowEvents(3, 'wf2'));
  await t.realtime.setActiveWorkflow('gone');
  await t.realtime.start();
  expect(t.store.getState().active.status).toBe('missing');
  expect(FakeEventSource.latest().afterSeq).toBe(3);
  // Its workflow.started can still arrive later and make it ready.
  await goLive();
  t.publish(
    domainEvent('workflow.started', 4, workflowEvents(1)[0]!.payload, 'gone'),
  );
  t.flush();
  expect(t.store.getState().active).toMatchObject({ status: 'ready' });
  expect(t.store.getState().active.live!.workflowId).toBe('gone');
});

test('applies active events, skips seq ≤ cursor, signals overview for others', async () => {
  vi.useFakeTimers();
  const t = setup();
  await t.realtime.setActiveWorkflow('wf1');
  await t.realtime.start();
  await goLive();
  const before = t.store.getState().active.live;
  t.publish(fresh(6), fresh(7, 'other'), fresh(6));
  FakeEventSource.latest().domain(fresh(3));
  t.flush();
  const live = t.store.getState().active.live!;
  expect(live.lastSeq).toBe(6);
  expect(live).toEqual(evolve(before!, fresh(6)));
  expect(t.store.getState().connection.cursor).toBe(7);
  expect(t.applied.map((a) => a.event.seq)).toEqual([6]);
  expect(t.applied[0]).toMatchObject({
    prev: before,
    next: live,
    background: false,
  });
  t.api.listWorkflows.mockClear();
  await vi.advanceTimersByTimeAsync(OVERVIEW_DEBOUNCE_MS);
  expect(t.api.listWorkflows).toHaveBeenCalledTimes(1);
});

test('batching: one store update per frame, one AppliedEvent per changed event', async () => {
  vi.useFakeTimers();
  const t = setup();
  await t.realtime.setActiveWorkflow('wf1');
  await t.realtime.start();
  await goLive();
  const updates = vi.fn();
  t.store.subscribe(updates);
  t.publish(fresh(6), fresh(7), fresh(8));
  expect(t.frames).toHaveLength(1);
  expect(updates).not.toHaveBeenCalled();
  t.flush();
  expect(updates).toHaveBeenCalledTimes(1);
  expect(t.applied.map((a) => a.event.seq)).toEqual([6, 7, 8]);
  expect(t.applied[1]!.prev).toBe(t.applied[0]!.next);
});

test('property: any split of the stream into frames equals evolving one by one', async () => {
  vi.useFakeTimers();
  const base = workflowEvents(3);
  const stream = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((seq) =>
    seq % 4 === 0 ? fresh(seq, 'other') : fresh(seq),
  );
  const expected = stream.reduce(
    (model, event) => evolve(model, event),
    replay(base),
  );
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.boolean(), {
        minLength: stream.length,
        maxLength: stream.length,
      }),
      async (cuts) => {
        resetFakes();
        const t = setup([...base]);
        await t.realtime.setActiveWorkflow('wf1');
        await t.realtime.start();
        stream.forEach((event, i) => {
          t.publish(event);
          if (cuts[i]) t.flush();
        });
        t.flush();
        expect(t.store.getState().active.live).toEqual(expected);
        expect(t.applied.map((a) => a.event.seq)).toEqual(
          stream.filter((e) => e.workflowId === 'wf1').map((e) => e.seq),
        );
        t.realtime.stop();
      },
    ),
    { numRuns: 25 },
  );
});

test('background: recorded before the open, stale occurredAt, hidden page', async () => {
  vi.useFakeTimers();
  const t = setup();
  await t.realtime.setActiveWorkflow('wf1');
  await t.realtime.start();
  // Backlog was recorded before the connection opened.
  t.advanceClock(1_000);
  FakeEventSource.latest().open();
  expect(t.store.getState().connection.catchingUp).toBe(true);
  t.publish(fresh(6));
  await vi.advanceTimersByTimeAsync(CATCH_UP_QUIET_MS - 1);
  t.publish(fresh(7));
  // Live events right after the open still animate, even while catching up.
  const live = (seq: number) =>
    domainEvent(
      'usage.tokens',
      seq,
      fresh(seq).payload,
      'wf1',
      at,
      '2026-11-18T00:00:01.000Z',
    );
  t.publish(live(8));
  await vi.advanceTimersByTimeAsync(CATCH_UP_QUIET_MS);
  expect(t.store.getState().connection.catchingUp).toBe(false);
  t.publish(live(9));
  t.advanceClock(STALE_EVENT_MS);
  t.publish(live(10));
  t.advanceClock(-STALE_EVENT_MS);
  t.setHidden(true);
  t.publish(live(11));
  t.setHidden(false);
  t.flush();
  expect(t.applied.map((a) => [a.event.seq, a.background])).toEqual([
    [6, true],
    [7, true],
    [8, false],
    [9, false],
    [10, true],
    [11, true],
  ]);
});

test('a continuous stream still ends catch-up after 3 s', async () => {
  vi.useFakeTimers();
  const t = setup();
  await t.realtime.start();
  FakeEventSource.latest().open();
  for (let seq = 6; seq < 6 + CATCH_UP_MAX_MS / 100; seq++) {
    t.publish(fresh(seq));
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(t.store.getState().connection.catchingUp).toBe(false);
});

test('native reconnect resumes and marks the backlog background', async () => {
  vi.useFakeTimers();
  const t = setup();
  await t.realtime.setActiveWorkflow('wf1');
  await t.realtime.start();
  await goLive();
  const es = FakeEventSource.latest();
  es.fail(false);
  expect(t.store.getState().connection.status).toBe('reconnecting');
  t.advanceClock(1_000);
  es.open();
  t.publish(fresh(6));
  t.flush();
  expect(t.store.getState().connection.status).toBe('live');
  expect(t.applied.at(-1)!.background).toBe(true);
  expect(FakeEventSource.instances).toHaveLength(1);
});

test('backend restart (CLOSED): reopen at cursor, no duplicates, no gaps, no animation', async () => {
  vi.useFakeTimers();
  const t = setup();
  await t.realtime.setActiveWorkflow('wf1');
  await t.realtime.start();
  await goLive();
  t.publish(fresh(6), fresh(7));
  t.flush();
  expect(t.applied.every((a) => !a.background)).toBe(true);
  t.applied.length = 0;
  // Backend down: the proxy answers 502, the browser gives up.
  t.api.getHealth.mockRejectedValueOnce(apiError(502));
  FakeEventSource.latest().fail(true);
  expect(t.store.getState().connection.status).toBe('reconnecting');
  // Events keep being recorded while we are disconnected.
  t.log.push(fresh(8), fresh(9, 'other'), fresh(10));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(t.store.getState().connection.status).toBe('offline');
  expect(FakeEventSource.instances).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(2_000);
  const reopened = FakeEventSource.latest();
  expect(FakeEventSource.instances).toHaveLength(2);
  expect(reopened.afterSeq).toBe(7);
  // The server replays everything after the cursor, overlapping one event.
  t.advanceClock(3_000);
  reopened.open();
  reopened.domain(...t.log.filter((e) => e.seq >= 7));
  t.flush();
  expect(t.applied.map((a) => [a.event.seq, a.background])).toEqual([
    [8, true],
    [10, true],
  ]);
  expect(t.store.getState().active.live).toEqual(
    replay(t.log.filter((e) => e.workflowId === 'wf1')),
  );
});

test('a 401 health probe stops reconnecting and marks auth missing', async () => {
  vi.useFakeTimers();
  const t = setup();
  await t.realtime.start();
  await goLive();
  t.api.getHealth.mockRejectedValueOnce(apiError(401));
  FakeEventSource.latest().fail(true);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(t.store.getState()).toMatchObject({
    auth: 'missing',
    connection: { status: 'offline' },
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(FakeEventSource.instances).toHaveLength(1);
});

test('401 while bootstrapping marks auth missing without opening the stream', async () => {
  vi.useFakeTimers();
  const t = setup();
  t.api.listWorkflows.mockRejectedValue(apiError(401));
  await t.realtime.start();
  expect(t.store.getState().auth).toBe('missing');
  expect(FakeEventSource.instances).toHaveLength(0);
});

test('other bootstrap failures still open the stream at the cursor', async () => {
  vi.useFakeTimers();
  const t = setup();
  t.api.listWorkflows.mockRejectedValueOnce(apiError(500));
  await t.realtime.start();
  expect(FakeEventSource.latest().afterSeq).toBe(0);
});

test('an overview 401 marks auth missing', async () => {
  vi.useFakeTimers();
  const t = setup();
  t.api.listRepos.mockRejectedValueOnce(apiError(401));
  await t.realtime.start();
  expect(t.store.getState().auth).toBe('missing');
  expect(FakeEventSource.latest().closed).toBe(true);
});

test('resync_required: close, refetch snapshot and overview, reopen at the new bound', async () => {
  vi.useFakeTimers();
  const t = setup();
  await t.realtime.setActiveWorkflow('wf1');
  await t.realtime.start();
  await goLive();
  t.publish(fresh(6));
  t.flush();
  // The server dropped us; it recorded more than we received.
  t.log.push(fresh(7), fresh(8));
  const statuses: string[] = [];
  t.store.subscribe((s) => statuses.push(s.connection.status));
  const live = t.store.getState().active.live;
  t.api.listGates.mockClear();
  FakeEventSource.latest().resync();
  expect(FakeEventSource.instances[0]!.closed).toBe(true);
  expect(t.store.getState().connection).toMatchObject({
    status: 'resyncing',
    catchingUp: true,
  });
  // The screen is not cleared while resyncing.
  expect(t.store.getState().active.live).toBe(live);
  await eventually(() => expect(FakeEventSource.instances).toHaveLength(2));
  expect(FakeEventSource.latest().afterSeq).toBe(8);
  expect(t.store.getState().active.live!.lastSeq).toBe(8);
  await vi.advanceTimersByTimeAsync(0);
  expect(t.api.listGates).toHaveBeenCalledTimes(1);
  await goLive();
  expect(statuses.at(-1)).toBe('live');
  expect(t.store.getState().connection.catchingUp).toBe(false);
});

test('resync with nothing new reopens at the cursor', async () => {
  vi.useFakeTimers();
  const t = setup();
  await t.realtime.start();
  await goLive();
  t.publish(healthChanged(9));
  FakeEventSource.latest().resync();
  await eventually(() => expect(FakeEventSource.instances).toHaveLength(2));
  expect(FakeEventSource.latest().afterSeq).toBe(9);
});

test('switching active uses the ring buffer when it reaches back far enough', async () => {
  vi.useFakeTimers();
  const t = setup([...workflowEvents(3, 'wf1'), ...newer(2, 'wf2', 10)]);
  await t.realtime.start(); // bound 11 (wf2 is newest)
  await goLive();
  t.publish(fresh(12, 'wf2'), fresh(13, 'wf2'));
  t.flush();
  let resolve!: () => void;
  const original = t.api.getWorkflow.getMockImplementation()!;
  t.api.getWorkflow.mockImplementationOnce(async (id) => {
    const snapshot = await original(id);
    await new Promise<void>((r) => (resolve = r));
    return snapshot;
  });
  const switching = t.realtime.setActiveWorkflow('wf2');
  // Events that arrive while the snapshot loads are buffered, then applied.
  await eventually(() => expect(resolve).toBeTypeOf('function'));
  t.publish(fresh(14, 'wf2'));
  t.flush();
  resolve();
  await switching;
  expect(t.api.listEvents).not.toHaveBeenCalled();
  expect(t.store.getState().active.live).toEqual(
    replay(t.log.filter((e) => e.workflowId === 'wf2')),
  );
  expect(t.applied.map((a) => [a.event.seq, a.background])).toEqual([
    [14, true],
  ]);
});

test('switching active fills the gap from /events when the buffer cannot', async () => {
  vi.useFakeTimers();
  const t = setup([...workflowEvents(3, 'wf1'), ...newer(2, 'wf2', 10)]);
  await t.realtime.start(); // bound 11, nothing of wf1 buffered at or below it
  await goLive();
  // The buffer only covers seq > 11; wf1's snapshot is at 3, so /events is asked.
  const catchingUp: boolean[] = [];
  t.store.subscribe((s) => catchingUp.push(s.connection.catchingUp));
  await t.realtime.setActiveWorkflow('wf1');
  expect(t.api.listEvents).toHaveBeenCalledWith('wf1', { afterSeq: 3 });
  expect(catchingUp).toContain(true);
  expect(t.store.getState().connection.catchingUp).toBe(false);
  expect(t.store.getState().active).toMatchObject({ status: 'ready' });
});

test('gap fill pages through /events and applies everything after the snapshot', async () => {
  vi.useFakeTimers();
  const t = setup([...workflowEvents(3, 'wf1'), ...newer(2, 'wf2', 10)]);
  await t.realtime.start();
  await goLive();
  const stale = replay(workflowEvents(2, 'wf1'))!;
  t.api.getWorkflow.mockResolvedValueOnce({ readModel: stale, asOfSeq: 2 });
  const realList = t.api.listEvents.getMockImplementation()!;
  t.api.listEvents.mockImplementation((id, query) =>
    realList(id, { ...query, limit: 1 }),
  );
  t.log.push(fresh(4, 'wf1'));
  await t.realtime.setActiveWorkflow('wf1');
  expect(t.api.listEvents).toHaveBeenCalledTimes(2);
  expect(t.store.getState().active.live).toEqual(
    replay(t.log.filter((e) => e.workflowId === 'wf1')),
  );
});

test('a stale switch never lands; 404 marks missing; null goes idle', async () => {
  vi.useFakeTimers();
  const t = setup([...workflowEvents(3, 'wf1'), ...newer(2, 'wf2', 10)]);
  await t.realtime.start();
  await goLive();
  const first = t.realtime.setActiveWorkflow('wf1');
  const second = t.realtime.setActiveWorkflow('wf2');
  await Promise.all([first, second]);
  expect(t.store.getState().active.live!.workflowId).toBe('wf2');
  await t.realtime.setActiveWorkflow('wf2');
  await expect(t.realtime.setActiveWorkflow('nope')).rejects.toEqual(
    apiError(404),
  );
  expect(t.store.getState().active.status).toBe('missing');
  await t.realtime.setActiveWorkflow(null);
  expect(t.store.getState().active).toEqual({
    workflowId: null,
    live: null,
    status: 'idle',
  });
  // A failure of an abandoned switch is ignored.
  t.api.getWorkflow.mockRejectedValueOnce(apiError(500));
  const abandoned = t.realtime.setActiveWorkflow('wf1');
  await t.realtime.setActiveWorkflow('wf2');
  await expect(abandoned).resolves.toBeUndefined();
  // A non-404 error leaves it loading and reports a 401.
  t.api.getWorkflow.mockRejectedValueOnce(apiError(401));
  await expect(t.realtime.setActiveWorkflow('wf1')).rejects.toEqual(
    apiError(401),
  );
  expect(t.store.getState().auth).toBe('missing');
});

test('a gap fill abandoned midway is dropped', async () => {
  vi.useFakeTimers();
  const t = setup([...workflowEvents(3, 'wf1'), ...newer(2, 'wf2', 10)]);
  await t.realtime.start();
  await goLive();
  let release!: () => void;
  const realList = t.api.listEvents.getMockImplementation()!;
  t.api.listEvents.mockImplementationOnce(async (id, query) => {
    await new Promise<void>((r) => (release = r));
    return realList(id, query);
  });
  const abandoned = t.realtime.setActiveWorkflow('wf1');
  await eventually(() => expect(release).toBeTypeOf('function'));
  await t.realtime.setActiveWorkflow(null);
  release();
  await abandoned;
  expect(t.store.getState().active.live).toBeNull();
});

test('while replaying, live events update live but do not animate', async () => {
  vi.useFakeTimers();
  const t = setup();
  await t.realtime.setActiveWorkflow('wf1');
  await t.realtime.start();
  await goLive();
  await t.realtime.replay.open('wf1');
  t.publish(fresh(6));
  t.flush();
  expect(t.store.getState().active.live!.lastSeq).toBe(6);
  expect(t.store.getState().replay!.eventCount).toBe(6);
  expect(t.applied).toEqual([]);
  t.realtime.replay.exit();
  t.publish(fresh(7));
  t.flush();
  expect(t.applied.map((a) => a.event.seq)).toEqual([7]);
});

test('stop closes everything; start again reconnects from the cursor', async () => {
  vi.useFakeTimers();
  const t = setup();
  await t.realtime.start();
  await goLive();
  t.publish(fresh(6));
  t.realtime.stop();
  expect(t.frames).toHaveLength(0);
  expect(FakeEventSource.latest().closed).toBe(true);
  expect(t.store.getState().connection).toMatchObject({
    status: 'offline',
    catchingUp: false,
  });
  t.api.listWorkflows.mockClear();
  await vi.advanceTimersByTimeAsync(OVERVIEW_DEBOUNCE_MS);
  expect(t.api.listWorkflows).not.toHaveBeenCalled();
  await t.realtime.start();
  expect(FakeEventSource.instances).toHaveLength(2);
  expect(FakeEventSource.latest().afterSeq).toBe(6);
});

test('defaultRequestFrame uses rAF with a timer fallback, once', () => {
  vi.useFakeTimers();
  const callbacks: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    callbacks.push(cb);
    return callbacks.length;
  });
  const cancelAnimationFrame = vi.fn();
  vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame);
  const flush = vi.fn();
  defaultRequestFrame(flush);
  callbacks[0]!(0);
  vi.runAllTimers();
  expect(flush).toHaveBeenCalledTimes(1);
  // Hidden page: no rAF callback, the timer applies the batch.
  defaultRequestFrame(flush);
  vi.advanceTimersByTime(100);
  expect(flush).toHaveBeenCalledTimes(2);
  expect(cancelAnimationFrame).toHaveBeenCalledWith(2);
  callbacks[1]!(0);
  expect(flush).toHaveBeenCalledTimes(2);
  const cancel = defaultRequestFrame(flush);
  cancel();
  vi.runAllTimers();
  callbacks[2]!(0);
  expect(flush).toHaveBeenCalledTimes(2);
});

test('defaultRequestFrame works without rAF (Node, workers)', () => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', undefined);
  const flush = vi.fn();
  defaultRequestFrame(flush);
  vi.advanceTimersByTime(100);
  expect(flush).toHaveBeenCalledTimes(1);
});

test('defaults: real store, bus, ticker, clock and document visibility', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('document', { visibilityState: 'hidden' });
  const server = createFakeServer(workflowEvents(2));
  const realtime = createRealtime({
    api: server.api,
    openEventSource: (url) => new FakeEventSource(url),
    createWorker: () => new FakeWorker(),
  });
  const applied: AppliedEvent[] = [];
  realtime.bus.subscribe((a) => applied.push(a));
  expect(realtime.ticker.now()).toBeGreaterThan(0);
  await realtime.setActiveWorkflow('wf1');
  await realtime.start();
  await goLive();
  FakeEventSource.latest().domain(
    usageTokens(3, 'a1', 'wf1', new Date().toISOString()),
  );
  await vi.advanceTimersByTimeAsync(100);
  expect(applied.map((a) => [a.event.seq, a.background])).toEqual([[3, true]]);
});
