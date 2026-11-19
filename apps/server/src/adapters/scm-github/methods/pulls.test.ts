import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createRedactor } from '@ai-office/redaction';
import { createGithubScm, RepoAllowlist } from '../index.js';
import { MERGE_VERIFY_DELAYS_MS } from './merge.js';
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
const merges = 'POST /merges';
/** G11 recording: the /merges commit, later reported as the PR's merge commit. */
const g11Sha = '5a19b8eb3483a6850896f9a9471a11c857dbab06';
const g11Merged = () =>
  recorded('g11-merges.get-pr-merged', (pull: Pull) => {
    pull.head.sha = head;
    pull.base.ref = int;
  });
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
const total = (sleeps: number[]) => sleeps.reduce((a, b) => a + b, 0);

describe('mergePR guards (SPEC rev2.15 §11.2)', () => {
  it('merges via POST /merges naming the checked base, then waits for GitHub to mark the PR merged (G11)', async () => {
    const routes = preMerge();
    routes[merges] = [recorded('g11-merges.merges-201')];
    routes['GET /pulls/8'].push(g11Merged());
    const f = setup(routes);
    await expect(
      f.mergePR(pr8, { ...opts, expectedBaseSha: baseSha }),
    ).resolves.toEqual({ mergeCommitSha: g11Sha });
    expect(f.keys()).toEqual([
      'GET /pulls/8',
      'GET ',
      branchKey,
      merges,
      'GET /pulls/8',
    ]);
    expect(f.calls[3]!.body).toEqual({
      base: int,
      head,
      commit_message:
        '[aio-test 000000000001] g3-w1 (#8)\n\n<!-- ai-office:pr=8 -->',
    });
    // Safety evidence is always fetched fresh, never answered from the cache.
    expect(f.calls.every((call) => call.ifNoneMatch === null)).toBe(true);
    expect(f.sleeps).toEqual([500]);
    allConsumed(routes);
  });
  it('bypasses an ETag cached by getPR for the safety reads', async () => {
    const routes = preMerge();
    routes['GET /pulls/8'].unshift(openPull());
    routes[merges] = [recorded('g11-merges.merges-201')];
    routes['GET /pulls/8'].push(g11Merged());
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
      expect(f.keys()).not.toContain(merges);
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
    expect(f.keys()).not.toContain(merges);
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
    expect(f.keys()).not.toContain(merges);
  });
  it('reports a moved integration branch as base_moved before merging', async () => {
    const routes = preMerge();
    const f = setup(routes);
    await expect(
      f.mergePR(pr8, { ...opts, expectedBaseSha: 'b'.repeat(40) }),
    ).rejects.toMatchObject({ category: 'conflict', code: 'base_moved' });
    expect(f.keys()).not.toContain(merges);
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
  it('TOCTOU: a base retargeted after the read cannot redirect the merge; the read-back flags it', async () => {
    const routes = preMerge();
    routes[merges] = [recorded('g11-merges.merges-201')];
    // e.g. `gh pr edit --base main` between the read and the merge.
    routes['GET /pulls/8'].push(openPull((pull) => (pull.base.ref = 'main')));
    const f = setup(routes);
    await expect(f.mergePR(pr8, opts)).rejects.toMatchObject({
      category: 'guard',
      code: 'merge_base_changed',
    });
    expect(f.calls.find((call) => call.key === merges)!.body).toMatchObject({
      base: int,
    });
  });
  it('short-polls with backoff until GitHub marks the PR merged', async () => {
    const routes = preMerge();
    routes[merges] = [recorded('g11-merges.merges-201')];
    routes['GET /pulls/8'].push(openPull(), openPull(), g11Merged());
    const f = setup(routes);
    await expect(f.mergePR(pr8, opts)).resolves.toEqual({
      mergeCommitSha: g11Sha,
    });
    expect(f.sleeps).toEqual([500, 1_000, 1_500]);
    allConsumed(routes);
  });
  it('guards pr_not_marked_merged after 10 s without falling back to PUT pulls/{n}/merge', async () => {
    const routes = preMerge();
    routes[merges] = [recorded('g11-merges.merges-201')];
    routes['GET /pulls/8'].push(
      ...MERGE_VERIFY_DELAYS_MS.map(() => openPull()),
    );
    const f = setup(routes);
    await expect(f.mergePR(pr8, opts)).rejects.toMatchObject({
      category: 'guard',
      code: 'pr_not_marked_merged',
    });
    expect(total(f.sleeps)).toBe(10_000);
    expect(f.keys().filter((key) => !key.startsWith('GET'))).toEqual([merges]);
    allConsumed(routes);
  });
  it('returns retryable github_unavailable when no read-back succeeds; the retry finds the merge', async () => {
    const routes = preMerge();
    routes[merges] = [recorded('g11-merges.merges-201')];
    routes['GET /pulls/8'].push(
      ...MERGE_VERIFY_DELAYS_MS.map(() => timeout),
      g11Merged(),
    );
    routes['GET '].push(repoInfo());
    const f = setup(routes);
    await expect(f.mergePR(pr8, opts)).rejects.toMatchObject({
      category: 'transient',
      code: 'github_unavailable',
      retryable: true,
    });
    await expect(f.mergePR(pr8, opts)).resolves.toEqual({
      mergeCommitSha: g11Sha,
    });
    allConsumed(routes);
  });
});

describe('mergePR expectedBase (our record, S20)', () => {
  const other = 'ai-office/t000000000002-int';
  it('merges into expectedBase by name and verifies against it', async () => {
    const routes = preMerge();
    routes[merges] = [recorded('g11-merges.merges-201')];
    routes['GET /pulls/8'].push(g11Merged());
    const f = setup(routes);
    await expect(
      f.mergePR(pr8, { ...opts, expectedBase: int }),
    ).resolves.toEqual({ mergeCommitSha: g11Sha });
    expect(f.calls.find((call) => call.key === merges)!.body).toMatchObject({
      base: int,
    });
    allConsumed(routes);
  });
  it('refuses a PR retargeted to another ai-office/ branch as non-retryable base_mismatch, without merging', async () => {
    const f = setup({
      'GET /pulls/8': [openPull((pull) => (pull.base.ref = other))],
      'GET ': [repoInfo()],
    });
    await expect(
      f.mergePR(pr8, { ...opts, expectedBase: int }),
    ).rejects.toMatchObject({
      category: 'conflict',
      code: 'base_mismatch',
      retryable: false,
    });
    expect(f.keys()).toEqual(['GET /pulls/8', 'GET ']);
  });
  it('refuses an already merged PR whose base is not expectedBase', async () => {
    const f = setup({
      'GET /pulls/8': [mergedPull((pull) => (pull.base.ref = other))],
      'GET ': [repoInfo()],
    });
    await expect(
      f.mergePR(pr8, { ...opts, expectedBase: int }),
    ).rejects.toMatchObject({ category: 'conflict', code: 'base_mismatch' });
  });
  it.each([
    ['main', 'default_branch_merge'],
    ['release', 'base_not_ai_office'],
  ])('guards an expectedBase of %s', async (expectedBase, code) => {
    const f = setup({ 'GET /pulls/8': [openPull()], 'GET ': [repoInfo()] });
    await expect(
      f.mergePR(pr8, { ...opts, expectedBase }),
    ).rejects.toMatchObject({ category: 'guard', code });
    expect(f.keys()).not.toContain(merges);
  });
  it('flags a retarget after the read against expectedBase', async () => {
    const routes = preMerge();
    routes[merges] = [recorded('g11-merges.merges-201')];
    routes['GET /pulls/8'].push(openPull((pull) => (pull.base.ref = other)));
    const f = setup(routes);
    await expect(
      f.mergePR(pr8, { ...opts, expectedBase: int }),
    ).rejects.toMatchObject({ category: 'guard', code: 'merge_base_changed' });
  });
});

describe('mergePR idempotency and recorded responses', () => {
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
  it('treats the recorded 204 (head already in base) as idempotent and returns the PR merge commit', async () => {
    const routes = preMerge();
    routes[merges] = [recorded('g11-merges.merges-again-204')];
    routes['GET /pulls/8'].push(openPull(), g11Merged());
    const f = setup(routes);
    await expect(f.mergePR(pr8, opts)).resolves.toEqual({
      mergeCommitSha: g11Sha,
    });
    allConsumed(routes);
  });
  it('retries a timed-out /merges safely: the PR is found merged', async () => {
    const routes = preMerge();
    routes[merges] = [timeout];
    routes['GET /pulls/8'].push(g11Merged());
    routes['GET '].push(repoInfo());
    const f = setup(routes);
    await expect(f.mergePR(pr8, opts)).rejects.toMatchObject({
      category: 'transient',
      code: 'github_unavailable',
      retryable: true,
    });
    await expect(f.mergePR(pr8, opts)).resolves.toEqual({
      mergeCommitSha: g11Sha,
    });
    expect(f.keys().filter((key) => key === merges)).toHaveLength(1);
    allConsumed(routes);
  });
  it('retries a timed-out /merges whose PR is not marked yet: the repeat answers 204', async () => {
    const routes = preMerge();
    routes[merges] = [timeout, recorded('g11-merges.merges-again-204')];
    routes['GET /pulls/8'].push(openPull(), g11Merged());
    routes['GET '].push(repoInfo());
    routes[branchKey].push(intBranch());
    const f = setup(routes);
    await expect(f.mergePR(pr8, opts)).rejects.toMatchObject({
      code: 'github_unavailable',
    });
    await expect(f.mergePR(pr8, opts)).resolves.toEqual({
      mergeCommitSha: g11Sha,
    });
    allConsumed(routes);
  });
  it.each([
    [
      '409 merge conflict',
      synthetic({ message: 'Merge conflict' }, 409),
      { category: 'conflict', code: 'not_mergeable' },
    ],
    [
      '404',
      synthetic({ message: 'Not Found' }, 404),
      { category: 'permanent', code: 'not_found' },
    ],
    [
      '422',
      synthetic({ message: 'Validation Failed' }, 422),
      { category: 'permanent', code: 'github_validation' },
    ],
  ])('maps a /merges %s without reading back', async (_, reply, expected) => {
    const routes = preMerge();
    routes[merges] = [reply];
    const f = setup(routes);
    await expect(f.mergePR(pr8, opts)).rejects.toMatchObject(expected);
    expect(f.sleeps).toEqual([]);
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
