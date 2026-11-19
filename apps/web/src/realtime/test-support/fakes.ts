import type { HealthView } from '@ai-office/contracts/api';
import type { DomainEvent } from '@ai-office/contracts/events';
import { replay, summarizeWorkflow } from '@ai-office/projection';
import { vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { EventSourceLike } from '../connection.js';
import type { RealtimeApi } from '../realtime.js';
import {
  attachReplayEngine,
  type ReplayRequest,
  type ReplayResponse,
  type WorkerScope,
} from '../replay-engine.js';
import type { WorkerLike } from '../replay.js';

export class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  static latest(): FakeEventSource {
    return FakeEventSource.instances.at(-1)!;
  }
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  get afterSeq(): number {
    return Number(new URL(this.url, 'http://x').searchParams.get('afterSeq'));
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  message(type: string, data: string) {
    for (const listener of this.listeners.get(type) ?? [])
      listener(new MessageEvent(type, { data }));
  }
  domain(...events: DomainEvent[]) {
    for (const event of events) this.message('domain', JSON.stringify(event));
  }
  resync() {
    this.message('resync_required', '{}');
  }
  /** `closed`: the browser gave up (non-200, network refused). */
  fail(closed: boolean) {
    this.readyState = closed ? 2 : 0;
    this.onerror?.(new Event('error'));
  }
}

export const apiError = (status: number) =>
  new ApiError(status, {
    code: status === 401 ? 'unauthorized' : 'not_found',
    category: status === 401 ? 'auth' : 'permanent',
    retryable: false,
    message: `HTTP ${status}`,
  });

export const health = { checkedAt: 'x' } as unknown as HealthView;

/** An in-memory server over one global event log, with the real paging contract. */
export function createFakeServer(log: DomainEvent[] = []) {
  const ofWorkflow = (id: string) => log.filter((e) => e.workflowId === id);
  const snapshot = (id: string) => {
    const model = replay(ofWorkflow(id));
    if (!model) throw apiError(404);
    return { readModel: model, asOfSeq: model.lastSeq };
  };
  const api = {
    getHealth: vi.fn(async () => health),
    listRepos: vi.fn(async () => ({ repos: [] })),
    listGates: vi.fn(async () => ({ gates: [] })),
    listQuestions: vi.fn(async () => ({ questions: [] })),
    listWorkflows: vi.fn(async () => ({
      workflows: [...new Set(log.map((e) => e.workflowId))]
        .filter((id): id is string => id !== null)
        .map((id) => summarizeWorkflow(snapshot(id).readModel)),
    })),
    getWorkflow: vi.fn(async (id: string) => snapshot(id)),
    listEvents: vi.fn(
      async (id: string, query: { afterSeq?: number; limit?: number } = {}) => {
        const limit = query.limit ?? 200;
        const page = ofWorkflow(id).filter(
          (e) => e.seq > (query.afterSeq ?? 0),
        );
        const events = page.slice(0, limit);
        return page.length > limit
          ? { events, nextAfterSeq: events.at(-1)!.seq }
          : { events };
      },
    ),
  };
  return { log, api: api as typeof api & RealtimeApi };
}

/** Runs the real worker engine in-process, answering on a later macrotask. */
export class FakeWorker implements WorkerLike {
  static instances: FakeWorker[] = [];
  onmessage: ((message: MessageEvent<ReplayResponse>) => void) | null = null;
  terminated = false;
  readonly posted: ReplayRequest[] = [];
  private readonly scope: WorkerScope = {
    onmessage: null,
    postMessage: (message) => {
      setTimeout(() => {
        if (!this.terminated)
          this.onmessage?.(new MessageEvent('message', { data: message }));
      }, 0);
    },
  };
  constructor() {
    FakeWorker.instances.push(this);
    attachReplayEngine(this.scope);
  }
  postMessage(message: ReplayRequest) {
    this.posted.push(message);
    const data = structuredClone(message);
    setTimeout(() => {
      if (!this.terminated)
        this.scope.onmessage?.(new MessageEvent('message', { data }));
    }, 0);
  }
  terminate() {
    this.terminated = true;
  }
}

export function resetFakes() {
  FakeEventSource.instances = [];
  FakeWorker.instances = [];
}
