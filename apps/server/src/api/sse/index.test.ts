import Fastify from 'fastify';
import type { ServerResponse } from 'node:http';
import { get } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamService } from '../../application/stream/index.js';
import { InMemoryEventStore } from '../../test-support/stores.js';
import { eventDraft } from '../../test-support/contracts.js';
import { createRedactor } from '../../adapters/redactor/index.js';
import { registerStream } from './index.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.reverse()) await dispose();
  cleanup.length = 0;
  vi.restoreAllMocks();
});

async function server(
  events = new InMemoryEventStore(),
  onResponse?: (raw: ServerResponse) => void,
) {
  const app = Fastify();
  const stream = new StreamService(events);
  const opened = vi.spyOn(stream, 'open');
  app.addHook('onRequest', async (_request, reply) => {
    onResponse?.(reply.raw);
  });
  registerStream(
    app,
    { stream },
    {
      preHandler: async (request, reply) => {
        if (request.headers.cookie !== 'session=test')
          await reply.code(401).send({ error: 'unauthorized' });
      },
    },
  );
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  cleanup.push(() => app.close());
  return { app, url, events, opened };
}

// Parse the SSE wire format, including comment frames and arbitrary chunk boundaries.
async function connect(url: string, path = '', lastId?: string) {
  const abort = new AbortController();
  const response = await fetch(`${url}/api/v1/stream${path}`, {
    headers: {
      cookie: 'session=test',
      ...(lastId === undefined ? {} : { 'Last-Event-ID': lastId }),
    },
    signal: abort.signal,
  });
  const reader = response.body!.getReader();
  cleanup.push(async () => {
    abort.abort();
    await reader.cancel().catch(() => {});
  });
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    response,
    abort: () => abort.abort(),
    async next(): Promise<string | undefined> {
      while (!buffer.includes('\n\n')) {
        const chunk = await reader.read();
        if (chunk.done) return undefined;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      const end = buffer.indexOf('\n\n');
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      return frame;
    },
  };
}

const id = (frame: string | undefined) => frame?.match(/^id: (\d+)$/m)?.[1];

describe('SSE HTTP transport', () => {
  it('reconnects from Last-Event-ID in preference to afterSeq without gaps or duplicates', async () => {
    const { url, events } = await server();
    events.append([eventDraft(), eventDraft()]);
    const first = await connect(url, '?afterSeq=0');
    expect(first.response.headers.get('content-type')).toContain(
      'text/event-stream',
    );
    expect(id(await first.next())).toBe('1');
    expect(id(await first.next())).toBe('2');
    first.abort();
    events.append([eventDraft(), eventDraft()]);
    const second = await connect(url, '?afterSeq=0', '2');
    expect(id(await second.next())).toBe('3');
    expect(id(await second.next())).toBe('4');
    events.append([eventDraft()]);
    expect(id(await second.next())).toBe('5');
  });

  it('subscribes before reading history and deduplicates commits racing with replay', async () => {
    const { url, events } = await server();
    events.append([eventDraft()]);
    const read = events.read.bind(events);
    vi.spyOn(events, 'read').mockImplementationOnce((query) => {
      const history = read(query);
      events.append([eventDraft(), eventDraft()]);
      return [...history, ...read({ afterSeq: 1, limit: 1 })];
    });
    const client = await connect(url);
    expect([
      id(await client.next()),
      id(await client.next()),
      id(await client.next()),
    ]).toEqual(['1', '2', '3']);
    events.append([eventDraft()]);
    expect(id(await client.next())).toBe('4');
  });

  it('sends all already-redacted workflow and system events globally and filters when requested', async () => {
    const { url, events } = await server();
    const secret = 'test.person@example.com';
    const redactor = createRedactor({ defaultBranch: 'main' });
    const drafts = ['a', 'b', null].map((workflow) =>
      redactor.maskSecrets({
        ...eventDraft(undefined, workflow),
        type: 'error.recorded' as const,
        payload: {
          category: 'auth' as const,
          code: 'test_error',
          message: secret,
        },
      }),
    );
    const committed = events.append(drafts);
    const client = await connect(url);
    for (const event of committed) {
      const frame = await client.next();
      expect(frame).not.toContain(secret);
      expect(frame).toBe(
        `event: domain\nid: ${event.seq}\ndata: ${JSON.stringify(event)}`,
      );
    }
    const filtered = await connect(url, '?workflowId=b');
    expect(id(await filtered.next())).toBe('2');
    events.append([eventDraft(undefined, 'a'), eventDraft(undefined, 'b')]);
    expect(id(await filtered.next())).toBe('5');
  });

  it('returns resync_required and EOF when replay exceeds 1000 events', async () => {
    const { url, events } = await server();
    events.append(Array.from({ length: 1001 }, () => eventDraft()));
    const client = await connect(url);
    expect(await client.next()).toBe(
      'event: resync_required\ndata: {"reason":"slow_client"}',
    );
    expect(await client.next()).toBeUndefined();
  });

  it('stops pulling under transport backpressure, then sends resync and closes', async () => {
    let raw: ServerResponse | undefined;
    const { url, events, opened } = await server(undefined, (response) => {
      raw = response;
    });
    const client = await connect(url);
    const write = raw!.write.bind(raw!);
    vi.spyOn(raw!, 'write').mockImplementationOnce(
      (...args: Parameters<ServerResponse['write']>) => {
        write(...args);
        return false;
      },
    );
    const next = vi.spyOn(opened.mock.results[0]!.value, 'next');
    events.append([eventDraft()]);
    expect(id(await client.next())).toBe('1');
    events.append(Array.from({ length: 1001 }, () => eventDraft()));
    expect(next).not.toHaveBeenCalled();
    raw!.emit('drain');
    expect(await client.next()).toContain('event: resync_required');
    expect(await client.next()).toBeUndefined();
  });

  it('emits the 15-second keepalive as a comment', async () => {
    const { url } = await server();
    const client = await connect(url);
    expect(await client.next()).toBe(':keepalive');
  }, 20_000);

  it('resyncs a real paused socket after its pending event queue overflows', async () => {
    let raw: ServerResponse | undefined;
    const { url, events } = await server(undefined, (response) => {
      raw = response;
    });
    const request = get(`${url}/api/v1/stream`, {
      headers: { cookie: 'session=test' },
    });
    cleanup.push(async () => {
      request.destroy();
    });
    const [response] = await once(request, 'response');
    response.pause();
    events.append([
      {
        ...eventDraft(),
        type: 'error.recorded',
        payload: {
          category: 'bug',
          code: 'large_event',
          message: '<redacted>'.repeat(1_600_000),
        },
      },
    ]);
    await vi.waitFor(() => expect(raw!.writableNeedDrain).toBe(true));
    events.append(Array.from({ length: 1001 }, () => eventDraft()));
    let tail = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      tail = (tail + chunk).slice(-200);
    });
    const ended = once(response, 'end');
    response.resume();
    await ended;
    expect(tail).toContain(
      'event: resync_required\ndata: {"reason":"slow_client"}\n\n',
    );
  });

  it('closes the subscription on client disconnect and server shutdown', async () => {
    const { app, url, opened } = await server();
    const first = await connect(url);
    const close = vi.spyOn(opened.mock.results[0]!.value, 'return');
    first.abort();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    const second = await connect(url);
    const secondClose = vi.spyOn(opened.mock.results[1]!.value, 'return');
    await app.close();
    expect(await second.next()).toBeUndefined();
    expect(secondClose).toHaveBeenCalledTimes(1);
  });

  it('rejects unauthenticated and malformed requests before opening a subscription', async () => {
    const { app, opened } = await server();
    expect((await app.inject('/api/v1/stream')).statusCode).toBe(401);
    for (const query of [
      '?afterSeq=-1',
      '?afterSeq=1.5',
      '?afterSeq=',
      '?afterSeq=9007199254740992',
      '?afterSeq=1&afterSeq=2',
      '?workflowId=a&workflowId=b',
    ]) {
      expect(
        (
          await app.inject({
            url: `/api/v1/stream${query}`,
            headers: { cookie: 'session=test' },
          })
        ).statusCode,
      ).toBe(400);
    }
    for (const cursor of ['-1', '1.2', 'x', '9007199254740992']) {
      expect(
        (
          await app.inject({
            url: '/api/v1/stream',
            headers: { cookie: 'session=test', 'last-event-id': cursor },
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(opened).not.toHaveBeenCalled();
  });
});
