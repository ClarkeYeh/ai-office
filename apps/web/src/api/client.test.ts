import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiEndpoints } from '@ai-office/contracts/api';
import {
  ApiError,
  bootstrapUrl,
  createApiClient,
  createIdempotencyKey,
  messageSubject,
  streamUrl,
} from './index.js';
import type { ApiClient, Operation } from './index.js';
import { endpoints } from './endpoints.js';

const id = 'wf/seat:工程師?#';
const encoded = encodeURIComponent(id);
const decision = {
  decision: 'approve',
  expectedVersion: 2,
  githubBodyHash: 'a'.repeat(64),
} as const;
const start = {
  templateId: 'feature',
  repoId: 'repo',
  requirement: 'Build it',
  acknowledgeUnverifiedRuntime: true,
};
const action = { idempotencyKey: 'same-action' };
const cases: {
  operation: Operation;
  call: (api: ApiClient) => Promise<unknown>;
  path: string;
  body?: unknown;
}[] = [
  {
    operation: 'getHealth',
    call: (a) => a.getHealth(),
    path: '/api/v1/health',
  },
  { operation: 'listRepos', call: (a) => a.listRepos(), path: '/api/v1/repos' },
  {
    operation: 'registerRepo',
    call: (a) => a.registerRepo({ localPath: '/test/repo' }),
    path: '/api/v1/repos',
    body: { localPath: '/test/repo' },
  },
  {
    operation: 'getRepo',
    call: (a) => a.getRepo(id),
    path: `/api/v1/repos/${encoded}`,
  },
  {
    operation: 'listTemplates',
    call: (a) => a.listTemplates(),
    path: '/api/v1/templates',
  },
  {
    operation: 'getTemplate',
    call: (a) => a.getTemplate(id),
    path: `/api/v1/templates/${encoded}`,
  },
  {
    operation: 'listWorkflows',
    call: (a) => a.listWorkflows(),
    path: '/api/v1/workflows',
  },
  {
    operation: 'startWorkflow',
    call: (a) => a.startWorkflow(start),
    path: '/api/v1/workflows',
    body: start,
  },
  {
    operation: 'getWorkflow',
    call: (a) => a.getWorkflow(id),
    path: `/api/v1/workflows/${encoded}`,
  },
  {
    operation: 'listEvents',
    call: (a) => a.listEvents(id, { afterSeq: 0, limit: 500 }),
    path: `/api/v1/workflows/${encoded}/events?afterSeq=0&limit=500`,
  },
  {
    operation: 'cancelWorkflow',
    call: (a) => a.cancelWorkflow(id),
    path: `/api/v1/workflows/${encoded}/cancel`,
  },
  {
    operation: 'cleanupWorkflow',
    call: (a) => a.cleanupWorkflow(id),
    path: `/api/v1/workflows/${encoded}/cleanup`,
  },
  {
    operation: 'listGates',
    call: (a) => a.listGates({ status: 'open' }),
    path: '/api/v1/gates?status=open',
  },
  {
    operation: 'getGate',
    call: (a) => a.getGate(id),
    path: `/api/v1/gates/${encoded}`,
  },
  {
    operation: 'decideGate',
    call: (a) => a.decideGate(id, decision, action),
    path: `/api/v1/gates/${encoded}/decision`,
    body: decision,
  },
  {
    operation: 'listQuestions',
    call: (a) => a.listQuestions({ status: 'escalated' }),
    path: '/api/v1/questions?status=escalated',
  },
  {
    operation: 'answerQuestion',
    call: (a) => a.answerQuestion(id, { body: 'Yes', optionId: 'yes' }, action),
    path: `/api/v1/questions/${encoded}/answer`,
    body: { body: 'Yes', optionId: 'yes' },
  },
  {
    operation: 'getSeat',
    call: (a) => a.getSeat(id),
    path: `/api/v1/seats/${encoded}`,
  },
  {
    operation: 'messageSeat',
    call: (a) => a.messageSeat(id, 'First line\nFull message'),
    path: `/api/v1/seats/${encoded}/message`,
    body: { subject: 'First line', body: 'First line\nFull message' },
  },
];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('REST contract and transport', () => {
  it('covers exactly the session JSON operations and matches contract paths/methods', () => {
    const rest = apiEndpoints.filter(
      (e) =>
        !['bootstrap', 'streamEvents', 'submitAgent'].includes(e.operationId),
    );
    expect(endpoints).toEqual(
      Object.fromEntries(
        rest.map((e) => [e.operationId, { method: e.method, path: e.path }]),
      ),
    );
    expect(cases.map((c) => c.operation).sort()).toEqual(
      Object.keys(endpoints).sort(),
    );
  });
  it.each(cases)(
    '$operation sends its method, encoded path, query, headers and body',
    async ({ operation, call, path, body }) => {
      vi.stubEnv('DEV', false);
      const payload = { additiveField: true };
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(Response.json(payload));
      expect(await call(createApiClient({ fetch }))).toEqual(payload);
      const contract = apiEndpoints.find((e) => e.operationId === operation)!;
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if ('headers' in contract)
        headers['Idempotency-Key'] = action.idempotencyKey;
      expect(fetch).toHaveBeenCalledExactlyOnceWith(path, {
        method: contract.method.toUpperCase(),
        headers,
        credentials: 'same-origin',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
  );
  it.each(cases)(
    '$operation validates its response in DEV/test',
    async ({ call }) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(Response.json(null));
      await expect(call(createApiClient({ fetch }))).rejects.toMatchObject({
        code: 'invalid_response',
        status: 200,
      });
    },
  );
  it('preserves valid responses and additive fields after validation', async () => {
    const payload = { events: [], nextAfterSeq: 42, newField: 'future' };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json(payload));
    expect(await createApiClient({ fetch }).listEvents('wf')).toEqual(payload);
  });
  it('uses the global fetch by default and omits undefined query values', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ gates: [] }));
    vi.stubGlobal('fetch', fetch);
    await createApiClient().listGates({ status: undefined });
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/v1/gates');
  });
  it('builds navigation/SSE URLs without initiating requests', () => {
    expect(bootstrapUrl('a&b?')).toBe('/auth/bootstrap?code=a%26b%3F');
    expect(streamUrl()).toBe('/api/v1/stream');
    expect(streamUrl({ workflowId: 'a/b', afterSeq: 0 })).toBe(
      '/api/v1/stream?workflowId=a%2Fb&afterSeq=0',
    );
    expect(
      apiEndpoints.find((e) => e.operationId === 'streamEvents')?.path,
    ).toBe(streamUrl());
    expect(apiEndpoints.find((e) => e.operationId === 'bootstrap')?.path).toBe(
      bootstrapUrl('x').split('?')[0],
    );
  });
});

describe('errors, auth and cancellation', () => {
  it.each([400, 401, 403, 404, 409, 422, 428, 429, 500, 503])(
    'preserves the structured HTTP %s error',
    async (status) => {
      const error = {
        code: 'new_compatible_code',
        category: 'conflict',
        message: 'Changed',
        retryable: false,
        details: { version: 3 },
      };
      const onUnauthorized = vi.fn();
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(Response.json({ error }, { status }));
      await expect(
        createApiClient({ fetch, onUnauthorized }).getGate('g'),
      ).rejects.toMatchObject({ ...error, status, name: 'ApiError' });
      expect(onUnauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['not json', 'null', '{"error":{"code":7}}'])(
    'handles malformed error body %s and still notifies 401',
    async (body) => {
      const onUnauthorized = vi.fn();
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(async () => new Response(body, { status: 401 }));
      await expect(
        createApiClient({ fetch, onUnauthorized }).getHealth(),
      ).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    },
  );
  it('normalizes non-JSON success and non-JSON server failures', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('<html>error</html>'))
      .mockResolvedValueOnce(new Response('', { status: 502 }));
    const api = createApiClient({ fetch });
    await expect(api.getHealth()).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    });
    await expect(api.getHealth()).rejects.toMatchObject({
      code: 'http_error',
      status: 502,
    });
  });
  it('normalizes network failures without retaining raw errors or retrying', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new TypeError('network detail'));
    const api = createApiClient({ fetch });
    await expect(api.getHealth()).rejects.toMatchObject({
      code: 'network_error',
      category: 'transient',
      status: 0,
      retryable: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('forwards AbortSignal and preserves cancellation', async () => {
    const controller = new AbortController();
    const error = new DOMException('Aborted', 'AbortError');
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(error);
    await expect(
      createApiClient({ fetch }).getHealth({ signal: controller.signal }),
    ).rejects.toBe(error);
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    controller.abort('custom reason');
    fetch.mockRejectedValueOnce('custom reason');
    await expect(
      createApiClient({ fetch }).getHealth({ signal: controller.signal }),
    ).rejects.toBe('custom reason');
  });
  it('preserves cancellation while consuming the body', async () => {
    const error = new DOMException('Aborted', 'AbortError');
    const response = new Response();
    vi.spyOn(response, 'json').mockRejectedValue(error);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    await expect(createApiClient({ fetch }).getHealth()).rejects.toBe(error);
  });
});

describe('decision action identity and message subjects', () => {
  it.each(['decideGate', 'answerQuestion'] as const)(
    '%s retains one key across manual resends, without automatic retries',
    async (operation) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValueOnce(new TypeError('offline'))
        .mockResolvedValueOnce(Response.json({ accepted: true }));
      const api = createApiClient({ fetch });
      const idempotencyKey = createIdempotencyKey();
      expect(idempotencyKey).not.toBe(createIdempotencyKey());
      const send = () =>
        operation === 'decideGate'
          ? api.decideGate('g', decision, { idempotencyKey })
          : api.answerQuestion('q', { body: 'yes' }, { idempotencyKey });
      await expect(send()).rejects.toBeInstanceOf(ApiError);
      expect(fetch).toHaveBeenCalledTimes(1);
      await expect(send()).resolves.toEqual({ accepted: true });
      for (const [, init] of fetch.mock.calls)
        expect(init?.headers).toMatchObject({
          'Idempotency-Key': idempotencyKey,
        });
      expect(fetch.mock.calls[0]?.[1]?.body).toBe(
        fetch.mock.calls[1]?.[1]?.body,
      );
    },
  );
  it('refuses an empty decision key before fetching', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      createApiClient({ fetch }).decideGate('g', decision, {
        idempotencyKey: '',
      }),
    ).rejects.toMatchObject({ code: 'idempotency_key_required' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('derives only the first line, truncating Unicode without splitting surrogate pairs', () => {
    expect(messageSubject('Title\r\nBody')).toBe('Title');
    expect(messageSubject('Title\rBody')).toBe('Title');
    expect(messageSubject('🙂'.repeat(61) + '\nBody')).toBe('🙂'.repeat(60));
    expect(messageSubject('')).toBe('');
    expect(messageSubject('\nBody')).toBe('');
  });
});
