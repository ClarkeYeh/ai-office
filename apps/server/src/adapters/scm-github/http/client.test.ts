import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createRedactor } from '@ai-office/redaction';
import {
  createGithubScm,
  RepoAllowlist,
  viewerSchema,
  emptySchema,
} from '../index.js';
import type { EndpointId, GithubHttpOptions } from '../index.js';

const repo = { owner: 'owner', name: 'project' };
const params = { owner: repo.owner, repo: repo.name };
const schema = z.looseObject({ value: z.number() });
const redactor = createRedactor();
const json = (
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) => new Response(JSON.stringify(data), { status, headers });
function setup(
  responses: (Response | Error)[],
  extra: Partial<GithubHttpOptions> = {},
) {
  let time = Date.parse('2026-01-01T00:00:00Z');
  const clock = { now: () => new Date(time) };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const response = responses.shift();
    if (!response) throw new Error('Unexpected request');
    if (response instanceof Error) throw response;
    return response;
  });
  const tokenProvider = vi.fn(async () => 'test-credential');
  const base = createGithubScm({
    fetch,
    clock,
    sleep: async (ms) => {
      time += ms;
    },
    tokenProvider,
    repoAllowlist: new RepoAllowlist([repo]),
    maskSecrets: <T>(value: T): T => redactor.maskText(String(value)) as T,
    ...extra,
  });
  return {
    ...base,
    fetch,
    tokenProvider,
    clock,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('GitHub HTTP boundary', () => {
  it('injects fetch, pins headers, and encodes branch segments once', async () => {
    const f = setup([json({ value: 1, added: 'accepted' })]);
    const result = await f.http.request(
      'branches.get',
      { ...params, branch: 'ai-office/topic' },
      { schema },
    );
    expect(result.data).toEqual({ value: 1, added: 'accepted' });
    const [url, init] = f.fetch.mock.calls[0]!;
    expect(url).toBe(
      'https://api.github.com/repos/owner/project/branches/ai-office%2Ftopic',
    );
    expect(new Headers(init?.headers).get('x-github-api-version')).toBe(
      '2022-11-28',
    );
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer test-credential',
    );
    expect(init?.redirect).toBe('manual');
  });
  it('rejects unknown endpoints, prototype properties, path traversal and repositories before credentials or fetch', async () => {
    const f = setup([]);
    for (const id of ['unknown', 'toString', '__proto__'])
      await expect(
        f.http.request(id as EndpointId, params, { schema }),
      ).rejects.toMatchObject({
        category: 'guard',
        code: 'endpoint_not_allowed',
      });
    for (const branch of ['..', '../main', '%2e%2e', 'x\\y'])
      await expect(
        f.http.request('branches.get', { ...params, branch }, { schema }),
      ).rejects.toMatchObject({ category: 'guard' });
    await expect(
      f.http.request(
        'repos.get',
        { owner: 'other', repo: 'other' },
        { schema },
      ),
    ).rejects.toMatchObject({ code: 'repo_not_allowed' });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.tokenProvider).not.toHaveBeenCalled();
  });
  it('grants scoped registration reads but never writes, then revokes on errors', async () => {
    const f = setup([json({ value: 1 })], {
      repoAllowlist: new RepoAllowlist(),
    });
    await f.repoAllowlist.inspect(repo, async () => {
      await f.http.request('repos.get', params, { schema });
      await expect(
        f.http.request(
          'issues.create',
          { ...params, body: { title: 't', body: 'b' } },
          { schema },
        ),
      ).rejects.toMatchObject({ code: 'repo_not_allowed' });
    });
    await expect(
      f.repoAllowlist.inspect(repo, async () => {
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
    await expect(
      f.http.request('repos.get', params, { schema }),
    ).rejects.toMatchObject({ code: 'repo_not_allowed' });
    f.repoAllowlist.register(repo);
    f.repoAllowlist.remove(repo);
    await expect(
      f.http.request('repos.get', params, { schema }),
    ).rejects.toMatchObject({ code: 'repo_not_allowed' });
  });
  it('serves 304 from isolated cache values without spending or decrementing a budget', async () => {
    const f = setup([
      json({ value: 1 }, 200, { etag: '"a"', 'x-ratelimit-remaining': '40' }),
      new Response(null, {
        status: 304,
        headers: { 'x-ratelimit-remaining': '40' },
      }),
    ]);
    const first = await f.http.request('repos.get', params, {
      schema,
      conditional: true,
    });
    first.data.value = 99;
    const second = await f.http.request('repos.get', params, {
      schema,
      conditional: true,
    });
    expect(second).toMatchObject({
      data: { value: 1 },
      status: 304,
      notModified: true,
    });
    expect(
      new Headers(f.fetch.mock.calls[1]![1]?.headers).get('if-none-match'),
    ).toBe('"a"');
    expect(f.diagnostics().rateLimit.remaining).toBe(40);
    expect(f.diagnostics().endpoints['repos.get']).toMatchObject({
      calls: 2,
      notModifiedRatio: 0.5,
      failureRate: 0,
    });
  });
  it('keys ETags by query and refuses an uncached or mismatched 304', async () => {
    const f = setup([
      json({ value: 1 }, 200, { etag: '"a"' }),
      new Response(null, { status: 304 }),
      new Response(null, { status: 304 }),
    ]);
    await f.http.request(
      'repos.get',
      { ...params, query: { page: 1 } },
      { schema, conditional: true },
    );
    await expect(
      f.http.request(
        'repos.get',
        { ...params, query: { page: 2 } },
        { schema, conditional: true },
      ),
    ).rejects.toMatchObject({ category: 'contract_mismatch' });
    await expect(
      f.http.request(
        'repos.get',
        { ...params, query: { page: 1 } },
        { schema, conditional: '"old"' },
      ),
    ).rejects.toMatchObject({ category: 'contract_mismatch' });
  });
  it('follows and caches page links without accepting a URL escape', async () => {
    const link =
      '<https://api.github.com/repos/owner/project/issues?per_page=100&page=2>; rel="next"';
    const f = setup([
      json([{ value: 1 }], 200, { link, etag: '"1"' }),
      json([{ value: 2 }], 200, { etag: '"2"' }),
      new Response(null, { status: 304 }),
      new Response(null, { status: 304 }),
    ]);
    const options = { schema: z.array(schema), conditional: true };
    expect(await f.http.paginate('issues.list', params, options)).toEqual([
      { value: 1 },
      { value: 2 },
    ]);
    expect(await f.http.paginate('issues.list', params, options)).toEqual([
      { value: 1 },
      { value: 2 },
    ]);
    expect(f.fetch).toHaveBeenCalledTimes(4);
  });
  it.each([
    'https://evil.invalid/repos/owner/project/issues?per_page=100&page=2',
    'https://api.github.com/repos/other/project/issues?per_page=100&page=2',
    'https://api.github.com/repos/owner/project/issues?per_page=100&page=1',
    'https://api.github.com/repos/owner/project/issues?per_page=100&page=2&state=closed',
    'https://name:pass@api.github.com/repos/owner/project/issues?per_page=100&page=2',
  ])('rejects unsafe Link %s', async (link) => {
    const f = setup([json([], 200, { link: `<${link}>; rel="next"` })]);
    await expect(
      f.http.paginate('issues.list', params, { schema: z.array(schema) }),
    ).rejects.toMatchObject({ category: 'guard' });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it('does not follow HTTP redirects or accept malformed consumed fields', async () => {
    const f = setup([
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.invalid' },
      }),
      json({ value: 'bad' }),
      new Response('invalid'),
    ]);
    await expect(
      f.http.request('repos.get', params, { schema }),
    ).rejects.toMatchObject({ code: 'github_redirect_not_allowed' });
    for (let i = 0; i < 2; i++)
      await expect(
        f.http.request('repos.get', params, { schema }),
      ).rejects.toMatchObject({ category: 'contract_mismatch' });
  });
  it.each([
    [403, {}, 'permanent', 'github_forbidden'],
    [404, {}, 'permanent', 'not_found'],
    [409, {}, 'conflict', 'head_mismatch'],
    [405, { message: 'Merge conflict' }, 'conflict', 'not_mergeable'],
    [
      405,
      { message: 'Required checks failed' },
      'permanent',
      'merge_blocked_by_rules',
    ],
    [422, {}, 'permanent', 'github_validation'],
    [500, {}, 'transient', 'github_unavailable'],
    [400, {}, 'permanent', 'github_http_error'],
  ])('maps status %s safely', async (status, body, category, code) => {
    const f = setup([json(body, status as number)]);
    await expect(
      f.http.request('repos.get', params, { schema }),
    ).rejects.toMatchObject({ category, code });
  });
  it('exposes only an alreadyExists flag for 422 reconciliation', async () => {
    const f = setup([
      json({ errors: [{ code: 'already_exists', resource: 'hidden' }] }, 422),
    ]);
    await expect(
      f.http.request('repos.get', params, { schema }),
    ).rejects.toMatchObject({ code: 'github_validation', alreadyExists: true });
  });
  it('never retries uncertain Issue/comment creation and exposes retryAfterMs', async () => {
    for (const endpoint of ['issues.create', 'comments.create'] as const) {
      for (const failure of [new Error('connection lost'), json({}, 503)]) {
        const f = setup([failure]);
        await expect(
          f.http.request(
            endpoint,
            {
              ...params,
              number: 1,
              body:
                endpoint === 'issues.create'
                  ? { title: 't', body: 'b' }
                  : { body: 'b' },
            },
            { schema },
          ),
        ).rejects.toMatchObject({
          category: 'transient',
          code: 'create_outcome_unknown',
          retryAfterMs: 15000,
        });
        expect(f.fetch).toHaveBeenCalledTimes(1);
      }
    }
  });
  it('sanitizes credentials, email, and request content before truncating error text', async () => {
    const secret = 'ghp_' + 'a'.repeat(36),
      email = 'person' + '@example.com',
      content = 'private request text';
    const f = setup(
      [
        json({ message: `${secret} ${email} ${content}` }, 422, {
          'x-github-request-id': secret,
          'x-private': 'never-output',
        }),
      ],
      { tokenProvider: async () => secret },
    );
    const error = await f.http
      .request(
        'issues.create',
        { ...params, body: { title: 'title', body: content } },
        { schema },
      )
      .catch((e: unknown) => e);
    const output = JSON.stringify(error) + ' ' + String(error);
    for (const text of [
      secret,
      email,
      content,
      'never-output',
      'Authorization',
    ])
      expect(output).not.toContain(text);
  });
  it('reloads credentials once on 401, throttles refresh for five minutes, and drops provider errors', async () => {
    const f = setup([
      json({}, 401),
      json({ login: 'owner' }),
      json({}, 401),
      json({}, 401),
      json({}, 401),
    ]);
    expect(
      (await f.http.request('user.get', {}, { schema: viewerSchema })).data
        .login,
    ).toBe('owner');
    await expect(
      f.http.request('user.get', {}, { schema: viewerSchema }),
    ).rejects.toMatchObject({ category: 'auth' });
    expect(f.tokenProvider.mock.calls).toEqual([
      [{ refresh: false }],
      [{ refresh: true }],
    ]);
    f.advance(300000);
    await expect(
      f.http.request('user.get', {}, { schema: viewerSchema }),
    ).rejects.toMatchObject({ category: 'auth' });
    expect(f.tokenProvider).toHaveBeenCalledTimes(3);
    const broken = setup([], {
      tokenProvider: async () => {
        throw new Error('sensitive');
      },
    });
    await expect(
      broken.http.request('user.get', {}, { schema: viewerSchema }),
    ).rejects.toThrow('GitHub credentials are unavailable');
  });
  it('returns primary cooldown without further fetches and resumes at reset', async () => {
    const reset = Date.parse('2026-01-01T00:02:00Z') / 1000;
    const f = setup([
      json({}, 403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(reset),
      }),
      json({ value: 2 }),
    ]);
    await expect(
      f.http.request('repos.get', params, { schema }),
    ).rejects.toMatchObject({
      category: 'rate_limited',
      code: 'primary_rate_limit',
      retryAfterMs: 120000,
    });
    f.advance(20000);
    await expect(
      f.http.request(
        'issues.create',
        { ...params, body: { title: 't', body: 'b' } },
        { schema },
      ),
    ).rejects.toMatchObject({ category: 'rate_limited', retryAfterMs: 100000 });
    expect(f.diagnostics().rateLimit.status).toBe('degraded');
    expect(f.fetch).toHaveBeenCalledTimes(1);
    f.advance(100000);
    await f.http.request('repos.get', params, { schema });
  });
  it.each([
    ['5', 5000],
    ['Thu, 01 Jan 2026 00:00:10 GMT', 10000],
  ])('honors Retry-After %s', async (retry, wait) => {
    const f = setup([json({}, 429, { 'retry-after': String(retry) })]);
    await expect(
      f.http.request('repos.get', params, { schema }),
    ).rejects.toMatchObject({
      category: 'rate_limited',
      code: 'secondary_rate_limit',
      retryAfterMs: wait,
    });
  });
  it('uses exponential secondary fallback capped at fifteen minutes', async () => {
    const f = setup(
      Array.from({ length: 6 }, () =>
        json({ message: 'secondary rate limit' }, 403),
      ),
    );
    for (const retryAfterMs of [
      60000, 120000, 240000, 480000, 900000, 900000,
    ]) {
      await expect(
        f.http.request('repos.get', params, { schema }),
      ).rejects.toMatchObject({ retryAfterMs });
      f.advance(retryAfterMs);
    }
  });
  it('checks safety evidence and rejects unapproved write fields', async () => {
    const f = setup([]);
    for (const [id, p] of [
      ['refs.delete', { ...params, ref: 'main' }],
      ['comments.delete', { ...params, id: 1 }],
      [
        'pulls.merge',
        {
          ...params,
          number: 1,
          body: { merge_method: 'merge', sha: 'a'.repeat(40) },
        },
      ],
      ['pulls.update', { ...params, number: 1, body: { base: 'main' } }],
      [
        'refs.create',
        { ...params, body: { ref: 'refs/heads/main', sha: 'a'.repeat(40) } },
      ],
    ] as const)
      await expect(
        f.http.request(id, p, { schema: emptySchema }),
      ).rejects.toMatchObject({ category: 'guard' });
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
