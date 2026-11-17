import type { DomainEvent } from '@ai-office/contracts/events';
import type { EventStore } from '../../ports/stores.js';

export type StreamFrame =
  | { event: 'domain'; id: string; data: DomainEvent }
  | { event: 'resync_required'; data: { reason: string } };
export type StreamOptions = { workflowId?: string; afterSeq?: number };

/** Pull one frame only when the transport can send it. Call return() on disconnect.
 * SSE framing, Last-Event-ID parsing and keepalive comments belong to the API layer.
 */
export class StreamConnection implements AsyncIterableIterator<StreamFrame> {
  private queue: StreamFrame[] = [];
  private unsubscribe: () => void = () => {};
  private waiting: ((result: IteratorResult<StreamFrame>) => void) | undefined;
  private stopped = false;
  private lastSeq: number;

  constructor(events: EventStore, options: StreamOptions) {
    this.lastSeq = options.afterSeq ?? 0;
    if (!Number.isSafeInteger(this.lastSeq) || this.lastSeq < 0)
      throw new RangeError('Invalid stream cursor');
    let buffering = true;
    const buffered = new Map<number, DomainEvent>();
    const matches = (event: DomainEvent) =>
      event.seq > this.lastSeq &&
      (options.workflowId === undefined ||
        event.workflowId === options.workflowId);
    const unsubscribe = events.subscribe((event) => {
      if (this.stopped || !matches(event)) return;
      if (buffering) {
        buffered.set(event.seq, event);
        if (buffered.size > 1000) this.overflow();
      } else this.enqueue(event);
    });
    this.unsubscribe = unsubscribe;
    if (this.stopped) unsubscribe();
    try {
      // At most 1001 historical events are needed to detect an oversized backlog.
      const history = events.read({
        ...options,
        afterSeq: this.lastSeq,
        limit: 1001,
      });
      for (const event of history)
        if (matches(event)) buffered.set(event.seq, event);
      if (!this.stopped) {
        if (buffered.size > 1000) this.overflow();
        else
          for (const event of [...buffered.values()].sort(
            (a, b) => a.seq - b.seq,
          ))
            this.enqueue(event);
      }
      buffering = false;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private enqueue(event: DomainEvent): void {
    if (this.stopped || event.seq <= this.lastSeq) return;
    this.lastSeq = event.seq;
    const frame: StreamFrame = {
      event: 'domain',
      id: String(event.seq),
      data: structuredClone(event),
    };
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ done: false, value: frame });
    } else {
      this.queue.push(frame);
      if (this.queue.length > 1000) this.overflow();
    }
  }

  private overflow(): void {
    this.stopped = true;
    this.unsubscribe();
    this.queue = [
      { event: 'resync_required', data: { reason: 'slow_client' } },
    ];
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<StreamFrame> {
    return this;
  }
  next(): Promise<IteratorResult<StreamFrame>> {
    const frame = this.queue.shift();
    if (frame) return Promise.resolve({ done: false, value: frame });
    if (this.stopped) return Promise.resolve({ done: true, value: undefined });
    if (this.waiting)
      return Promise.reject(
        new Error('Only one pending stream read is allowed'),
      );
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
  close(): void {
    this.stopped = true;
    this.unsubscribe();
    this.queue = [];
    this.waiting?.({ done: true, value: undefined });
    this.waiting = undefined;
  }
  return(): Promise<IteratorResult<StreamFrame>> {
    this.close();
    return Promise.resolve({ done: true, value: undefined });
  }
}

/** EventStore contains only already-redacted, committed events. Global streams include all of them. */
export class StreamService {
  constructor(private readonly events: EventStore) {}
  open(options: StreamOptions = {}): StreamConnection {
    return new StreamConnection(this.events, options);
  }
}
