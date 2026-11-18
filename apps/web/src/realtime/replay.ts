import type { DomainEvent } from '@ai-office/contracts/events';
import { evolve } from '@ai-office/projection';
import type { ApiClient } from '../api/index.js';
import type { AppliedBus } from './bus.js';
import type { ReplayRequest, ReplayResponse } from './replay-engine.js';
import type { WebStore } from './store.js';

export const REPLAY_PAGE_SIZE = 500;

export interface WorkerLike {
  onmessage: ((message: MessageEvent<ReplayResponse>) => void) | null;
  postMessage(message: ReplayRequest): void;
  terminate(): void;
}

export interface ReplayController {
  /** Page in the workflow's events (progress in `replay.progress`), ending at the head. */
  open(workflowId: string): Promise<void>;
  /** Timeline drag: state only, no AppliedEvent; stale worker answers are dropped. */
  seek(seq: number): void;
  /** Apply the next event on the main thread and emit it (non-background). */
  step(): boolean;
  /** Back to live. */
  exit(): void;
  /** Live stream events: appended to an open replay of the same workflow. */
  onLive(event: DomainEvent): void;
}

export function createReplayController(options: {
  api: Pick<ApiClient, 'listEvents'>;
  store: WebStore;
  bus: AppliedBus;
  createWorker: () => WorkerLike;
  /** Expected head seq for progress. */
  head: () => number;
  pageSize?: number;
}): ReplayController {
  const { store } = options;
  const pageSize = options.pageSize ?? REPLAY_PAGE_SIZE;
  let worker: WorkerLike | null = null;
  let session = 0;
  let events: DomainEvent[] = [];
  let early: DomainEvent[] = [];
  let loading = false;
  let seekId = 0;
  let answered = 0;

  const lastSeq = () => (events.length ? events[events.length - 1]!.seq : 0);

  function setReplay(
    patch: Partial<NonNullable<ReturnType<WebStore['getState']>['replay']>>,
  ) {
    store.setState((state) =>
      state.replay ? { replay: { ...state.replay, ...patch } } : {},
    );
  }

  function append(batch: DomainEvent[]) {
    const fresh = batch.filter((event) => event.seq > lastSeq());
    if (!fresh.length) return;
    events.push(...fresh);
    // One page per message keeps each structured clone on the main thread small.
    worker!.postMessage({ type: 'append', events: fresh });
  }

  function exit() {
    session++;
    worker?.terminate();
    worker = null;
    events = [];
    early = [];
    loading = false;
    store.setState({ replay: null });
  }

  function seek(seq: number) {
    if (!worker || loading) return;
    const id = ++seekId;
    setReplay({ seq });
    worker.postMessage({ type: 'seek', id, seq });
  }

  return {
    async open(workflowId) {
      exit();
      const current = session;
      const created = options.createWorker();
      worker = created;
      loading = true;
      created.onmessage = ({ data }) => {
        if (current !== session || data.type !== 'result') return;
        if (data.id !== seekId) return;
        answered = data.id;
        setReplay({ seq: data.seq, model: data.model });
      };
      store.setState({
        replay: {
          workflowId,
          eventCount: 0,
          seq: 0,
          model: null,
          loading: true,
          progress: 0,
        },
      });
      const head = Math.max(1, options.head());
      let afterSeq = 0;
      try {
        for (;;) {
          const page = await options.api.listEvents(workflowId, {
            afterSeq,
            limit: pageSize,
          });
          if (current !== session) return;
          append(page.events);
          setReplay({
            eventCount: events.length,
            progress: Math.min(1, lastSeq() / head),
          });
          if (page.nextAfterSeq === undefined) break;
          afterSeq = page.nextAfterSeq;
        }
      } catch (error) {
        if (current === session) exit();
        throw error;
      }
      append(early);
      early = [];
      loading = false;
      setReplay({ loading: false, progress: 1, eventCount: events.length });
      seek(lastSeq());
    },
    seek,
    step() {
      const replay = store.getState().replay;
      if (!replay || loading || answered !== seekId) return false;
      const event = events.find((candidate) => candidate.seq > replay.seq);
      if (!event) return false;
      const prev = replay.model;
      const next = evolve(prev, event);
      // Invalidate nothing in flight (answered === seekId) but keep ids monotonic.
      answered = ++seekId;
      setReplay({ seq: event.seq, model: next });
      options.bus.emit({ event, prev, next, background: false });
      return true;
    },
    exit,
    onLive(event) {
      const replay = store.getState().replay;
      if (!replay || event.workflowId !== replay.workflowId) return;
      if (loading) {
        early.push(event);
        return;
      }
      append([event]);
      setReplay({ eventCount: events.length });
    },
  };
}
