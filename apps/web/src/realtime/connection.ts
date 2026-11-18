import type { DomainEvent } from '@ai-office/contracts/events';
import { streamUrl } from '../api/index.js';

/** The subset of the browser EventSource that realtime uses (tests pass a fake). */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
}
export type EventSourceFactory = (url: string) => EventSourceLike;

export const EVENT_SOURCE_CLOSED = 2;

export type ProbeResult = 'ok' | 'unauthorized' | 'unreachable';

export interface ConnectionHandlers {
  onOpen(): void;
  onDomain(event: DomainEvent): void;
  onResync(): void;
  /** `reconnecting`: waiting for a retry; `offline`: the server did not answer. */
  onDown(status: 'reconnecting' | 'offline'): void;
  onUnauthorized(): void;
}

export interface ConnectionOptions {
  open: EventSourceFactory;
  /** `GET /api/v1/health` before each manual reopen (§3.4). */
  probe: () => Promise<ProbeResult>;
  /** Resume point for manual reopens. */
  cursor: () => number;
  handlers: ConnectionHandlers;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface StreamConnection {
  connect(afterSeq: number): void;
  close(): void;
}

/**
 * One global EventSource. The browser's own reconnect (readyState CONNECTING) resends
 * Last-Event-ID; once it gives up (CLOSED) we reopen at `cursor` with exponential
 * backoff (1 → 30 s), probing health first so a lost session stops reconnecting.
 */
export function createStreamConnection(
  options: ConnectionOptions,
): StreamConnection {
  const initial = options.initialBackoffMs ?? 1_000;
  const max = options.maxBackoffMs ?? 30_000;
  const { handlers } = options;
  let source: EventSourceLike | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  // Bumped on every connect/close so late callbacks from an old source are ignored.
  let generation = 0;

  function detach() {
    clearTimeout(retry);
    retry = undefined;
    if (source) {
      source.onopen = null;
      source.onerror = null;
      source.close();
      source = null;
    }
  }

  function connect(afterSeq: number) {
    detach();
    const current = ++generation;
    const es = options.open(streamUrl({ afterSeq }));
    source = es;
    es.onopen = () => {
      if (current !== generation) return;
      failures = 0;
      handlers.onOpen();
    };
    es.onerror = () => {
      if (current !== generation) return;
      if (es.readyState !== EVENT_SOURCE_CLOSED) {
        handlers.onDown('reconnecting');
        return;
      }
      detach();
      handlers.onDown('reconnecting');
      scheduleRetry(current);
    };
    es.addEventListener('domain', (message) => {
      if (current !== generation) return;
      let event: DomainEvent;
      try {
        event = JSON.parse(String(message.data)) as DomainEvent;
      } catch {
        return;
      }
      if (typeof event?.seq === 'number') handlers.onDomain(event);
    });
    es.addEventListener('resync_required', () => {
      if (current !== generation) return;
      // Close first: the native reconnect would otherwise resume the dropped stream.
      generation++;
      detach();
      handlers.onResync();
    });
  }

  function scheduleRetry(current: number) {
    const delay = Math.min(max, initial * 2 ** failures);
    failures++;
    retry = setTimeout(() => {
      void options.probe().then(
        (result) => {
          if (current !== generation) return;
          if (result === 'unauthorized') {
            handlers.onUnauthorized();
          } else if (result === 'unreachable') {
            handlers.onDown('offline');
            scheduleRetry(current);
          } else {
            connect(options.cursor());
          }
        },
        () => {
          if (current !== generation) return;
          handlers.onDown('offline');
          scheduleRetry(current);
        },
      );
    }, delay);
  }

  return {
    connect,
    close() {
      generation++;
      detach();
    },
  };
}
