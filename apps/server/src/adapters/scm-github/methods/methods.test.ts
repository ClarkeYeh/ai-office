import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bodyHash } from '@ai-office/domain';
import { FakeClock } from '../../../test-support/services.js';
import {
  CREATE_PENDING_WINDOW_MS,
  CREATE_RETRY_AFTER_MS,
} from '../../../ports/scm.js';
import { createGithubScm, RepoAllowlist, type GithubFetch } from '../index.js';

const repo = { owner: 'ClarkeYeh', name: 'ai-office-spike' };
const base = '/repos/ClarkeYeh/ai-office-spike';
const sha = 'a'.repeat(40);
const correlation = { workflowId: 'workflow', commandId: 'test-command' };
const marker = '<!-- ai-office:cmd=test-command -->';
const target = { repo, number: 4 };
const issue = {
  number: 4,
  html_url: 'https://github.com/ClarkeYeh/ai-office-spike/issues/4',
  body: marker,
  user: { login: 'ClarkeYeh' },
  updated_at: '2026-11-19T05:20:00Z',
  labels: [],
};
const comment = {
  id: 23,
  html_url: `${issue.html_url}#issuecomment-23`,
  issue_url: `https://api.github.com${base}/issues/4`,
  body: marker,
  user: { login: 'ClarkeYeh' },
};
type Step = {
  method?: string;
  path: string;
  data?: unknown;
  status?: number;
  headers?: Record<string, string>;
  check?: (url: URL, init: RequestInit) => void;
  lost?: boolean;
};
function fixture(name: string): {
  response: unknown;
  status: number;
  headers: Record<string, string>;
} {
  return JSON.parse(
    readFileSync(
      new URL(
        `../../../../../../fixtures/github/2022-11-28/${name}.json`,
        import.meta.url,
      ),
      'utf8',
    ),
  );
}
function recorded(path: string, name: string, method = 'GET'): Step {
  const value = fixture(name);
  return {
    path,
    method,
    data: value.response,
    status: value.status,
    headers: value.headers,
  };
}
function setup(steps: Step[], registered = true) {
  const clock = new FakeClock('2026-11-19T05:20:00Z');
  const requests: { url: URL; init: RequestInit }[] = [];
  const fetch: GithubFetch = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    const step = steps.shift();
    expect(step, `Unexpected ${init.method} ${url.pathname}`).toBeDefined();
    expect(url.pathname).toBe(step!.path);
    expect(init.method).toBe(step!.method ?? 'GET');
    step!.check?.(url, init);
    if (step!.lost) throw new Error('Lost response');
    return new Response(
      step!.status === 204 ? null : JSON.stringify(step!.data),
      { status: step!.status ?? 200, headers: step!.headers ?? {} },
    );
  };
  const scm = createGithubScm({
    fetch,
    clock,
    sleep: async (ms) => {
      clock.advance(ms);
    },
    repoAllowlist: new RepoAllowlist(registered ? [repo] : []),
    tokenProvider: async () => 'test',
    maskSecrets: (value) => value,
    registeredAt: () => '2026-11-19T05:00:00Z',
  });
  return { scm, clock, requests, done: () => expect(steps).toEqual([]) };
}
const viewer: Step = { path: '/user', data: { login: 'ClarkeYeh' } };
const notFound = (path: string): Step => ({
  path,
  status: 404,
  data: { message: 'Not Found' },
});
const fresh = (_url: URL, init: RequestInit) =>
  expect(new Headers(init.headers).has('if-none-match')).toBe(false);
function inspection(): Step[] {
  return [
    recorded(base, 'g5-protection.get-repo'),
    viewer,
    recorded(`${base}/branches/main`, 'g5-protection.get-branch-main'),
    recorded(`${base}/rules/branches/main`, 'g5-protection.rules-main'),
    recorded(`${base}/branches/main/protection`, 'g5-protection.classic-404'),
    recorded(
      `${base}/rules/branches/ai-office%2Fprotection-probe`,
      'g5-protection.rules-ai-office-branch',
    ),
  ];
}

describe('GitHub T4 methods through the HTTP boundary (offline)', () => {
  it('assembles the real poller with shared cached repository and viewer dependencies', async () => {
    const round: Step[] = [
      { path: `${base}/issues`, data: [] },
      { path: `${base}/issues/comments`, data: [] },
      { path: `${base}/pulls`, data: [] },
      { path: `${base}/git/matching-refs/heads/ai-office/`, data: [] },
      {
        path: `${base}/git/ref/heads/main`,
        data: { ref: 'refs/heads/main', object: { sha } },
      },
    ];
    const f = setup([...inspection(), ...round, ...round]);
    const first = await f.scm.poll(repo, null);
    expect(first.events).toEqual([
      expect.objectContaining({
        type: 'branch.head_changed',
        branch: 'main',
        sha,
        previousSha: null,
      }),
    ]);
    expect((await f.scm.poll(repo, first.cursor)).events).toEqual([]);
    f.done();
  });
  it('does not consume the visibility window while a create waits in the transport queue', async () => {
    const f = setup([
      {
        path: `${base}/issues`,
        method: 'POST',
        lost: true,
        check: () => f.clock.advance(CREATE_PENDING_WINDOW_MS * 2),
      },
      viewer,
      { path: `${base}/issues`, data: [] },
    ]);
    const call = () =>
      f.scm.createIssue(
        repo,
        { title: 'title', body: '', labels: [] },
        correlation,
      );
    await expect(call()).rejects.toMatchObject({
      code: 'create_outcome_unknown',
    });
    await expect(call()).rejects.toMatchObject({
      code: 'create_outcome_unknown',
    });
    f.done();
  });
  it('does not hide unfinished PR integration behind successful no-ops', async () => {
    const f = setup([]);
    await expect(f.scm.getPR(target)).rejects.toMatchObject({
      category: 'bug',
      code: 'not_implemented',
    });
    f.done();
  });
  it('creates a comment using the recorded response and exact command marker', async () => {
    const step = recorded(
      `${base}/issues/4/comments`,
      'g1-body.create-comment',
      'POST',
    );
    step.check = (_url, init) =>
      expect(JSON.parse(String(init.body))).toEqual({
        body: `decision\n\n${marker}`,
      });
    const f = setup([step]);
    await f.scm.comment(target, 'decision', correlation);
    f.done();
  });
  it.each([true, false])(
    'only accepts a delete 422 when a fresh read proves absence (%s)',
    async (absent) => {
      const path = `${base}/branches/ai-office%2Fx`;
      const f = setup([
        { path: base, data: { default_branch: 'main' } },
        { path, data: { protected: false } },
        {
          path: `${base}/git/refs/heads/ai-office%2Fx`,
          method: 'DELETE',
          status: 422,
          data: { message: 'Reference does not exist' },
        },
        absent
          ? { ...notFound(path), check: fresh }
          : { path, data: { protected: false }, check: fresh },
      ]);
      if (absent) await f.scm.deleteBranch(repo, 'ai-office/x');
      else
        await expect(
          f.scm.deleteBranch(repo, 'ai-office/x'),
        ).rejects.toMatchObject({ code: 'github_validation' });
      f.done();
    },
  );
  it('inspects recorded ruleset protection even when classic protection is absent; inspection grants no writes', async () => {
    const f = setup(inspection(), false);
    expect(await f.scm.inspectRepo(repo)).toMatchObject({
      defaultBranch: 'main',
      defaultBranchProtected: true,
      allowMergeCommit: true,
      viewerLogin: 'ClarkeYeh',
      warnings: [],
    });
    await expect(f.scm.ensureLabels(repo, [])).rejects.toMatchObject({
      category: 'guard',
    });
    f.done();
  });
  it('reports all registration warnings and uses branch protected as the main signal', async () => {
    const steps = inspection();
    const data = fixture('g5-protection.get-repo').response as Record<
      string,
      unknown
    >;
    steps[0]!.data = {
      ...data,
      archived: true,
      permissions: { push: false },
      allow_merge_commit: false,
    };
    steps[2]!.data = { protected: false };
    steps[3]!.data = [
      {
        type: 'pull_request',
        parameters: { required_approving_review_count: 1 },
      },
    ];
    steps.splice(4, 1);
    steps[4]!.data = [
      {
        type: 'pull_request',
        parameters: { allowed_merge_methods: ['squash'] },
      },
    ];
    const f = setup(steps);
    expect((await f.scm.inspectRepo(repo)).warnings).toEqual([
      'default_unprotected',
      'default_requires_approvals',
      'ai_office_branches_ruled',
      'merge_commit_disabled',
      'no_push_permission',
      'archived',
    ]);
    f.done();
  });
  it('returns unknown protection on forbidden branch detail without weakening malformed JSON validation', async () => {
    const steps = inspection();
    steps[2] = {
      path: `${base}/branches/main`,
      status: 403,
      data: { message: 'Forbidden' },
    };
    steps.splice(4, 1);
    const f = setup(steps);
    expect(await f.scm.inspectRepo(repo)).toMatchObject({
      defaultBranchProtected: 'unknown',
      warnings: ['default_protection_unknown'],
    });
    f.done();
    const malformed = setup([{ path: base, data: { default_branch: 'main' } }]);
    await expect(malformed.scm.inspectRepo(repo)).rejects.toMatchObject({
      category: 'contract_mismatch',
    });
  });
  it('reads health and caches viewer identity', async () => {
    const rate = recorded('/rate_limit', 'g8-headers.rate-limit');
    const f = setup([viewer, rate, rate]);
    expect(await f.scm.health()).toMatchObject({
      available: true,
      viewerLogin: 'ClarkeYeh',
    });
    await f.scm.health();
    f.done();
  });
  it('creates only missing labels and never edits existing ones', async () => {
    const f = setup([
      { path: `${base}/labels`, data: [{ name: 'Existing' }] },
      {
        path: `${base}/labels`,
        method: 'POST',
        data: {},
        check: (_u, init) =>
          expect(JSON.parse(String(init.body))).toEqual({
            name: 'New',
            color: 'abcdef',
          }),
      },
      { path: `${base}/issues/4/labels`, method: 'PUT', data: [] },
    ]);
    await f.scm.ensureLabels(repo, [
      { name: 'existing', color: 'ffffff' },
      { name: 'New', color: 'abcdef' },
      { name: 'New', color: 'abcdef' },
    ]);
    await f.scm.setLabels(target, ['New']);
    f.done();
  });
  it('creates a slash-encoded ref and treats existing refs as immutable (recorded race response)', async () => {
    const ref = `${base}/git/ref/heads/ai-office%2Fx`;
    const f = setup([
      ...inspection(),
      notFound(ref),
      { path: `${base}/git/ref/heads/main`, data: { object: { sha } } },
      recorded(`${base}/git/refs`, 'g10-idempotency.duplicate-ref-422', 'POST'),
      { path: ref, data: { object: { sha } } },
      { path: ref, data: { object: { sha } } },
    ]);
    await f.scm.ensureBranch(repo, 'ai-office/x', 'main', correlation);
    await f.scm.ensureBranch(
      repo,
      'ai-office/x',
      'nonexistent-source',
      correlation,
    );
    f.done();
  });
  it('accepts a pinned SHA without resolving it as a branch', async () => {
    const f = setup([
      ...inspection(),
      notFound(`${base}/git/ref/heads/ai-office%2Fx`),
      recorded(`${base}/git/refs`, 'g10-idempotency.create-ref-201', 'POST'),
    ]);
    await f.scm.ensureBranch(repo, 'ai-office/x', sha, correlation);
    f.done();
  });
  it('fetches deletion evidence fresh even after a cached inspection; deletion is idempotent', async () => {
    const f = setup([
      ...inspection(),
      { path: base, data: { default_branch: 'main' }, check: fresh },
      {
        path: `${base}/branches/ai-office%2Fx`,
        data: { protected: false },
        check: fresh,
      },
      recorded(
        `${base}/git/refs/heads/ai-office%2Fx`,
        'g9-head-deleted.delete-ref-204',
        'DELETE',
      ),
      { path: base, data: { default_branch: 'main' }, check: fresh },
      notFound(`${base}/branches/ai-office%2Fx`),
    ]);
    await f.scm.inspectRepo(repo);
    await f.scm.deleteBranch(repo, 'ai-office/x');
    await f.scm.deleteBranch(repo, 'ai-office/x');
    f.done();
  });
  it.each(['main', 'feature/x'])(
    'rejects deleting %s before network access',
    async (name) => {
      const f = setup([]);
      await expect(f.scm.deleteBranch(repo, name)).rejects.toMatchObject({
        category: 'guard',
      });
      f.done();
    },
  );
  it('rejects a protected branch and a newly changed default branch', async () => {
    for (const changed of [false, true]) {
      const f = setup([
        {
          path: base,
          data: { default_branch: changed ? 'ai-office/x' : 'main' },
        },
        ...(changed
          ? []
          : [
              {
                path: `${base}/branches/ai-office%2Fx`,
                data: { protected: true },
              },
            ]),
      ]);
      await expect(
        f.scm.deleteBranch(repo, 'ai-office/x'),
      ).rejects.toMatchObject({ category: 'guard' });
      f.done();
    }
  });
  it('compares branches using the actual head, handles equal and missing refs', async () => {
    const f = setup([
      { path: `${base}/compare/${sha}...ai-office%2Fx`, data: { ahead_by: 3 } },
      {
        path: `${base}/git/ref/heads/ai-office%2Fx`,
        data: { object: { sha } },
      },
      {
        path: `${base}/git/ref/heads/ai-office%2Fx`,
        data: { object: { sha } },
      },
      notFound(`${base}/git/ref/heads/missing`),
    ]);
    expect(await f.scm.compareBranch(repo, sha, 'ai-office/x')).toEqual({
      ahead: 3,
      headSha: sha,
    });
    expect(
      await f.scm.compareBranch(repo, 'ai-office/x', 'ai-office/x'),
    ).toEqual({ ahead: 0, headSha: sha });
    expect(await f.scm.compareBranch(repo, 'missing', 'missing')).toBeNull();
    f.done();
  });
  it('uses recorded issue create/read/update responses and the shared CRLF hash', async () => {
    const created = recorded(`${base}/issues`, 'g1-body.create-issue', 'POST');
    created.check = (_u, init) =>
      expect(JSON.parse(String(init.body)).body).toBe(
        `decision\r\n\n\n${marker}`,
      );
    const f = setup([
      created,
      recorded(`${base}/issues/4`, 'g1-body.get-issue'),
      recorded(`${base}/issues/4`, 'g1-body.patch-issue-crlf', 'PATCH'),
    ]);
    expect(
      await f.scm.createIssue(
        repo,
        { title: 'Decision', body: 'decision\r\n', labels: [] },
        correlation,
      ),
    ).toEqual({ ...target, url: issue.html_url });
    const result = await f.scm.getIssue(target);
    expect(result.bodyHash).toBe(bodyHash(result.body));
    await f.scm.updateIssue(target, { body: 'new\r\nbody' });
    f.done();
  });
  it('maps nullable bodies and string/object labels without silently dropping invalid used fields', async () => {
    const f = setup([
      {
        path: `${base}/issues/4`,
        data: { ...issue, body: null, labels: ['a', { name: 'b' }] },
      },
      { path: `${base}/issues/4`, data: { ...issue, labels: [{ name: 42 }] } },
    ]);
    expect(await f.scm.getIssue(target)).toMatchObject({
      body: '',
      bodyHash: bodyHash(''),
      labels: ['a', 'b'],
    });
    await expect(f.scm.getIssue(target)).rejects.toMatchObject({
      category: 'contract_mismatch',
    });
    f.done();
  });
  it.each(['issue', 'comment'] as const)(
    'waits through delayed %s visibility and serializes simultaneous retries',
    async (kind) => {
      const createPath =
        kind === 'issue' ? `${base}/issues` : `${base}/issues/4/comments`;
      const listPath =
        kind === 'issue' ? `${base}/issues` : `${base}/issues/comments`;
      const f = setup([
        { path: createPath, method: 'POST', lost: true },
        viewer,
        {
          path: listPath,
          data: [],
          check: (url, init) => {
            fresh(url, init);
            expect(url.searchParams.get('since')).toBe(
              '2026-11-19T05:10:00.000Z',
            );
          },
        },
        { path: listPath, data: [kind === 'issue' ? issue : comment] },
      ]);
      const call = () =>
        kind === 'issue'
          ? f.scm.createIssue(
              repo,
              { title: 'title', body: 'body', labels: [] },
              correlation,
            )
          : f.scm.comment(target, 'body', correlation);
      await expect(call()).rejects.toMatchObject({
        code: 'create_outcome_unknown',
        category: 'transient',
        retryAfterMs: CREATE_RETRY_AFTER_MS,
      });
      f.clock.advance(CREATE_RETRY_AFTER_MS);
      const concurrent = await Promise.allSettled([call(), call()]);
      expect(concurrent.every((result) => result.status === 'rejected')).toBe(
        true,
      );
      f.clock.advance(CREATE_RETRY_AFTER_MS);
      await call();
      await call();
      expect(
        f.requests.filter((request) => request.init.method === 'POST'),
      ).toHaveLength(1);
      f.done();
    },
  );
  it.each(['issue', 'comment'] as const)(
    'only recreates %s after the pending window, restarting the window after another ambiguous result',
    async (kind) => {
      const createPath =
        kind === 'issue' ? `${base}/issues` : `${base}/issues/4/comments`;
      const listPath =
        kind === 'issue' ? `${base}/issues` : `${base}/issues/comments`;
      const f = setup([
        { path: createPath, method: 'POST', status: 503, data: {} },
        viewer,
        { path: listPath, data: [] },
        { path: createPath, method: 'POST', lost: true },
        { path: listPath, data: [] },
        { path: listPath, data: [] },
        {
          path: createPath,
          method: 'POST',
          data: kind === 'issue' ? issue : comment,
          status: 201,
        },
      ]);
      const call = () =>
        kind === 'issue'
          ? f.scm.createIssue(
              repo,
              { title: 'title', body: 'body', labels: [] },
              correlation,
            )
          : f.scm.comment(target, 'body', correlation);
      await expect(call()).rejects.toMatchObject({
        code: 'create_outcome_unknown',
      });
      f.clock.advance(CREATE_PENDING_WINDOW_MS);
      await expect(call()).rejects.toMatchObject({
        code: 'create_outcome_unknown',
      });
      f.clock.advance(CREATE_RETRY_AFTER_MS);
      await expect(call()).rejects.toMatchObject({
        code: 'create_outcome_unknown',
      });
      f.clock.advance(CREATE_PENDING_WINDOW_MS);
      await call();
      f.done();
    },
  );
  it('does not swallow permanent create errors or marker scan failures', async () => {
    const f = setup([
      { path: `${base}/issues`, method: 'POST', status: 403, data: {} },
      { path: `${base}/issues`, method: 'POST', lost: true },
      viewer,
      { path: `${base}/issues`, status: 503, data: {} },
    ]);
    const call = () =>
      f.scm.createIssue(
        repo,
        { title: 'title', body: 'body', labels: [] },
        correlation,
      );
    await expect(call()).rejects.toMatchObject({ category: 'permanent' });
    await expect(call()).rejects.toMatchObject({
      code: 'create_outcome_unknown',
    });
    await expect(call()).rejects.toMatchObject({ code: 'github_unavailable' });
    f.done();
  });
  it('scans all pages with exact markers, hint kind, ten-minute slack, real URLs and minimum keeper', async () => {
    const f = setup([
      viewer,
      {
        path: `${base}/issues`,
        data: [
          { ...issue, number: 9 },
          {
            ...issue,
            number: 2,
            body: '<!-- ai-office:cmd=test-command-extra -->',
          },
          { ...issue, number: 1, user: { login: 'stranger' } },
        ],
        headers: {
          link: `<https://api.github.com${base}/issues?creator=ClarkeYeh&direction=asc&since=2026-11-19T05%3A10%3A00.000Z&sort=created&state=all&page=2&per_page=100>; rel="next"`,
        },
        check: (url) => {
          expect(url.searchParams.get('since')).toBe(
            '2026-11-19T05:10:00.000Z',
          );
          expect(url.searchParams.get('creator')).toBe('ClarkeYeh');
        },
      },
      {
        path: `${base}/issues`,
        data: [{ ...issue, pull_request: {} }, issue],
        check: (url) => expect(url.searchParams.get('page')).toBe('2'),
      },
    ]);
    expect(
      await f.scm.findByMarker(repo, correlation.commandId, {
        kind: 'issue',
        since: '2026-11-19T05:20:00Z',
      }),
    ).toEqual({ ...target, kind: 'issue', url: issue.html_url, duplicates: 1 });
    f.done();
  });
  it('finds PR and comment markers, and falls back to registration time', async () => {
    const f = setup([
      viewer,
      {
        path: `${base}/issues`,
        data: [{ ...issue, pull_request: {} }],
        check: (url) =>
          expect(url.searchParams.get('since')).toBe(
            '2026-11-19T04:50:00.000Z',
          ),
      },
      {
        path: `${base}/issues/comments`,
        data: [comment, { ...comment, id: 25 }],
      },
      { path: `${base}/issues`, data: [] },
      { path: `${base}/issues/comments`, data: [] },
    ]);
    expect(
      await f.scm.findByMarker(repo, correlation.commandId, { kind: 'pr' }),
    ).toMatchObject({ kind: 'pr', url: issue.html_url });
    expect(
      await f.scm.findByMarker(repo, correlation.commandId, {
        kind: 'comment',
      }),
    ).toMatchObject({
      kind: 'comment',
      commentId: '23',
      url: comment.html_url,
      duplicates: 1,
    });
    expect(await f.scm.findByMarker(repo, 'missing')).toBeNull();
    f.done();
  });
  it('rejects malformed scan timestamps and cross-repository comment references', async () => {
    const f = setup([
      viewer,
      {
        path: `${base}/issues/comments`,
        data: [
          {
            ...comment,
            issue_url: 'https://api.github.com/repos/other/repo/issues/4',
          },
        ],
      },
    ]);
    await expect(
      f.scm.findByMarker(repo, 'x', { since: 'invalid' }),
    ).rejects.toMatchObject({ category: 'guard' });
    await expect(
      f.scm.findByMarker(repo, correlation.commandId, { kind: 'comment' }),
    ).rejects.toMatchObject({ category: 'contract_mismatch' });
    f.done();
  });
  it('deletes only freshly fetched own marked comments on the target; absent is success', async () => {
    const f = setup([
      viewer,
      {
        path: `${base}/issues/comments/23`,
        data: comment,
        headers: { etag: '"comment"' },
        check: fresh,
      },
      { path: `${base}/issues/comments/23`, method: 'DELETE', status: 204 },
      { ...notFound(`${base}/issues/comments/23`), check: fresh },
    ]);
    await f.scm.deleteComment(target, '23');
    await f.scm.deleteComment(target, '23');
    f.done();
  });
  it.each([
    { ...comment, user: { login: 'someone-else' } },
    { ...comment, body: 'unmarked' },
    { ...comment, issue_url: `https://api.github.com${base}/issues/5` },
    { ...comment, id: 24 },
  ])('refuses unsafe comment deletion', async (data) => {
    const f = setup([viewer, { path: `${base}/issues/comments/23`, data }]);
    await expect(f.scm.deleteComment(target, '23')).rejects.toMatchObject({
      category: 'guard',
    });
    f.done();
  });
  it('rejects every implemented write for an unregistered repository before network access', async () => {
    const f = setup([], false);
    const calls = [
      () =>
        f.scm.createIssue(
          repo,
          { title: 't', body: '', labels: [] },
          correlation,
        ),
      () => f.scm.comment(target, '', correlation),
      () => f.scm.updateIssue(target, { state: 'closed' }),
      () => f.scm.setLabels(target, []),
      () => f.scm.ensureLabels(repo, []),
      () => f.scm.ensureBranch(repo, 'ai-office/x', sha, correlation),
      () => f.scm.deleteBranch(repo, 'ai-office/x'),
      () => f.scm.deleteComment(target, '23'),
    ];
    for (const call of calls)
      await expect(call()).rejects.toMatchObject({
        category: 'guard',
        code: 'repo_not_allowed',
      });
    f.done();
  });
});
