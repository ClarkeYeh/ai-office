import type { WorkflowSnapshotResponse } from '@ai-office/contracts/api';
import type { DomainEvent } from '@ai-office/contracts/events';
import { evolve, type ReadModel } from '@ai-office/projection';
import { ApiError, type ApiClient } from '../api/index.js';
import { createEventBuffers, type EventBuffers } from './buffer.js';
import { createAppliedBus, type AppliedBus } from './bus.js';
import {
  createStreamConnection,
  type EventSourceFactory,
  type ProbeResult,
} from './connection.js';
import { createOverviewRefresher } from './overview.js';
import {
  createReplayController,
  type ReplayController,
  type WorkerLike,
} from './replay.js';
import { createWebStore, type WebStore } from './store.js';
import { createTicker, type Ticker } from './ticker.js';
import type { AppliedEvent, WebState } from './types.js';

/** Events older than this when received are applied without animation (§3.4). */
export const STALE_EVENT_MS = 10_000;
/** After a (re)open, `catchingUp` clears once the stream is quiet this long… */
export const CATCH_UP_QUIET_MS = 250;
/** …or at the latest this long after the open. */
export const CATCH_UP_MAX_MS = 3_000;
const FRAME_FALLBACK_MS = 100;

export type RealtimeApi = Pick<
  ApiClient,
  | 'getHealth'
  | 'listRepos'
  | 'listWorkflows'
  | 'getWorkflow'
  | 'listEvents'
  | 'listGates'
  | 'listQuestions'
>;

export interface RealtimeOptions {
  api: RealtimeApi;
  openEventSource: EventSourceFactory;
  createWorker: () => WorkerLike;
  store?: WebStore;
  bus?: AppliedBus;
  ticker?: Ticker;
  clock?: () => number;
  isHidden?: () => boolean;
  /** Schedules one batch per animation frame; returns a cancel function. */
  requestFrame?: (flush: () => void) => () => void;
}

export interface Realtime {
  readonly store: WebStore;
  readonly bus: AppliedBus;
  readonly ticker: Ticker;
  readonly replay: ReplayController;
  /** Lower-bound start: snapshot → open the global stream → fetch overview. */
  start(): Promise<void>;
  stop(): void;
  /** Keep the stream; load the snapshot and fill it from the ring buffer or `/events`. */
  setActiveWorkflow(workflowId: string | null): Promise<void>;
}

/** requestAnimationFrame, with a timer so hidden pages (no rAF) still apply events. */
export function defaultRequestFrame(flush: () => void): () => void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    cancel();
    flush();
  };
  const raf = globalThis.requestAnimationFrame?.(run);
  const timer = setTimeout(run, FRAME_FALLBACK_MS);
  const cancel = () => {
    if (raf !== undefined) globalThis.cancelAnimationFrame(raf);
    clearTimeout(timer);
  };
  return () => {
    done = true;
    cancel();
  };
}

const isUnauthorized = (error: unknown) =>
  error instanceof ApiError && error.status === 401;
const isNotFound = (error: unknown) =>
  error instanceof ApiError && error.status === 404;

export function createRealtime(options: RealtimeOptions): Realtime {
  const { api } = options;
  const store = options.store ?? createWebStore();
  const bus = options.bus ?? createAppliedBus();
  const ticker = options.ticker ?? createTicker();
  const clock = options.clock ?? (() => Date.now());
  const isHidden =
    options.isHidden ??
    (() => globalThis.document?.visibilityState === 'hidden');
  const requestFrame = options.requestFrame ?? defaultRequestFrame;

  let running = false;
  // Bumped by start/stop/resync: async work from an older run must not land.
  let run = 0;
  let cursor = store.getState().connection.cursor;
  let buffers: EventBuffers = createEventBuffers();
  let queue: { event: DomainEvent; background: boolean }[] = [];
  let cancelFrame: (() => void) | null = null;
  let activeLoad = 0;
  const holds = new Set<string>();
  // When the current stream connection opened; events recorded before it are backlog.
  let openedAt = Infinity;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;

  const patch = (fn: (state: WebState) => Partial<WebState>) =>
    store.setState(fn);
  const setConnection = (next: Partial<WebState['connection']>) =>
    patch((state) => ({ connection: { ...state.connection, ...next } }));

  function hold(reason: string) {
    holds.add(reason);
    if (!store.getState().connection.catchingUp)
      setConnection({ catchingUp: true });
  }
  function release(reason: string) {
    holds.delete(reason);
    if (!holds.size && store.getState().connection.catchingUp)
      setConnection({ catchingUp: false });
  }

  function unauthorized() {
    stopActivity();
    patch((state) => ({
      auth: 'missing',
      connection: { ...state.connection, status: 'offline' },
    }));
  }
  function onApiError(error: unknown) {
    if (isUnauthorized(error)) unauthorized();
  }

  const createOverview = () =>
    createOverviewRefresher({ api, store, onError: onApiError });
  let overview = createOverview();
  const replay = createReplayController({
    api,
    store,
    bus,
    createWorker: options.createWorker,
    head: () => Math.max(cursor, store.getState().active.live?.lastSeq ?? 0),
  });

  const connection = createStreamConnection({
    open: options.openEventSource,
    cursor: () => cursor,
    probe: async (): Promise<ProbeResult> => {
      try {
        await api.getHealth();
        return 'ok';
      } catch (error) {
        return isUnauthorized(error) ? 'unauthorized' : 'unreachable';
      }
    },
    handlers: {
      onOpen() {
        openedAt = clock();
        patch((state) => ({
          auth: 'ok',
          connection: { ...state.connection, status: 'live' },
        }));
        // Whatever arrives right after an open is backlog until the stream settles.
        hold('stream');
        clearTimeout(maxTimer);
        maxTimer = setTimeout(endStreamCatchUp, CATCH_UP_MAX_MS);
        bumpQuiet();
      },
      onDomain: receive,
      onResync() {
        void bootstrap('resync');
      },
      onDown(status) {
        setConnection({ status });
      },
      onUnauthorized: unauthorized,
    },
  });

  function bumpQuiet() {
    clearTimeout(quietTimer);
    quietTimer = setTimeout(endStreamCatchUp, CATCH_UP_QUIET_MS);
  }
  function endStreamCatchUp() {
    clearTimeout(quietTimer);
    clearTimeout(maxTimer);
    release('stream');
  }

  function receive(event: DomainEvent) {
    if (event.seq <= cursor) return;
    cursor = event.seq;
    if (holds.has('stream')) bumpQuiet();
    buffers.push(event);
    overview.signal(event.type);
    replay.onLive(event);
    // Catch-up = recorded before this connection opened. A time window would also
    // silence genuinely live events that arrive right after an open.
    const background =
      Date.parse(event.recordedAt) < openedAt ||
      isHidden() ||
      clock() - Date.parse(event.occurredAt) > STALE_EVENT_MS;
    queue.push({ event, background });
    cancelFrame ??= requestFrame(flush);
  }

  /** One evolve pass and one setState per frame; one AppliedEvent per change. */
  function flush() {
    cancelFrame = null;
    const batch = queue;
    queue = [];
    const state = store.getState();
    const { workflowId, status } = state.active;
    const live = applyEvents(
      state.active.live,
      workflowId !== null && (status === 'ready' || status === 'missing')
        ? batch.filter(({ event }) => event.workflowId === workflowId)
        : [],
    );
    store.setState((current) => ({
      connection: { ...current.connection, cursor },
      ...(live.model === current.active.live
        ? {}
        : {
            active: {
              ...current.active,
              live: live.model,
              status: live.model ? 'ready' : current.active.status,
            },
          }),
    }));
    // In replay the displayed model is the replay's, so live changes do not animate.
    if (!store.getState().replay)
      for (const applied of live.applied) bus.emit(applied);
  }

  function applyEvents(
    model: ReadModel | null,
    batch: readonly { event: DomainEvent; background: boolean }[],
  ) {
    const applied: AppliedEvent[] = [];
    for (const { event, background } of batch) {
      const next = evolve(model, event);
      if (next === model) continue;
      applied.push({ event, prev: model, next, background });
      model = next;
    }
    return { model, applied };
  }

  /** Adopt a snapshot for the active workflow without ever moving it backwards. */
  function adopt(workflowId: string, snapshot: WorkflowSnapshotResponse) {
    const state = store.getState();
    if (state.active.workflowId !== workflowId) return;
    const current = state.active.live;
    let model =
      current && current.lastSeq > snapshot.readModel.lastSeq
        ? current
        : snapshot.readModel;
    const later = applyEvents(
      model,
      buffers.after(workflowId, model.lastSeq).map((event) => ({
        event,
        background: true,
      })),
    );
    model = later.model ?? model;
    patch(() => ({ active: { workflowId, live: model, status: 'ready' } }));
    if (!state.replay) for (const applied of later.applied) bus.emit(applied);
  }

  /** `/events` from the snapshot when the ring buffer no longer reaches back far enough. */
  async function fillGap(
    workflowId: string,
    snapshot: WorkflowSnapshotResponse,
    isCurrent: () => boolean,
  ): Promise<WorkflowSnapshotResponse | null> {
    let afterSeq = snapshot.asOfSeq;
    if (afterSeq >= buffers.completeAfter(workflowId)) return snapshot;
    let model: ReadModel = snapshot.readModel;
    hold('gap');
    try {
      for (;;) {
        const page = await api.listEvents(workflowId, { afterSeq });
        if (!isCurrent()) return null;
        for (const event of page.events) model = evolve(model, event);
        if (page.nextAfterSeq === undefined) break;
        afterSeq = page.nextAfterSeq;
      }
    } finally {
      release('gap');
    }
    return { readModel: model, asOfSeq: model.lastSeq };
  }

  async function loadActive(workflowId: string): Promise<number | null> {
    const token = ++activeLoad;
    const isCurrent = () =>
      token === activeLoad && store.getState().active.workflowId === workflowId;
    try {
      const snapshot = await api.getWorkflow(workflowId);
      if (!isCurrent()) return null;
      const filled = await fillGap(workflowId, snapshot, isCurrent);
      if (!filled) return null;
      adopt(workflowId, filled);
      return snapshot.asOfSeq;
    } catch (error) {
      if (!isCurrent()) return null;
      if (isNotFound(error))
        patch((state) => ({ active: { ...state.active, status: 'missing' } }));
      else onApiError(error);
      throw error;
    }
  }

  /** The newest workflow's snapshot seq, or 0: a lower bound ≤ the current head. */
  async function lowerBound(): Promise<number> {
    const { workflowId } = store.getState().active;
    if (workflowId) {
      const seq = await loadActive(workflowId).catch(() => null);
      if (seq !== null) return seq;
    }
    const { workflows } = await api.listWorkflows();
    const newest = workflows.reduce<(typeof workflows)[number] | undefined>(
      (best, candidate) =>
        !best || Date.parse(candidate.startedAt) > Date.parse(best.startedAt)
          ? candidate
          : best,
      undefined,
    );
    if (!newest) return 0;
    return (await api.getWorkflow(newest.workflowId)).asOfSeq;
  }

  async function bootstrap(reason: 'start' | 'resync') {
    const current = ++run;
    connection.close();
    if (reason === 'resync') hold('resync');
    endStreamCatchUp();
    setConnection({ status: reason === 'start' ? 'connecting' : 'resyncing' });
    let bound = cursor;
    try {
      bound = await lowerBound();
    } catch (error) {
      if (isUnauthorized(error)) {
        if (current === run) unauthorized();
        return;
      }
      // Any seq we already reached is still a valid lower bound.
    }
    if (current !== run) return;
    if (bound > cursor) {
      // Nothing at or below the new bound will arrive: buffers cannot fill that gap.
      buffers.raiseFloor(bound);
      cursor = bound;
    }
    connection.connect(cursor);
    try {
      await overview.refreshAll();
    } finally {
      if (current === run) release('resync');
    }
  }

  function stopActivity() {
    running = false;
    run++;
    activeLoad++;
    connection.close();
    endStreamCatchUp();
    cancelFrame?.();
    cancelFrame = null;
    queue = [];
  }

  return {
    store,
    bus,
    ticker,
    replay,
    async start() {
      if (running) return;
      running = true;
      buffers = createEventBuffers();
      overview.dispose();
      overview = createOverview();
      await bootstrap('start');
    },
    stop() {
      stopActivity();
      overview.dispose();
      replay.exit();
      holds.clear();
      setConnection({ status: 'offline', catchingUp: false });
    },
    async setActiveWorkflow(workflowId) {
      const state = store.getState();
      if (state.active.workflowId === workflowId) return;
      patch(() => ({
        active: {
          workflowId,
          live: null,
          status: workflowId ? 'loading' : 'idle',
        },
      }));
      if (!workflowId) {
        activeLoad++;
        return;
      }
      // Before start() the bootstrap loads it as the lower-bound snapshot.
      if (running) await loadActive(workflowId);
    },
  };
}
