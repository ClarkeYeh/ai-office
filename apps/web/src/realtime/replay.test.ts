import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { replay as replayTo } from '@ai-office/projection';
import type { DomainEvent } from '@ai-office/contracts/events';
import { createAppliedBus } from './bus.js';
import { createReplayController, type WorkerLike } from './replay.js';
import type { ReplayRequest, ReplayResponse } from './replay-engine.js';
import { createWebStore, selectDisplayedModel } from './store.js';
import { usageTokens, workflowEvents } from './test-support/events.js';
import {
  apiError,
  createFakeServer,
  FakeWorker,
  resetFakes,
} from './test-support/fakes.js';
import type { AppliedEvent } from './types.js';

/** Generous: the CI/dev machine may be heavily loaded. */
const eventually = (check: () => void) =>
  vi.waitFor(check, { timeout: 10_000 });

beforeEach(() => resetFakes());
afterEach(() => vi.useRealTimers());

function setup(events: DomainEvent[], pageSize = 4) {
  const server = createFakeServer([...events]);
  const store = createWebStore();
  const bus = createAppliedBus();
  const applied: AppliedEvent[] = [];
  bus.subscribe((a) => applied.push(a));
  const controller = createReplayController({
    api: server.api,
    store,
    bus,
    createWorker: () => new FakeWorker(),
    head: () => events.at(-1)!.seq,
    pageSize,
  });
  return { ...server, store, controller, applied };
}

test('pages in events with progress, then shows the head through the worker', async () => {
  const events = workflowEvents(10);
  const { api, store, controller } = setup(events);
  const progress: number[] = [];
  store.subscribe((s) => s.replay && progress.push(s.replay.progress));
  await controller.open('wf1');
  expect(api.listEvents.mock.calls.map((c) => c[1])).toEqual([
    { afterSeq: 0, limit: 4 },
    { afterSeq: 4, limit: 4 },
    { afterSeq: 8, limit: 4 },
  ]);
  expect(progress).toContain(0.4);
  expect(progress).toContain(0.8);
  expect(store.getState().replay).toMatchObject({
    workflowId: 'wf1',
    eventCount: 10,
    loading: false,
    progress: 1,
    seq: 10,
    model: null,
  });
  await eventually(() =>
    expect(store.getState().replay!.model).toEqual(replayTo(events)),
  );
  // Only results are sent back; checkpoints stay in the worker.
  const worker = FakeWorker.instances[0]!;
  expect(worker.posted.filter((m) => m.type === 'append')).toHaveLength(3);
});

test('dragging returns only the latest position and emits nothing', async () => {
  const events = workflowEvents(12);
  const { store, controller, applied } = setup(events);
  await controller.open('wf1');
  await eventually(() => expect(store.getState().replay!.model).not.toBeNull());
  controller.seek(3);
  controller.seek(8);
  controller.seek(5);
  expect(store.getState().replay!.seq).toBe(5);
  await eventually(() =>
    expect(selectDisplayedModel(store.getState())).toEqual(replayTo(events, 5)),
  );
  expect(store.getState().replay).toMatchObject({ seq: 5 });
  expect(applied).toEqual([]);
});

test('a stale answer that arrives after a newer request is dropped', async () => {
  const events = workflowEvents(6);
  const store = createWebStore();
  const posted: ReplayRequest[] = [];
  const worker: WorkerLike = {
    onmessage: null,
    postMessage: (m) => posted.push(m),
    terminate: vi.fn(),
  };
  const controller = createReplayController({
    api: createFakeServer(events).api,
    store,
    bus: createAppliedBus(),
    createWorker: () => worker,
    head: () => 6,
  });
  await controller.open('wf1');
  controller.seek(2);
  const reply = (data: ReplayResponse) =>
    worker.onmessage!(new MessageEvent('message', { data }));
  reply({ type: 'appended', eventCount: 6, lastSeq: 6 });
  reply({ type: 'result', id: 1, seq: 6, model: replayTo(events, 6) });
  expect(store.getState().replay!.model).toBeNull();
  reply({ type: 'result', id: 2, seq: 2, model: replayTo(events, 2) });
  expect(store.getState().replay!.model).toEqual(replayTo(events, 2));
  // step() is refused while a seek is unanswered.
  controller.seek(4);
  expect(controller.step()).toBe(false);
});

test('step applies the next event on the main thread as a non-background AppliedEvent', async () => {
  const events = workflowEvents(5);
  const { store, controller, applied } = setup(events);
  await controller.open('wf1');
  await eventually(() => expect(store.getState().replay!.model).not.toBeNull());
  controller.seek(0);
  await eventually(() => expect(store.getState().replay!.model).toBeNull());
  for (let seq = 1; seq <= 5; seq++) {
    expect(controller.step()).toBe(true);
    expect(store.getState().replay!.seq).toBe(seq);
    expect(store.getState().replay!.model).toEqual(replayTo(events, seq));
  }
  expect(controller.step()).toBe(false);
  expect(applied.map((a) => [a.event.seq, a.background])).toEqual([
    [1, false],
    [2, false],
    [3, false],
    [4, false],
    [5, false],
  ]);
  expect(applied[0]!.prev).toBeNull();
  expect(applied[4]!.next).toEqual(replayTo(events));
});

test('live events reach the worker, including those that arrive while loading', async () => {
  const events = workflowEvents(6);
  const { log, store, controller } = setup(events);
  const opening = controller.open('wf1');
  const early = usageTokens(7, 'a1');
  log.push(early);
  controller.onLive(early);
  controller.onLive(usageTokens(99, 'a1', 'other'));
  await opening;
  expect(store.getState().replay!.eventCount).toBe(7);
  controller.onLive(usageTokens(8, 'a1'));
  expect(store.getState().replay!.eventCount).toBe(8);
  controller.onLive(usageTokens(8, 'a1'));
  expect(store.getState().replay!.eventCount).toBe(8);
  controller.seek(8);
  await eventually(() =>
    expect(store.getState().replay!.model?.lastSeq).toBe(8),
  );
  // Without a replay, live events are ignored.
  controller.exit();
  controller.onLive(usageTokens(9, 'a1'));
  expect(store.getState().replay).toBeNull();
});

test('exit terminates the worker; reopening discards the old session', async () => {
  const events = workflowEvents(6);
  const { store, controller } = setup(events, 2);
  const first = controller.open('wf1');
  const second = controller.open('wf1');
  await Promise.all([first, second]);
  expect(FakeWorker.instances[0]!.terminated).toBe(true);
  expect(store.getState().replay!.eventCount).toBe(6);
  controller.exit();
  expect(FakeWorker.instances[1]!.terminated).toBe(true);
  expect(store.getState().replay).toBeNull();
  controller.seek(3);
  expect(controller.step()).toBe(false);
});

test('a failed page load leaves replay and rethrows', async () => {
  const events = workflowEvents(6);
  const { api, store, controller } = setup(events);
  api.listEvents.mockRejectedValueOnce(apiError(404));
  await expect(controller.open('wf1')).rejects.toEqual(apiError(404));
  expect(store.getState().replay).toBeNull();
  // A failure of an abandoned session does not touch the newer one.
  let reject!: (error: unknown) => void;
  api.listEvents.mockImplementationOnce(
    () => new Promise((_, no) => (reject = no)),
  );
  const stale = controller.open('wf1');
  const fresh = controller.open('wf1');
  reject(new Error('late'));
  await expect(stale).rejects.toThrow('late');
  await fresh;
  expect(store.getState().replay!.loading).toBe(false);
});

/**
 * M4_PLAN §9 T3: building checkpoints for 10 000 events must not block the main
 * thread for > 50 ms. The worker stand-in does the clone a real postMessage would do on
 * the main thread, but builds checkpoints "elsewhere"; we measure event-loop gaps.
 */
test('10 000 events: no main-thread task over 50 ms while loading', async () => {
  const events = workflowEvents(10_000);
  const server = createFakeServer(events);
  const realList = server.api.listEvents.getMockImplementation()!;
  server.api.listEvents.mockImplementation(
    (id, query) =>
      new Promise((resolve) =>
        setTimeout(() => resolve(realList(id, query)), 1),
      ),
  );
  const store = createWebStore();
  const worker: WorkerLike = {
    onmessage: null,
    postMessage: (message) => void structuredClone(message),
    terminate: () => {},
  };
  const controller = createReplayController({
    api: server.api,
    store,
    bus: createAppliedBus(),
    createWorker: () => worker,
    head: () => 10_000,
  });
  // Main-thread work between heartbeats, as CPU time: on a loaded machine the OS can
  // preempt us for longer than 50 ms, which is not a task of ours.
  const cpu = () => {
    const { user, system } = process.cpuUsage();
    return (user + system) / 1_000;
  };
  let last = { wall: performance.now(), cpu: cpu() };
  let longest = 0;
  const sample = () => {
    const now = { wall: performance.now(), cpu: cpu() };
    longest = Math.max(
      longest,
      Math.min(now.wall - last.wall, now.cpu - last.cpu),
    );
    last = now;
  };
  const beat = setInterval(sample, 1);
  await controller.open('wf1');
  clearInterval(beat);
  sample();
  expect(store.getState().replay!.eventCount).toBe(10_000);
  expect(longest).toBeLessThan(50);
});
