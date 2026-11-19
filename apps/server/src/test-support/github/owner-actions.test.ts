import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { GithubApi } from './api.js';
import { cleanup, scan } from './janitor.js';
import { Ledger, emptyLedger, loadLedger } from './ledger.js';
import { githubOwnerActions } from './owner-actions.js';
import { ROOT, harnessCommand, marker, ownerMarker } from './safety.js';
import { guardedFetch } from './transport.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const runId = 'a12b34c56d78';
const json = (data: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(data), { status });
async function ledger() {
  const d = await mkdtemp(join(tmpdir(), 'github-owner-'));
  dirs.push(d);
  return new Ledger(join(d, 'ledger.json'), emptyLedger(runId));
}

it('reads either marker; owner markers carry no ai-office:cmd marker', () => {
  const owner = ownerMarker(`t${runId}:owner-x`);
  expect(owner).not.toContain('ai-office:cmd');
  expect(harnessCommand(`text\n${owner}`)).toBe(`t${runId}:owner-x`);
  expect(harnessCommand(marker(`t${runId}:cmd`))).toBe(`t${runId}:cmd`);
  expect(harnessCommand('no marker')).toBeUndefined();
  expect(() => ownerMarker('bad id!')).toThrow();
});

it('ledgers an unmarked owner Issue and comment, and the janitor closes the Issue', async () => {
  const l = await ledger();
  const conclusion = `t${runId}:conclusion`;
  await l.created(await l.intent('issue', conclusion), 40);
  const objects = new Map<number, Record<string, unknown>>([
    [
      40,
      {
        number: 40,
        state: 'open',
        body: marker(conclusion),
        user: { login: 'ClarkeYeh' },
      },
    ],
  ]);
  const comments: Record<string, unknown>[] = [];
  const writes: string[] = [];
  const network = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname.slice(ROOT.length));
    if (request.method !== 'GET') writes.push(`${request.method} ${path}`);
    const body = request.body
      ? ((await request.json()) as Record<string, unknown>)
      : {};
    if (path === '/issues' && request.method === 'POST') {
      const created = {
        number: 41,
        state: 'open',
        body: body.body,
        user: { login: 'ClarkeYeh' },
      };
      objects.set(41, created);
      return json(created, 201);
    }
    if (path === '/issues/40/comments' && request.method === 'POST') {
      const created = {
        id: 900,
        body: body.body,
        user: { login: 'ClarkeYeh' },
      };
      comments.push(created);
      return json(created, 201);
    }
    if (path === '/issues/comments') return json(comments);
    const comment = /^\/issues\/comments\/(\d+)$/.exec(path);
    if (comment) {
      const index = comments.findIndex((c) => c.id === Number(comment[1]));
      if (index < 0) return json({}, 404);
      if (request.method === 'DELETE') {
        comments.splice(index, 1);
        return json(null, 204);
      }
      return json(comments[index]);
    }
    if (path === '/issues')
      return json(
        [...objects.values()].filter(
          (o) => url.searchParams.get('state') !== 'open' || o.state === 'open',
        ),
      );
    const issue = /^\/issues\/(\d+)(\/labels)?$/.exec(path);
    if (issue) {
      const o = objects.get(Number(issue[1]))!;
      if (issue[2]) return json([]);
      if (request.method === 'PATCH') Object.assign(o, body);
      return json(o);
    }
    if (path.startsWith('/git/matching-refs/')) return json([]);
    throw new Error('Unexpected fake route');
  });
  const owner = githubOwnerActions(
    new GithubApi(guardedFetch(network, l, async () => {})),
    runId,
  );
  expect(await owner.createUnmarkedIssue('unknown-object')).toBe(41);
  expect(String(objects.get(41)!.body)).not.toContain('ai-office:cmd');
  await owner.ownerComment(40, 'approve-comment', '/approve');
  expect(String(comments[0]!.body)).toMatch(
    /^\/approve\n\n<!-- aio-test:owner=/,
  );
  expect((await loadLedger(l.path)).resources).toEqual([
    { kind: 'issue', key: conclusion, number: 40, state: 'created' },
    {
      kind: 'issue',
      key: `t${runId}:owner-unknown-object`,
      number: 41,
      state: 'created',
    },
    {
      kind: 'comment',
      key: `t${runId}:owner-approve-comment`,
      number: 900,
      state: 'created',
    },
  ]);
  // The independent scan sees open owner-marked objects of any test run.
  expect((await scan(new GithubApi(network))).openObjects).toEqual([40, 41]);
  const result = await cleanup(l, new GithubApi(network), {
    apply: true,
    sleep: async () => {},
  });
  expect(result.scan.openObjects).toEqual([]);
  expect(objects.get(41)!.state).toBe('closed');
  expect(writes).toContain('PATCH /issues/41');
  expect(writes).toContain('DELETE /issues/comments/900');
  expect(comments).toEqual([]);
  expect(result.leftovers).toBe(0);
});
