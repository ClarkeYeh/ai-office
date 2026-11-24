/**
 * M5-T7 browser-like sessions whose cookie outlives a backend restart
 * (§2.3.3: the sqlite session stays valid), plus the harness SSE client that
 * resumes with `Last-Event-ID` and records every domain seq it receives.
 * Cookies stay in memory; nothing here is logged or reported.
 */
import { setTimeout as delay } from 'node:timers/promises';
import type { Api, Json } from '../orca/t17/office.js';

export interface CookieSession extends Api {
  readonly cookie: string;
}

/** Exchanges a bootstrap URL for a session cookie. */
export async function bootstrapCookie(bootstrapUrl: string): Promise<string> {
  const exchange = await fetch(bootstrapUrl, { redirect: 'manual' });
  if (exchange.status !== 302)
    throw new Error(`bootstrap failed: ${exchange.status}`);
  const cookie = exchange.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('bootstrap set no cookie');
  return cookie;
}

/** An API client on `url` with an existing cookie (same port after restart). */
export function cookieSession(url: string, cookie: string): CookieSession {
  let key = 0;
  return {
    cookie,
    async call(method, path, body) {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: {
          cookie,
          origin: url,
          ...(method === 'POST'
            ? {
                'content-type': 'application/json',
                'idempotency-key': `m5-joint-${++key}-${Date.now()}`,
              }
            : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      });
      const text = await response.text();
      let parsed: Json | null;
      try {
        parsed = (text ? JSON.parse(text) : null) as Json | null;
      } catch {
        parsed = null;
      }
      return { status: response.status, body: parsed as Json };
    },
  };
}

export interface SseFrame {
  event: string;
  id?: string;
  data: string;
}

/** Incremental `text/event-stream` parser (comments and keepalives skipped). */
export class SseParser {
  private buffer = '';
  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    let end: number;
    while ((end = this.buffer.indexOf('\n\n')) >= 0) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      let event = 'message';
      let id: string | undefined;
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'id') id = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length)
        frames.push({ event, ...(id ? { id } : {}), data: data.join('\n') });
    }
    return frames;
  }
}

/**
 * Follows `/api/v1/stream?workflowId=…` like the browser's EventSource:
 * on any disconnect it reconnects with the last domain id as `Last-Event-ID`.
 * `seqs` holds every domain frame id in arrival order (duplicates included).
 */
export class HarnessStream {
  readonly seqs: number[] = [];
  reconnects = 0;
  private lastId: string | undefined;
  private stopped = false;
  private controller: AbortController | undefined;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly options: {
      url: () => string;
      cookie: string;
      workflowId: string;
      onEvent: (event: Json) => void;
      retryMs?: number;
    },
  ) {}

  start(): void {
    this.loop ??= this.run();
  }

  private async run(): Promise<void> {
    let first = true;
    while (!this.stopped) {
      if (!first) {
        this.reconnects++;
        await delay(this.options.retryMs ?? 1_000);
        if (this.stopped) return;
      }
      first = false;
      this.controller = new AbortController();
      try {
        const response = await fetch(
          `${this.options.url()}/api/v1/stream?workflowId=${encodeURIComponent(this.options.workflowId)}`,
          {
            headers: {
              cookie: this.options.cookie,
              accept: 'text/event-stream',
              ...(this.lastId ? { 'last-event-id': this.lastId } : {}),
            },
            signal: this.controller.signal,
          },
        );
        if (!response.ok || !response.body) continue;
        const parser = new SseParser();
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          for (const frame of parser.push(
            decoder.decode(chunk as Uint8Array, { stream: true }),
          )) {
            if (frame.event !== 'domain' || frame.id === undefined) continue;
            this.lastId = frame.id;
            this.seqs.push(Number(frame.id));
            try {
              this.options.onEvent(JSON.parse(frame.data) as Json);
            } catch {
              /* A malformed frame is counted (seq) but not dispatched. */
            }
          }
        }
      } catch {
        /* Connection refused while the backend is down: retry. */
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.controller?.abort();
    await this.loop?.catch(() => undefined);
  }
}
