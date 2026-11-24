import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { registerLocal } from './index.js';
import { registerApi } from '../index.js';
import { setup } from '../test-support/setup.js';
import { FakeClock } from '../../test-support/services.js';
import { InMemorySessionStore } from '../../test-support/stores.js';
import { acquireInstanceLock } from '../../config/instance-lock.js';

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function local() {
  const home = mkdtempSync(join(tmpdir(), 'aio-local-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const lock = acquireInstanceLock(home);
  cleanup.push(() => lock.release());
  const verifyControlToken = lock.rotateControlToken();
  const token = readFileSync(`${home}/data/control.token`, 'utf8');
  const app = Fastify();
  cleanup.push(() => app.close());
  const clock = new FakeClock();
  const sessions = new InMemorySessionStore(clock);
  const issued = vi.fn();
  await registerLocal(app, {
    port: 4321,
    sessions,
    now: () => clock.now(),
    verifyControlToken,
    issued,
  });
  const request = (
    headers: Record<string, string> = { authorization: `Bearer ${token}` },
  ) =>
    app.inject({
      method: 'POST',
      url: '/local/v1/bootstrap-codes',
      headers: { host: '127.0.0.1:4321', ...headers },
    });
  return { app, clock, sessions, issued, token, request, lock, home };
}

test('requires Bearer, rejects any Origin and wrong Host, never emits CORS, and never accepts cookies', async () => {
  const h = await local();
  for (const [headers, status] of [
    [{}, 401],
    [{ authorization: 'Bearer aio_ctl_' + '0'.repeat(64) }, 401],
    [{ cookie: 'aio_session=example' }, 401],
    [
      { authorization: `Bearer ${h.token}`, origin: 'http://127.0.0.1:4321' },
      403,
    ],
    [{ authorization: `Bearer ${h.token}`, origin: '' }, 403],
    [{ authorization: `Bearer ${h.token}`, host: 'evil.example:4321' }, 403],
  ] as const) {
    const response = await h.request(headers);
    expect(response.statusCode).toBe(status);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(
      Object.keys(response.headers).some((key) =>
        key.startsWith('access-control-'),
      ),
    ).toBe(false);
  }
  expect(h.issued).not.toHaveBeenCalled();
});

test('issues one-time 60-second codes, logs only issued, and limits issuance to five per minute', async () => {
  const h = await local();
  const first = await h.request();
  expect(first.statusCode).toBe(200);
  const result = first.json<{ code: string; expiresAt: string }>();
  expect(Date.parse(result.expiresAt) - h.clock.now().getTime()).toBe(60_000);
  expect(h.sessions.exchangeBootstrapCode(result.code)).not.toBeNull();
  expect(h.sessions.exchangeBootstrapCode(result.code)).toBeNull();
  const second = (await h.request()).json<{ code: string }>();
  for (let i = 0; i < 3; i++) expect((await h.request()).statusCode).toBe(200);
  const limited = await h.request();
  expect(limited.statusCode).toBe(429);
  expect(limited.headers['cache-control']).toBe('no-store');
  expect(h.issued.mock.calls).toEqual([[], [], [], [], []]);
  h.clock.advance(60_000);
  expect(h.sessions.exchangeBootstrapCode(second.code)).toBeNull();
  expect((await h.request()).statusCode).toBe(200);
});

test('stale token after lock takeover gets 401 while the replacement works', async () => {
  const h = await local();
  const verify = h.lock.rotateControlToken();
  const next = Fastify();
  cleanup.push(() => next.close());
  await registerLocal(next, {
    port: 4321,
    sessions: h.sessions,
    now: () => h.clock.now(),
    verifyControlToken: verify,
    issued: () => {},
  });
  const call = (token: string) =>
    next.inject({
      method: 'POST',
      url: '/local/v1/bootstrap-codes',
      headers: { host: '127.0.0.1:4321', authorization: `Bearer ${token}` },
    });
  expect((await call(h.token)).statusCode).toBe(401);
  expect(
    (await call(readFileSync(`${h.home}/data/control.token`, 'utf8')))
      .statusCode,
  ).toBe(200);
});

test('local route precedes static/fallback and remains outside API cookie authentication', async () => {
  const h = await local();
  const api = await setup();
  cleanup.push(() => api.app.close());
  await registerApi(h.app, { ...api.deps, port: 4321 });
  writeFileSync(`${h.home}/index.html`, '<html>SPA fallback</html>');
  await h.app.register(fastifyStatic, { root: h.home, wildcard: false });
  h.app.setNotFoundHandler((_request, reply) =>
    reply.type('text/html').send('SPA fallback'),
  );
  expect((await h.request()).statusCode).toBe(200);
  const apiDenied = await h.app.inject({
    method: 'GET',
    url: '/api/v1/health',
    headers: { host: '127.0.0.1:4321' },
  });
  expect(apiDenied.statusCode).toBe(401);
  expect((await h.app.inject({ url: '/client-route' })).body).toBe(
    'SPA fallback',
  );
});

test('assembled server recovers a stale token on restart and keeps the endpoint ahead of the SPA', async () => {
  const { startServer } = await import('../../main.js');
  const home = mkdtempSync(join(tmpdir(), 'aio-open-restart-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(`${home}/index.html`, '<html>SPA fallback</html>');
  const boot = () =>
    startServer({
      dev: true,
      fake: 'mainline',
      port: 0,
      env: { AI_OFFICE_HOME: home },
      webDist: home,
      print: () => {},
    });
  const first = await boot();
  cleanup.push(() => first.close());
  const token = readFileSync(`${home}/data/control.token`, 'utf8');
  const exchange = await fetch(first.bootstrapUrl, { redirect: 'manual' });
  const cookie = exchange.headers.get('set-cookie')!.split(';')[0]!;
  await first.close();
  expect(readFileSync(`${home}/index.html`, 'utf8')).toContain('SPA');
  // Recreate the files a SIGKILL would have left, without killing a shared process.
  writeFileSync(`${home}/data/control.token`, token);
  writeFileSync(
    `${home}/data/.lock`,
    JSON.stringify({ pid: process.pid, startedAt: '2026-01-01T00:00:00Z' }),
  );
  const next = await boot();
  cleanup.push(() => next.close());
  const call = (value: string) =>
    fetch(`${next.url}/local/v1/bootstrap-codes`, {
      method: 'POST',
      headers: { authorization: `Bearer ${value}` },
    });
  expect((await call(token)).status).toBe(401);
  const fresh = await call(readFileSync(`${home}/data/control.token`, 'utf8'));
  expect(fresh.status).toBe(200);
  expect(fresh.headers.get('cache-control')).toBe('no-store');
  const { code } = (await fresh.json()) as { code: string };
  expect(
    (
      await fetch(
        `${next.url}/auth/bootstrap?code=${encodeURIComponent(code)}`,
        { redirect: 'manual' },
      )
    ).status,
  ).toBe(302);
  expect(
    (
      await fetch(
        `${next.url}/auth/bootstrap?code=${encodeURIComponent(code)}`,
        { redirect: 'manual' },
      )
    ).status,
  ).toBe(401);
  expect(
    (await fetch(`${next.url}/api/v1/health`, { headers: { cookie } })).status,
  ).toBe(200);
});
