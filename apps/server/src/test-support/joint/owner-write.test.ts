import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { GithubApi } from '../github/api.js';
import { Ledger, emptyLedger, registerEvents } from '../github/ledger.js';
import { githubOwnerActions } from '../github/owner-actions.js';
import { ROOT, marker } from '../github/safety.js';
import { guardedFetch } from '../github/transport.js';
import type { Json } from '../orca/t17/checks.js';
import { ledgeredWrite } from './owner-write.js';

/*
 * M5-T12 #1: the backend created the conclusion Issue and opened its gate in
 * the same second; the owner's `/approve` hit the guarded transport before the
 * 30-second import had ledgered the Issue ("Object not in this ledger").
 */
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const runId = 'a12b34c56d78';
const workflowId = '01M886BYDQ2G6Z55463KSPBG8X';
const shortId = '43925c24fe81';
const issueCommand = `${workflowId}/meeting/1/issue`;
const repo = { owner: 'ClarkeYeh', name: 'ai-office-spike' };
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });

/** The poll the owner policy acts on: the Issue's creation and its gate. */
const samePoll: Json[] = [
  {
    type: 'command.issued',
    workflowId,
    payload: {
      commandId: issueCommand,
      kind: 'scm.createIssue',
      args: { repo, title: 'conclusion', body: marker(issueCommand) },
    },
  },
  {
    type: 'command.succeeded',
    workflowId,
    payload: {
      commandId: issueCommand,
      kind: 'scm.createIssue',
      result: { issue: 199 },
    },
  },
  {
    type: 'gate.opened',
    workflowId,
    stageId: 'meeting',
    payload: { stageId: 'meeting', content: { type: 'conclusion' } },
  },
];
const stale = samePoll.slice(2);

async function world() {
  const d = await mkdtemp(join(tmpdir(), 'joint-owner-write-'));
  dirs.push(d);
  const ledger = new Ledger(join(d, 'ledger.json'), emptyLedger(runId));
  ledger.data.claims.push(shortId);
  const comments: string[] = [];
  const network = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    const path = decodeURIComponent(
      new URL(request.url).pathname.slice(ROOT.length),
    );
    if (request.method === 'GET' && path === '/issues/199')
      return json({
        number: 199,
        state: 'open',
        body: `# Meeting conclusion\n\n${marker(issueCommand)}`,
        user: { login: 'ClarkeYeh' },
      });
    if (request.method === 'POST' && path === '/issues/199/comments') {
      comments.push(String(((await request.json()) as Json).body));
      return json({ id: 1, user: { login: 'ClarkeYeh' } }, 201);
    }
    return json({ message: 'unexpected' }, 404);
  });
  const owner = githubOwnerActions(
    new GithubApi(guardedFetch(network, ledger, async () => {})),
    runId,
  );
  const register = (log: Json[]) =>
    registerEvents(
      ledger,
      log.map((e) => ({
        type: String(e.type),
        workflowId: (e.workflowId ?? null) as string | null,
        payload: e.payload as unknown,
      })),
      workflowId,
      shortId,
    );
  const approve = () => owner.ownerComment(199, 'approve', '/approve');
  return { ledger, comments, register, approve };
}

it('without an import the guarded write is refused (the T12 race)', async () => {
  const w = await world();
  await expect(w.approve()).rejects.toThrow('Object not in this ledger');
  expect(w.comments).toEqual([]);
});

it('imports an object created in the same poll before the owner writes', async () => {
  const w = await world();
  const fresh = vi.fn(async () => samePoll);
  await ledgeredWrite(w.register, samePoll, fresh, w.approve);
  expect(fresh).not.toHaveBeenCalled();
  expect(w.comments).toHaveLength(1);
  expect(w.comments[0]).toMatch(/^\/approve\n/);
  expect(w.ledger.data.resources.find((r) => r.kind === 'issue')?.number).toBe(
    199,
  );
});

it('on a miss, imports fresh events and retries once', async () => {
  const w = await world();
  const fresh = vi.fn(async () => samePoll);
  await ledgeredWrite(w.register, stale, fresh, w.approve);
  expect(fresh).toHaveBeenCalledTimes(1);
  expect(w.comments).toHaveLength(1);
});

it('still missing after the retry fails as before, without a second retry', async () => {
  const w = await world();
  const fresh = vi.fn(async () => stale);
  await expect(
    ledgeredWrite(w.register, stale, fresh, w.approve),
  ).rejects.toThrow('Object not in this ledger');
  expect(fresh).toHaveBeenCalledTimes(1);
  expect(w.comments).toEqual([]);
});

it('never retries other failures', async () => {
  const w = await world();
  const fresh = vi.fn(async () => samePoll);
  const write = vi.fn(async () => {
    throw new Error('Object ownership mismatch');
  });
  await expect(
    ledgeredWrite(w.register, samePoll, fresh, write),
  ).rejects.toThrow('Object ownership mismatch');
  expect(write).toHaveBeenCalledTimes(1);
  expect(fresh).not.toHaveBeenCalled();
});
