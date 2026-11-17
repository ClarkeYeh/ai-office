import Fastify from 'fastify';
import { registerApi } from './index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiEndpoints,
  ErrorResponseSchema,
  type EndpointContract,
} from '@ai-office/contracts/api';
import { UseCaseError } from '../application/facade.js';
import { draft } from '../application/use-cases/support.js';
import { startWorkflow } from '../application/runner/test-support/harness.js';
import { setup } from './test-support/setup.js';

const active: Awaited<ReturnType<typeof setup>>[] = [];
async function server(options: Parameters<typeof setup>[0] = {}) {
  const h = await setup(options);
  active.push(h);
  return h;
}
afterEach(async () => {
  for (const h of active.splice(0)) await h.app.close();
  vi.restoreAllMocks();
});

function error(
  response: { statusCode: number; json(): unknown },
  status: number,
  code: string,
) {
  expect(response.statusCode).toBe(status);
  expect(ErrorResponseSchema.parse(response.json()).error.code).toBe(code);
}

describe('cookie bootstrap and request perimeter', () => {
  it('exchanges once, sets strict HttpOnly cookie and protects GET, unknown paths and SSE', async () => {
    const h = await server();
    for (const url of ['/api/v1/health', '/api/v1/stream', '/api/v1/unknown'])
      error(
        await h.app.inject({ url, headers: { host: h.headers.host } }),
        401,
        'unauthorized',
      );
    const code = h.sessionStore.issueBootstrapCode();
    const response = await h.app.inject({
      url: `/auth/bootstrap?code=${code}`,
      headers: { host: h.headers.host },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['set-cookie']).toMatch(
      /^aio_session=.+; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Strict$/,
    );
    const cookie = String(response.headers['set-cookie']).split(';')[0]!;
    expect(
      (
        await h.app.inject({
          url: '/api/v1/health',
          headers: { host: h.headers.host, cookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(JSON.stringify(h.sessionStore.snapshot())).not.toContain(
      cookie.split('=')[1],
    );
    error(
      await h.app.inject({
        url: `/auth/bootstrap?code=${code}`,
        headers: h.headers,
      }),
      401,
      'bootstrap_code_invalid',
    );
    h.clock.advance(30 * 24 * 60 * 60 * 1000);
    error(
      await h.app.inject({
        url: '/api/v1/health',
        headers: { host: h.headers.host, cookie },
      }),
      401,
      'unauthorized',
    );
  });
  it('does not log bootstrap credentials with Fastify request logging enabled', async () => {
    const h = await server();
    const logs: string[] = [];
    const app = Fastify({
      logger: {
        level: 'info',
        stream: {
          write: (line: string) => {
            logs.push(line);
          },
        },
      },
    });
    await registerApi(app, h.deps);
    try {
      const code = h.sessionStore.issueBootstrapCode();
      const response = await app.inject({
        url: '/auth/bootstrap?code=' + code,
        headers: { host: h.headers.host },
      });
      expect(response.statusCode).toBe(302);
      expect(logs.join('')).not.toContain(code);
      expect(logs.join('')).not.toContain(
        String(response.headers['set-cookie']).split(';')[0]!.split('=')[1],
      );
    } finally {
      await app.close();
    }
  });
  it('rejects bootstrap at the 60-second boundary and concurrent reuse', async () => {
    const h = await server();
    const expired = h.sessionStore.issueBootstrapCode();
    h.clock.advance(60_000);
    error(
      await h.app.inject({
        url: `/auth/bootstrap?code=${expired}`,
        headers: h.headers,
      }),
      401,
      'bootstrap_code_invalid',
    );
    const code = h.sessionStore.issueBootstrapCode();
    const responses = await Promise.all(
      [1, 2].map(() =>
        h.app.inject({
          url: `/auth/bootstrap?code=${code}`,
          headers: h.headers,
        }),
      ),
    );
    expect(responses.map((r) => r.statusCode).sort()).toEqual([302, 401]);
    h.deps.sessions.verify = () => false;
    error(
      await h.app.inject({ url: '/api/v1/health', headers: h.headers }),
      401,
      'unauthorized',
    );
  });
  it.each([
    'evil.example:4319',
    '127.0.0.1:4320',
    '127.0.0.1',
    'localhost:4319.evil',
    '127.0.0.1:4319@evil',
  ])('rejects Host %s including bootstrap and SSE', async (host) => {
    const h = await server();
    for (const url of [
      '/api/v1/health',
      '/api/v1/stream',
      '/auth/bootstrap?code=x',
    ])
      error(
        await h.app.inject({
          url,
          headers: { ...h.headers, host, 'x-forwarded-host': h.headers.host },
        }),
        403,
        'forbidden_host',
      );
  });
  it('requires Origin on writes and rejects foreign origins on reads/SSE/bootstrap', async () => {
    const h = await server();
    for (const origin of [
      undefined,
      'null',
      'https://evil.example',
      'http://localhost:4320',
      'http://127.0.0.1:4319/',
    ]) {
      const headers = {
        host: h.headers.host,
        cookie: h.headers.cookie,
        ...(origin === undefined ? {} : { origin }),
      };
      error(
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/repos',
          headers,
          payload: { localPath: '/repo' },
        }),
        403,
        'forbidden_origin',
      );
    }
    for (const url of [
      '/api/v1/health',
      '/api/v1/stream',
      '/auth/bootstrap?code=x',
    ])
      error(
        await h.app.inject({
          url,
          headers: { ...h.headers, origin: 'https://evil.example' },
        }),
        403,
        'forbidden_origin',
      );
    expect(
      (
        await h.app.inject({
          url: '/api/v1/health',
          headers: {
            ...h.headers,
            host: 'localhost:4319',
            origin: 'http://localhost:4319',
          },
        })
      ).statusCode,
    ).toBe(200);
  });
  it('enables dev origin only with explicit dev mode', async () => {
    const devOrigin = 'http://localhost:5173';
    const production = await server({ devOrigin });
    error(
      await production.app.inject({
        url: '/api/v1/health',
        headers: { ...production.headers, origin: devOrigin },
      }),
      403,
      'forbidden_origin',
    );
    const dev = await server({ dev: true, devOrigin });
    expect(
      (
        await dev.app.inject({
          method: 'POST',
          url: '/api/v1/repos',
          headers: { ...dev.headers, origin: devOrigin },
          payload: { localPath: '/new' },
        })
      ).statusCode,
    ).toBe(201);
  });
  it('authenticates before request validation and rejects invalid cookies', async () => {
    const h = await server();
    error(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/workflows',
        headers: { ...h.headers, cookie: 'aio_session=invalid' },
        payload: {},
      }),
      401,
      'unauthorized',
    );
    error(
      await h.app.inject({
        url: '/api/v1/workflows/missing/events?limit=no',
        headers: { host: h.headers.host },
      }),
      401,
      'unauthorized',
    );
  });
});

describe('REST contracts and use-case forwarding', () => {
  it('serves a schema-valid success for every REST contract', async () => {
    const h = await server();
    await h.runners.start(startWorkflow());
    const runner = h.runners.get('wf-1')!;
    await runner.append([
      draft(h.clock, 'wf-1', 'gate.opened', {
        gateId: 'g',
        stageId: 'implement',
        kind: 'exception',
        exceptionKind: 'anomaly',
        title: 'Review',
        version: 1,
        options: [
          { optionId: 'continue', label: 'Continue' },
          { optionId: 'abort', label: 'Abort' },
        ],
        content: { type: 'exception', summary: 'Check' },
      }),
    ]);
    // The API tests transport forwarding; command/domain semantics have their own suites.
    const calls = {
      startWorkflow: vi
        .spyOn(h.deps.commands, 'startWorkflow')
        .mockResolvedValue({ workflowId: 'new' }),
      decideGate: vi
        .spyOn(h.deps.commands, 'decideGate')
        .mockResolvedValue({ gateId: 'g' }),
      answerQuestion: vi
        .spyOn(h.deps.commands, 'answerQuestion')
        .mockResolvedValue({ questionId: 'q' }),
      messageSeat: vi
        .spyOn(h.deps.commands, 'messageSeat')
        .mockResolvedValue({ commandId: 'c' }),
      cleanupWorkflow: vi
        .spyOn(h.deps.commands, 'cleanupWorkflow')
        .mockResolvedValue({ workflowId: 'wf-1', commandIds: [] }),
    };
    const firstSeat = {
      seatId: 'wf-1:engineer:item',
      workflowId: 'wf-1',
      role: 'engineer',
      agent: null,
      state: null,
      degraded: false,
      recentActivity: [],
      attempts: [],
      policyHits: [],
      errors: [],
      usage: {
        inputUncached: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        budgetTokens: 0,
        turns: 0,
      },
    };
    vi.spyOn(h.deps.queries, 'getSeat').mockReturnValue(firstSeat);
    const body: Record<string, unknown> = {
      registerRepo: { localPath: '/new-repo' },
      startWorkflow: {
        templateId: h.template.id,
        repoId: 'repo-1',
        requirement: 'Feature',
      },
      decideGate: {
        decision: 'option',
        optionId: 'continue',
        expectedVersion: 1,
      },
      answerQuestion: { body: 'Answer', optionId: 'x' },
      messageSeat: { subject: 'Note', body: 'Instruction' },
    };
    const seen = new Set<string>();
    for (const endpoint of apiEndpoints as readonly EndpointContract[]) {
      if (
        ['bootstrap', 'streamEvents', 'submitAgent'].includes(
          endpoint.operationId,
        )
      )
        continue;
      const id = endpoint.path.includes('/templates/')
        ? h.template.id
        : endpoint.path.includes('/repos/')
          ? 'repo-1'
          : endpoint.path.includes('/gates/')
            ? 'g'
            : endpoint.path.includes('/questions/')
              ? 'q'
              : 'wf-1';
      let url = endpoint.path
        .replace('{id}', id)
        .replace('{seatId}', encodeURIComponent(firstSeat.seatId));
      if (endpoint.operationId === 'listEvents') url += '?afterSeq=0&limit=1';
      const payload = body[endpoint.operationId];
      const response = await h.app.inject({
        method: endpoint.method === 'get' ? 'GET' : 'POST',
        url,
        headers: { ...h.headers, 'idempotency-key': 'key' },
        ...(payload === undefined
          ? {}
          : {
              payload: JSON.stringify(payload),
              headers: {
                ...h.headers,
                'idempotency-key': 'key',
                'content-type': 'application/json',
              },
            }),
      });
      expect(
        response.statusCode,
        `${endpoint.operationId}: ${response.body}`,
      ).toBe(endpoint.status ?? 200);
      expect(
        endpoint.response.safeParse(response.json()).success,
        endpoint.operationId,
      ).toBe(true);
      seen.add(endpoint.operationId);
    }
    expect(seen.size).toBe(apiEndpoints.length - 3);
    expect(calls.decideGate).toHaveBeenCalledWith('g', body.decideGate, 'key');
    expect(calls.answerQuestion).toHaveBeenCalledWith(
      'q',
      body.answerQuestion,
      'key',
    );
    expect(calls.messageSeat).toHaveBeenCalledWith(
      firstSeat.seatId,
      body.messageSeat,
    );
    expect(calls.startWorkflow).toHaveBeenCalledWith(body.startWorkflow);
  });
  it('validates requests, pagination and idempotency headers; maps missing entities to 404', async () => {
    const h = await server();
    for (const url of [
      '/api/v1/repos/missing',
      '/api/v1/templates/missing',
      '/api/v1/workflows/missing',
      '/api/v1/workflows/missing/events',
      '/api/v1/gates/missing',
      '/api/v1/seats/missing',
      '/api/v1/unknown',
    ])
      error(await h.app.inject({ url, headers: h.headers }), 404, 'not_found');
    for (const query of [
      'limit=no',
      'limit=0',
      'limit=-1',
      'limit=1.5',
      'limit=9007199254740992',
      'limit=9007199254740991',
      'limit=1&limit=2',
      'afterSeq=',
    ])
      error(
        await h.app.inject({
          url: `/api/v1/workflows/w/events?${query}`,
          headers: h.headers,
        }),
        400,
        'validation_failed',
      );
    error(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/workflows',
        headers: h.headers,
        payload: {},
      }),
      400,
      'validation_failed',
    );
    error(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/gates/g/decision',
        headers: h.headers,
        payload: { decision: 'approve', expectedVersion: 1 },
      }),
      400,
      'validation_failed',
    );
    error(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/questions/q/answer',
        headers: h.headers,
        payload: { body: 'x' },
      }),
      400,
      'validation_failed',
    );
    error(
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/repos',
        headers: { ...h.headers, 'content-type': 'application/json' },
        payload: '{',
      }),
      400,
      'validation_failed',
    );
    const invalid = await h.app.inject({
      url: '/api/v1/templates/invalid',
      headers: h.headers,
    });
    expect(invalid.statusCode).toBe(200);
    expect(invalid.json().invalid[0].file).toBe('invalid.yaml');
  });
  it('validates response data and suppresses raw application errors', async () => {
    const h = await server();
    vi.spyOn(h.deps.queries, 'getHealth').mockReturnValueOnce({
      secret: 'private',
    } as never);
    const invalid = await h.app.inject({
      url: '/api/v1/health',
      headers: h.headers,
    });
    error(invalid, 500, 'internal_error');
    expect(invalid.body).not.toContain('private');
    for (const [source, target, status] of [
      ['gate_version_conflict', 'version_conflict', 409],
      ['runtime_unverified', 'runtime_unverified_ack_required', 428],
      ['idempotency_mismatch', 'idempotency_key_reused', 422],
    ] as const) {
      vi.spyOn(h.deps.commands, 'startWorkflow').mockRejectedValueOnce(
        new UseCaseError(500, source, 'secret'),
      );
      error(
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/workflows',
          headers: h.headers,
          payload: {
            templateId: h.template.id,
            repoId: 'repo-1',
            requirement: 'x',
          },
        }),
        status,
        target,
      );
    }
  });
  it('registers SSE with the real auth hook before opening a stream', async () => {
    const h = await server();
    const open = vi.spyOn(h.deps.stream, 'open');
    error(
      await h.app.inject({
        url: '/api/v1/stream',
        headers: { host: h.headers.host },
      }),
      401,
      'unauthorized',
    );
    expect(open).not.toHaveBeenCalled();
    // A finite application stream makes inject deterministic, preserving SSE framing.
    const closed = h.deps.stream.open({ afterSeq: 0 });
    await closed.return();
    open.mockClear();
    open.mockReturnValueOnce(closed);
    const response = await h.app.inject({
      url: '/api/v1/stream',
      headers: h.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(open).toHaveBeenCalledWith({ afterSeq: 0 });
  });
});
