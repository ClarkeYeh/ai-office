import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createRedactor } from '@ai-office/redaction';
import { createGithubScm, RepoAllowlist } from '../index.js';
import { MERGE_VERIFY_ATTEMPTS } from './merge.js';
import { createPrMethods } from './pulls.js';

const repo = { owner: 'ClarkeYeh', name: 'ai-office-spike' };
const root = '/repos/ClarkeYeh/ai-office-spike';
const head = 'afc56c9bd427d5dedbf1b6582a9df010f498ee0e';
const baseSha = '1e6c7acab6fcd2ad2c50a045fcd5e28f01b6d00d';
const mergeSha = '110c57cf717783ed4d0b66638187956fce2f1f30';
const int = 'ai-office/t000000000001-int';
const pr8 = { repo, number: 8 };
const c = { workflowId: 'wf', commandId: 'cmd-1' };
const mark = '<!-- ai-office:cmd=cmd-1 -->';
const redactor = createRedactor();

type Reply = { status: number; response: unknown; etag?: string };
/** T1 recording envelope (fixtures/github/README.md); only status/body/etag replay. */
function recorded(file: string, patch?: (value: never) => unknown): Reply {
  const raw = JSON.parse(
    readFileSync(
      new URL(
        `../../../../../../fixtures/github/2022-11-28/${file}.json`,
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { status: number; response: unknown; headers: { etag?: string } };
  const response = structuredClone(raw.response);
  return {
    status: raw.status,
    response: patch ? (patch(response as never) ?? response) : response,
    ...(raw.headers.etag ? { etag: raw.headers.etag } : {}),
  };
}
const synthetic = (response: unknown, status = 200): Reply => ({
  status,
  response,
});
type Pull = {
  state: string;
  merged: boolean | null;
  body: string;
  head: { sha: string };
  base: { ref: string };
  merge_commit_sha: string | null;
};
const openPull = (edit: (pull: Pull) => void = () => {}) =>
  recorded('g3-mergeable.get-pr-clean', (pull: Pull) => {
    edit(pull);
  });
const mergedPull = (edit: (pull: Pull) => void = () => {}) =>
  recorded('g4-merge.get-pr-merged', (pull: Pull) => {
    edit(pull);
  });
const repoInfo = () => recorded('g5-protection.get-repo');
const intBranch = (edit: (b: { protected: boolean }) => void = () => {}) =>
  recorded(
    'g5-protection.get-branch-ai-office',
    (b: { protected: boolean }) => {
      edit(b);
    },
  );
const timeout = new TypeError('fetch failed');

/** Replays per `METHOD path` queue so each test states the exact calls. */
function setup(routes: Record<string, (Reply | Error)[]>) {
  let time = Date.parse('2026-11-19T05:00:00Z');
  const calls: { key: string; body?: unknown; ifNoneMatch: string | null }[] =
    [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? 'GET'} ${url.pathname.replace(root, '')}${url.search}`;
    calls.push({
      key,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      ifNoneMatch: new Headers(init?.headers).get('if-none-match'),
    });
    const next = routes[key]?.shift();
    if (!next) throw new Error(`Unexpected request ${key}`);
    if (next instanceof Error) throw next;
    return new Response(
      next.response === null ? null : JSON.stringify(next.response),
      {
        status: next.status,
        headers: next.etag ? { etag: next.etag } : {},
      },
    );
  });
  const sleeps: number[] = [];
  const base = createGithubScm({
    fetch,
    clock: { now: () => new Date(time) },
    sleep: async (ms) => {
      time += ms;
    },
    tokenProvider: async () => 'ghp_testcredential',
    repoAllowlist: new RepoAllowlist([repo]),
    maskSecrets: <T>(value: T): T => redactor.maskText(String(value)) as T,
  });
  const methods = createPrMethods(
    { http: base.http },
    {
      sleep: async (ms) => {
        sleeps.push(ms);
        time += ms;
      },
    },
  );
  const keys = () => calls.map((call) => call.key);
  return { ...methods, calls, keys, sleeps, routes };
}
const opts = { method: 'merge' as const, expectedHeadSha: head };
type Queue = (Reply | Error)[];
const branchKey = 'GET /branches/ai-office%2Ft000000000001-int';
const preMerge = (): Record<string, Queue> & {
  'GET /pulls/8': Queue;
  'GET ': Queue;
  [branchKey]: Queue;
} => ({
  'GET /pulls/8': [openPull()],
  'GET ': [repoInfo()],
  [branchKey]: [intBranch()],
});
const allConsumed = (routes: Record<string, unknown[]>) =>
  expect(Object.entries(routes).filter(([, queue]) => queue.length)).toEqual(
    [],
  );

describe('mergePR guards (SPEC rev2.15 §11.2)', () => {
  it('merges with merge_method merge at the expected head, then reads the base back', async () => {
    const routes = preMerge();
    routes['PUT /pulls/8/merge'] = [recorded('g4-merge.merge-200')];
    routes['GET /pulls/8'].push(mergedPull());
    const f = setup(routes);
    await expect(
      f.mergePR(pr8, { ...opts, expectedBaseSha: baseSha }),
    ).resolves.toEqual({ mergeCommitSha: mergeSha });
    expect(f.keys()).toEqual([
      'GET /pulls/8',
      'GET ',
      branchKey,
      'PUT /pulls/8/merge',
      'GET /pulls/8',
    ]);
    expect(f.calls[3]!.body).toEqual({ merge_method: 'merge', sha: head });
    // Safety evidence is always fetched fresh, never answered from the cache.
    expect(f.calls.every((call) => call.ifNoneMatch === null)).toBe(true);
    // G11: the read-back waits instead of reading immediately.
    expect(f.sleeps).toEqual([1_000]);
    allConsumed(routes);
  });
  it('bypasses an ETag cached by getPR for the safety reads', async () => {
    const routes = preMerge();
    routes['GET /pulls/8'].unshift(openPull());
    routes['PUT /pulls/8/merge'] = [recorded('g4-merge.merge-200')];
    routes['GET /pulls/8'].push(mergedPull());
    const f = setup(routes);
    await f.getPR(pr8);
    await f.mergePR(pr8, opts);
    expect(f.calls.slice(1).map((call) => call.ifNoneMatch)).toEqual(
      Array(5).fill(null),
    );
  });
  it.each([
    ['the default branch', 'main', 'default_branch_merge'],
    ['a non ai-office/ base', 'release', 'base_not_ai_office'],
  ])(
    'refuses %s judged by the actual base, before any write',
    async (_, base, code) => {
      const f = setup({
        'GET /pulls/8': [openPull((pull) => (pull.base.ref = base))],
        'GET ': [repoInfo()],
      });
      await expect(f.mergePR(pr8, opts)).rejects.toMatchObject({
        category: 'guard',
        code,
      });
      expect(f.keys()).not.toContain('PUT /pulls/8/merge');
    },
  );
  it('refuses a protected base (branches/{b}.protected, rulesets included)', async () => {
    const routes = preMerge();
    routes[branchKey] = [intBranch((b) => (b.protected = true))];
    const f = setup(routes);
    await expect(f.mergePR(pr8, opts)).rejects.toMatchObject({
      category: 'guard',
      code: 'protected_branch_merge',
    });
    expect(f.keys()).not.toContain('PUT /pulls/8/merge');
  });
  it('refuses any merge method other than merge without calling GitHub', async () => {
    const f = setup({});
    await expect(
      f.mergePR(pr8, { ...opts, method: 'squash' as 'merge' }),
    ).rejects.toMatchObject({
      category: 'guard',
      code: 'merge_method_not_allowed',
    });
    expect(f.calls).toEqual([]);
  });
  it('reports a moved head as non-retryable head_mismatch before merging', async () => {
    const f = setup({ 'GET /pulls/8': [openPull()], 'GET ': [repoInfo()] });
    await expect(
      f.mergePR(pr8, { ...opts, expectedHeadSha: 'a'.repeat(40) }),
    ).rejects.toMatchObject({
      category: 'conflict',
      code: 'head_mismatch',
      retryable: false,
    });
    expect(f.keys()).not.toContain('PUT /pulls/8/merge');
  });
  it('reports a moved integration branch as base_moved before merging', async () => {
    const routes = preMerge();
    const f = setup(routes);
    await expect(
      f.mergePR(pr8, { ...opts, expectedBaseSha: 'b'.repeat(40) }),
    ).rejects.toMatchObject({ category: 'conflict', code: 'base_moved' });
    expect(f.keys()).not.toContain('PUT /pulls/8/merge');
    allConsumed(routes);
  });
  it('refuses a closed, unmerged PR', async () => {
    const f = setup({
      'GET /pulls/8': [openPull((pull) => (pull.state = 'closed'))],
      'GET ': [repoInfo()],
    });
    await expect(f.mergePR(pr8, opts)).rejects.toMatchObject({
      category: 'conflict',
      code: 'not_mergeable',
    });
  });
  it('raises merge_base_changed when the PR base was retargeted during the merge', async () => {
    const routes = preMerge();
    routes['PUT /pulls/8/merge'] = [recorded('g4-merge.merge-200')];
    routes['GET /pulls/8'].push(
      mergedPull((pull) => (pull.base.ref = 'ai-office/other')),
    );
    const f = setup(routes);
    await expect(f.mergePR(pr8, opts)).rejects.toMatchObject({
      category: 'guard',
      code: 'merge_base_changed',
    });
  });
  it('short-polls until GitHub marks the PR merged (G11, ~3 s)', async () => {
    const routes = preMerge();
    routes['PUT /pulls/8/merge'] = [recorded('g4-merge.merge-200')];
    routes['GET /pulls/8'].push(openPull(), openPull(), mergedPull());
    const f = setup(routes);
    await expect(f.mergePR(pr8, opts)).resolves.toEqual({
      mergeCommitSha: mergeSha,
    });
    expect(f.sleeps).toEqual([1_000, 1_000, 1_000]);
    allConsumed(routes);
  });
  it('still checks the base when GitHub has not marked the PR merged in time', async () => {
    const routes = preMerge();
    routes['PUT /pulls/8/merge'] = [recorded('g4-merge.merge-200')];
    routes['GET /pulls/8'].push(
      ...Array.from({ length: MERGE_VERIFY_ATTEMPTS - 1 }, () => openPull()),
      openPull((pull) => (pull.base.ref = 'ai-office/other')),
    );
    const f = setup(routes);
    await expect(f.mergePR(pr8, opts)).rejects.toMatchObject({
      code: 'merge_base_changed',
    });
    expect(f.sleeps).toHaveLength(MERGE_VERIFY_ATTEMPTS);
  });
  it('returns retryable github_unavailable when no read-back succeeds; the retry finds the merge', async () => {
    const routes = preMerge();
    routes['PUT /pulls/8/merge'] = [recorded('g4-merge.merge-200')];
    routes['GET /pulls/8'].push(
      ...Array.from({ length: MERGE_VERIFY_ATTEMPTS }, () => timeout),
      mergedPull(),
    );
    routes['GET '].push(repoInfo());
    const f = setup(routes);
    await expect(f.mergePR(pr8, opts)).rejects.toMatchObject({
      category: 'transient',
      code: 'github_unavailable',
      retryable: true,
    });
    await expect(f.mergePR(pr8, opts)).resolves.toEqual({
      mergeCommitSha: mergeSha,
    });
    allConsumed(routes);
  });
});

describe('mergePR idempotency and recorded errors', () => {
  it('returns the original merge commit for an already merged PR without merging again', async () => {
    const f = setup({ 'GET /pulls/8': [mergedPull()], 'GET ': [repoInfo()] });
    await expect(f.mergePR(pr8, opts)).resolves.toEqual({
      mergeCommitSha: mergeSha,
    });
    expect(f.keys()).toEqual(['GET /pulls/8', 'GET ']);
  });
  it('rejects an already merged PR merged at another head', async () => {
    const f = setup({ 'GET /pulls/8': [mergedPull()], 'GET ': [repoInfo()] });
    await expect(
      f.mergePR(pr8, { ...opts, expectedHeadSha: 'c'.repeat(40) }),
    ).rejects.toMatchObject({ category: 'conflict', code: 'head_mismatch' });
  });
  it('still guards the base of an already merged PR', async () => {
    const f = setup({
      'GET /pulls/8': [mergedPull((pull) => (pull.base.ref = 'main'))],
      'GET ': [repoInfo()],
    });
    await expect(f.mergePR(pr8, opts)).rejects.toMatchObject({
      category: 'guard',
      code: 'default_branch_merge',
    });
  });
  it('retries a timed-out merge safely: the PR is found merged (G4)', async () => {
    const routes = preMerge();
    routes['PUT /pulls/8/merge'] = [timeout];
    routes['GET /pulls/8'].push(mergedPull());
    routes['GET '].push(repoInfo());
    const f = setup(routes);
    await expect(f.mergePR(pr8, opts)).rejects.toMatchObject({
      category: 'transient',
      code: 'github_unavailable',
      retryable: true,
    });
    await expect(f.mergePR(pr8, opts)).resolves.toEqual({
      mergeCommitSha: mergeSha,
    });
    expect(f.keys().filter((key) => key.startsWith('PUT'))).toHaveLength(1);
    allConsumed(routes);
  });
  it('retries a timed-out merge that GitHub had not applied: the second PUT is idempotent (G4)', async () => {
    const routes = preMerge();
    routes['PUT /pulls/8/merge'] = [
      timeout,
      recorded('g4-merge.already-merged-200'),
    ];
    routes['GET /pulls/8'].push(openPull(), mergedPull());
    routes['GET '].push(repoInfo());
    routes[branchKey].push(intBranch());
    const f = setup(routes);
    await expect(f.mergePR(pr8, opts)).rejects.toMatchObject({
      code: 'github_unavailable',
    });
    await expect(f.mergePR(pr8, opts)).resolves.toEqual({
      mergeCommitSha: mergeSha,
    });
    allConsumed(routes);
  });
  it.each([
    [
      'stale sha 409 (recorded)',
      () => recorded('g4-merge.stale-sha-409'),
      { category: 'conflict', code: 'head_mismatch', retryable: false },
    ],
    [
      'merge conflicts 405 (recorded)',
      () => recorded('g4-merge.conflict-405'),
      { category: 'conflict', code: 'not_mergeable' },
    ],
    [
      'rules 405',
      () =>
        synthetic(
          {
            message:
              'Repository rule violations found. Required status check "ci" is expected.',
          },
          405,
        ),
      { category: 'permanent', code: 'merge_blocked_by_rules' },
    ],
    [
      'base modified 405',
      () =>
        synthetic(
          {
            message:
              'Base branch was modified. Review and try the merge again.',
          },
          405,
        ),
      { category: 'conflict', code: 'base_moved', retryable: true },
    ],
  ])('maps %s', async (_, reply, expected) => {
    const routes = preMerge();
    routes['PUT /pulls/8/merge'] = [reply()];
    const f = setup(routes);
    await expect(f.mergePR(pr8, opts)).rejects.toMatchObject(expected);
  });
});

describe('openPR', () => {
  const draft = {
    title: 'w3',
    body: 'Refs #3',
    head: 'ai-office/t000000000001-w3',
    base: int,
  };
  const lookup = `GET /pulls?base=${encodeURIComponent(int)}&head=${encodeURIComponent('ClarkeYeh:ai-office/t000000000001-w3')}&page=1&per_page=100&state=open`;
  const listed = (body: string) =>
    recorded('g10-idempotency.lookup-pr-by-head', (list: Pull[]) => {
      list[0]!.body = body;
    });
  it('creates the PR with the command marker appended', async () => {
    const f = setup({ 'POST /pulls': [recorded('g3-mergeable.create-pr')] });
    await expect(f.openPR(repo, draft, c)).resolves.toEqual({
      repo,
      number: 8,
      url: 'https://github.com/ClarkeYeh/ai-office-spike/pull/8',
    });
    expect(f.calls[0]!.body).toEqual({ ...draft, body: `Refs #3\n\n${mark}` });
  });
  it('refuses a head outside ai-office/', async () => {
    const f = setup({});
    await expect(
      f.openPR(repo, { ...draft, head: 'feature/x' }, c),
    ).rejects.toMatchObject({ category: 'guard', code: 'pr_head_not_allowed' });
    expect(f.calls).toEqual([]);
  });
  it('adopts the existing open PR on the recorded duplicate 422 when it carries this marker (G10)', async () => {
    const f = setup({
      'POST /pulls': [recorded('g10-idempotency.duplicate-pr-422')],
      [lookup]: [listed(`Refs #3\n\n${mark}`)],
    });
    await expect(f.openPR(repo, draft, c)).resolves.toEqual({
      repo,
      number: 10,
      url: 'https://github.com/ClarkeYeh/ai-office-spike/pull/10',
    });
  });
  it('guards when the existing PR lacks this command marker', async () => {
    const f = setup({
      'POST /pulls': [recorded('g10-idempotency.duplicate-pr-422')],
      [lookup]: [listed('<!-- ai-office:cmd=cmd-other -->')],
    });
    await expect(f.openPR(repo, draft, c)).rejects.toMatchObject({
      category: 'guard',
      code: 'pr_exists_without_marker',
    });
  });
  it('a timed-out create is retryable github_unavailable; the retry adopts the PR via 422 (G10)', async () => {
    const f = setup({
      'POST /pulls': [timeout, recorded('g10-idempotency.duplicate-pr-422')],
      [lookup]: [listed(`Refs #3\n\n${mark}`)],
    });
    await expect(f.openPR(repo, draft, c)).rejects.toMatchObject({
      category: 'transient',
      code: 'github_unavailable',
      retryable: true,
    });
    await expect(f.openPR(repo, draft, c)).resolves.toMatchObject({
      number: 10,
    });
    expect(f.calls[1]!.body).toEqual(f.calls[0]!.body);
  });
  it('maps the recorded no-commits 422 to permanent validation without a lookup', async () => {
    const f = setup({
      'POST /pulls': [recorded('g10-idempotency.no-commits-pr-422')],
    });
    await expect(f.openPR(repo, draft, c)).rejects.toMatchObject({
      category: 'permanent',
      code: 'github_validation',
    });
    expect(f.calls).toHaveLength(1);
  });
});

describe('getPR', () => {
  it('reports an open PR without the test-merge sha GitHub fills in', async () => {
    const f = setup({ 'GET /pulls/8': [openPull()] });
    expect(await f.getPR(pr8)).toEqual({
      state: 'open',
      headSha: head,
      base: int,
    });
  });
  it('reports a merged PR with its merge commit and mergedBy', async () => {
    const f = setup({ 'GET /pulls/8': [mergedPull()] });
    expect(await f.getPR(pr8)).toEqual({
      state: 'merged',
      mergeCommitSha: mergeSha,
      headSha: head,
      base: int,
      mergedBy: 'ClarkeYeh',
    });
  });
  it('reports a closed, unmerged PR as closed', async () => {
    const f = setup({
      'GET /pulls/8': [recorded('g9-head-deleted.get-pr-closed')],
    });
    expect(await f.getPR(pr8)).toMatchObject({ state: 'closed' });
  });
  it('treats a missing consumed field as a contract mismatch', async () => {
    const f = setup({
      'GET /pulls/8': [synthetic({ number: 8, state: 'open' })],
    });
    await expect(f.getPR(pr8)).rejects.toMatchObject({
      category: 'contract_mismatch',
    });
  });
});

describe('updatePR and closePR', () => {
  it('patches title and body only, never the base', async () => {
    const f = setup({ 'PATCH /pulls/8': [synthetic({})] });
    await f.updatePR(pr8, {
      title: 'New',
      body: 'Text',
      base: 'main',
    } as never);
    expect(f.calls).toEqual([
      expect.objectContaining({
        key: 'PATCH /pulls/8',
        body: { title: 'New', body: 'Text' },
      }),
    ]);
  });
  it('reopens without a safety read', async () => {
    const f = setup({ 'PATCH /pulls/8': [synthetic({})] });
    await f.updatePR(pr8, { state: 'open' });
    expect(f.calls[0]!.body).toEqual({ state: 'open' });
  });
  it('closes a marked PR after a fresh read, before other fields change', async () => {
    const routes = {
      'GET /pulls/8': [openPull(), openPull((pull) => (pull.body = mark))],
      'PATCH /pulls/8': [synthetic({}), synthetic({})],
    };
    const f = setup(routes);
    await f.getPR(pr8);
    await f.updatePR(pr8, { state: 'closed', title: 'Done' });
    expect(f.calls.slice(1)).toEqual([
      { key: 'GET /pulls/8', ifNoneMatch: null },
      { key: 'PATCH /pulls/8', body: { state: 'closed' }, ifNoneMatch: null },
      { key: 'PATCH /pulls/8', body: { title: 'Done' }, ifNoneMatch: null },
    ]);
  });
  it('refuses to close a PR without an AI Office marker', async () => {
    const f = setup({ 'GET /pulls/8': [openPull((p) => (p.body = 'x'))] });
    await expect(f.closePR(pr8)).rejects.toMatchObject({
      category: 'guard',
      code: 'pr_close_not_allowed',
    });
    expect(f.keys()).toEqual(['GET /pulls/8']);
  });
  it('refuses to close a merged PR and skips an already closed one', async () => {
    const f = setup({
      'GET /pulls/8': [
        mergedPull((p) => (p.body = mark)),
        openPull((p) => {
          p.body = mark;
          p.state = 'closed';
        }),
      ],
    });
    await expect(f.closePR(pr8)).rejects.toMatchObject({
      category: 'conflict',
      code: 'pr_merged',
    });
    await f.closePR(pr8);
    expect(f.keys()).toEqual(['GET /pulls/8', 'GET /pulls/8']);
  });
});

describe('listReviewComments', () => {
  it('returns line comments and submitted review bodies from every author, oldest first', async () => {
    const user = (login: string) => ({ login, id: 1 });
    const f = setup({
      'GET /pulls/8/comments?page=1&per_page=100': [
        synthetic([
          {
            id: 11,
            user: user('ClarkeYeh'),
            body: 'Fix this',
            path: 'a.ts',
            line: null,
            original_line: 4,
            created_at: '2026-11-19T05:02:00Z',
          },
        ]),
      ],
      'GET /pulls/8/reviews?page=1&per_page=100': [
        synthetic([
          {
            id: 21,
            user: user('someone'),
            body: 'Looks off',
            submitted_at: '2026-11-19T05:01:00Z',
          },
          { id: 22, user: user('ClarkeYeh'), body: '', submitted_at: 'x' },
          { id: 23, user: null, body: 'Pending', submitted_at: null },
        ]),
      ],
    });
    expect(await f.listReviewComments(pr8)).toEqual([
      {
        id: 'review-21',
        author: 'someone',
        body: 'Looks off',
        path: '',
        line: null,
        occurredAt: '2026-11-19T05:01:00Z',
      },
      {
        id: '11',
        author: 'ClarkeYeh',
        body: 'Fix this',
        path: 'a.ts',
        line: 4,
        occurredAt: '2026-11-19T05:02:00Z',
      },
    ]);
  });
});
