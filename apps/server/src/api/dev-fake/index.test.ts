import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerDevFakeRoutes } from './index.js';

describe('dev fake controls', () => {
  it('requires the same host, origin and session as REST and validates the PR number', async () => {
    const app = Fastify();
    const mergeOwner = vi.fn(async () => ({ mergeCommitSha: 'abc' }));
    await registerDevFakeRoutes(
      app,
      {
        port: 1234,
        sessions: {
          verify: (token) => token === 'valid',
          exchangeBootstrapCode: () => null,
        },
      },
      { mergeOwner },
    );
    const headers = {
      host: 'localhost:1234',
      origin: 'http://localhost:1234',
      cookie: 'aio_session=valid',
    };
    const request = (
      override = {},
      payload: Record<string, unknown> = { number: 7 },
    ) =>
      app.inject({
        method: 'POST',
        url: '/dev/fake/scm/merge-final-pr',
        headers: { ...headers, ...override },
        payload,
      });
    try {
      expect((await request({ cookie: '' })).statusCode).toBe(401);
      expect(
        (await request({ origin: 'http://evil.invalid' })).statusCode,
      ).toBe(403);
      expect((await request({ host: 'evil.invalid' })).statusCode).toBe(403);
      expect((await request({}, { number: -1 })).statusCode).toBe(400);
      expect(mergeOwner).not.toHaveBeenCalled();
      expect((await request()).json()).toEqual({ mergeCommitSha: 'abc' });
      expect(mergeOwner).toHaveBeenCalledWith(7);
    } finally {
      await app.close();
    }
  });
  it('is absent from a server that does not register fake controls', async () => {
    const app = Fastify();
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/dev/fake/scm/merge-final-pr',
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
});

it('validates added controls before mutation and retains REST security', async () => {
  const app = Fastify();
  const controls = {
    mergeOwner: vi.fn(),
    editIssueBody: vi.fn(async () => {}),
    setPrStatus: vi.fn(),
    setRuntimeConnected: vi.fn(),
  };
  await registerDevFakeRoutes(
    app,
    {
      port: 1234,
      sessions: {
        verify: (t) => t === 'valid',
        exchangeBootstrapCode: () => null,
      },
    },
    controls,
  );
  const headers = {
    host: 'localhost:1234',
    origin: 'http://localhost:1234',
    cookie: 'aio_session=valid',
  };
  try {
    for (const [url, payload, invalid, fn, args] of [
      [
        '/dev/fake/scm/edit-issue-body',
        { number: 2, body: 'Updated fixture' },
        { number: 2, body: 5 },
        controls.editIssueBody,
        [2, 'Updated fixture'],
      ],
      [
        '/dev/fake/scm/pr-status',
        { number: 3, mergeable: false, checks: 'failure' },
        { number: 3, checks: 'bad' },
        controls.setPrStatus,
        [3, { mergeable: false, checks: 'failure' }],
      ],
      [
        '/dev/fake/runtime/connected',
        { connected: false },
        { connected: 'false' },
        controls.setRuntimeConnected,
        [false],
      ],
    ] as const) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { ...headers, cookie: '' },
            payload,
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { ...headers, origin: 'http://evil.invalid' },
            payload,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ method: 'POST', url, headers, payload: invalid }))
          .statusCode,
      ).toBe(400);
      expect(fn).not.toHaveBeenCalled();
      expect(
        (await app.inject({ method: 'POST', url, headers, payload })).json(),
      ).toEqual({ ok: true });
      expect(fn).toHaveBeenCalledWith(...args);
    }
  } finally {
    await app.close();
  }
});
