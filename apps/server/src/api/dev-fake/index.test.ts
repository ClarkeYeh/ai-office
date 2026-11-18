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
