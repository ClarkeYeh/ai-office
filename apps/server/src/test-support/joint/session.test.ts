import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { HarnessStream, SseParser, cookieSession } from './session.js';

describe('SseParser', () => {
  it('splits frames across chunks and skips comments', () => {
    const p = new SseParser();
    expect(p.push(':keepalive\n\nevent: domain\nid: 3\nda')).toEqual([]);
    expect(p.push('ta: {"seq":3}\n\nevent: hint\ndata: x\n\n')).toEqual([
      { event: 'domain', id: '3', data: '{"seq":3}' },
      { event: 'hint', data: 'x' },
    ]);
  });
});

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((done) =>
    server ? server.close(() => done()) : done(),
  );
  server = undefined;
});

const listen = async (handler: Parameters<typeof createServer>[1]) => {
  server = createServer(handler);
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
};

describe('HarnessStream', () => {
  it('resumes with Last-Event-ID after a disconnect (no gap, no duplicate)', async () => {
    const lastIds: (string | undefined)[] = [];
    const frame = (res: ServerResponse, seq: number) =>
      res.write(
        `event: domain\nid: ${seq}\ndata: ${JSON.stringify({ seq, type: 'x' })}\n\n`,
      );
    const url = await listen((req, res) => {
      lastIds.push(req.headers['last-event-id'] as string | undefined);
      expect(req.headers.cookie).toBe('session=abc');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const from = Number(req.headers['last-event-id'] ?? 0);
      if (from === 0) {
        frame(res, 1);
        frame(res, 2);
        res.end(); // the backend went away
      } else {
        frame(res, from + 1);
        res.end();
      }
    });
    const seen: number[] = [];
    const stream = new HarnessStream({
      url: () => url,
      cookie: 'session=abc',
      workflowId: 'wf',
      onEvent: (e) => seen.push(e.seq as number),
      retryMs: 5,
    });
    stream.start();
    for (let i = 0; i < 200 && seen.length < 3; i++)
      await new Promise((r) => setTimeout(r, 10));
    await stream.stop();
    expect(seen.slice(0, 3)).toEqual([1, 2, 3]);
    expect(lastIds.slice(0, 2)).toEqual([undefined, '2']);
    expect(stream.reconnects).toBeGreaterThanOrEqual(1);
  });

  it('cookieSession sends the cookie, origin and an idempotency key', async () => {
    const url = await listen((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          cookie: req.headers.cookie,
          origin: req.headers.origin,
          key: Boolean(req.headers['idempotency-key']),
        }),
      );
    });
    const api = cookieSession(url, 'session=s');
    expect((await api.call('POST', '/x', {})).body).toEqual({
      cookie: 'session=s',
      origin: url,
      key: true,
    });
  });
});
