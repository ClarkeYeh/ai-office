import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createGithubScm,
  RepoAllowlist,
} from '../../adapters/scm-github/index.js';
import { ContractFaults } from './contract-faults.js';
import { scenarioTime } from './scenario-time.js';
import { visibleWrites, waitForVisibility } from './visibility.js';
import { cleanup, scan } from './janitor.js';
import { Ledger, emptyLedger } from './ledger.js';
import { GithubApi } from './api.js';
import { guardedFetch } from './transport.js';
import { GithubCaseScope } from './case-scope.js';
import { acquireLiveLock } from './lock.js';
import { API, ROOT, marker } from './safety.js';
const id = 'a12b34c56d78';
const repo = { owner: 'ClarkeYeh', name: 'ai-office-spike' };
const json = (v: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(v), { status });
afterEach(() => vi.useRealTimers());

it('uses elapsed wall time through 9-second real-list lag and 30-second injected lag, with one lost create POST', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const start = Date.now();
  let posts = 0;
  let row: Record<string, unknown> | undefined;
  const network: typeof fetch = async (input, init) => {
    const request = new Request(input, init),
      path = new URL(request.url).pathname;
    if (path === '/user') return json({ login: 'ClarkeYeh' });
    if (request.method === 'POST') {
      posts++;
      row = {
        ...((await request.json()) as object),
        state: 'open',
        number: 44,
        html_url: 'https://github.com/ClarkeYeh/ai-office-spike/issues/44',
        user: { login: 'ClarkeYeh' },
      };
      return json(row, 201);
    }
    return json(
      path.endsWith('/issues') && row && Date.now() - start >= 9000
        ? [row]
        : [],
    );
  };
  const time = scenarioTime('live');
  const faults = new ContractFaults(() => time.clock.now().getTime());
  faults.listLagMs(30_000);
  faults.loseNextResponse('createIssue');
  const scm = createGithubScm({
    fetch: faults.wrap(visibleWrites(network)),
    clock: time.clock,
    sleep: time.sleep,
    repoAllowlist: new RepoAllowlist([repo]),
    tokenProvider: async () => 'synthetic',
    maskSecrets: <T>(v: T) => v,
  });
  let settled = false;
  const run = (async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const result = await scm.createIssue(
          repo,
          { title: 'Once', body: '', labels: [] },
          { workflowId: 'wf', commandId: 'once' },
        );
        settled = true;
        return result;
      } catch (error) {
        expect(error).toMatchObject({ code: 'create_outcome_unknown' });
        await time.sleep((error as { retryAfterMs: number }).retryAfterMs);
      }
    }
    throw new Error('Never settled');
  })();
  await vi.advanceTimersByTimeAsync(38_999);
  expect(settled).toBe(false);
  expect(posts).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await run).toMatchObject({ number: 44 });
  expect(posts).toBe(1);
  const replay = scenarioTime('replay', time.reads);
  for (const value of time.reads)
    expect(replay.clock.now().getTime()).toBe(value);
  replay.assertConsumed();
  expect(() => replay.clock.now()).toThrow('Unrecorded');
});

it('bounds visibility waits and waits for a deleted head PR to actually close', async () => {
  let now = 0;
  const timing = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    timeoutMs: 2000,
  };
  const transport = visibleWrites(async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'DELETE') return json(null, 204);
    const pr = {
      number: 44,
      head: { ref: `ai-office/t${id}-worker` },
      state: now < 600 ? 'open' : 'closed',
    };
    return json(new URL(request.url).pathname.endsWith('/pulls') ? [pr] : pr);
  }, timing);
  await transport(`${API}${ROOT}/git/refs/heads/ai-office%2Ft${id}-worker`, {
    method: 'DELETE',
  });
  expect(now).toBe(1000);
  await expect(waitForVisibility(async () => false, timing)).rejects.toThrow(
    'did not settle',
  );
  expect(now).toBe(3000);
});

it('checks current issue state instead of trusting stale open-list rows, while retaining genuinely open hits', async () => {
  const api = new GithubApi(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/issues'))
      return json(
        [44, 45, 46].map((number) => ({
          number,
          body: marker(`t${id}:issue`),
        })),
      );
    if (path.endsWith('/44')) return json({ state: 'closed' });
    if (path.endsWith('/45')) return json({ state: 'open' });
    if (path.endsWith('/46')) return json({}, 404);
    return json([]);
  });
  expect((await scan(api)).openObjects).toEqual([45]);
});

it('recovers an initially invisible duplicate even when the ledger already has the other number', async () => {
  const directory = await mkdtemp(join(tmpdir(), 't8-lag-'));
  try {
    const ledger = new Ledger(join(directory, 'ledger.json'), emptyLedger(id));
    await ledger.created(await ledger.intent('issue', `t${id}:once`), 64);
    let now = 0;
    const rows = [63, 64].map((number) => ({
      number,
      state: 'open',
      body: marker(`t${id}:once`),
      user: { login: 'ClarkeYeh' },
    }));
    const closed: number[] = [];
    const api = new GithubApi(async (input, init) => {
      const request = new Request(input, init),
        url = new URL(request.url),
        path = url.pathname.slice(ROOT.length);
      if (path === '/issues')
        return json(
          (now < 9000 ? rows.slice(1) : rows).map((r) => ({
            ...r,
            state: 'open',
          })),
        );
      const number = Number(path.split('/')[2]);
      const row = rows.find((r) => r.number === number);
      if (path.endsWith('/labels')) return json([]);
      if (row) {
        if (request.method === 'PATCH') {
          row.state = 'closed';
          closed.push(number);
        }
        return json(row);
      }
      return json([]);
    });
    const result = await cleanup(ledger, api, {
      apply: true,
      sleep: async (ms) => {
        now += ms;
        expect(ledger.data.resources[0]!.state).toBe('created');
      },
    });
    expect(closed).toEqual([64, 63]);
    expect(result).toEqual({
      leftovers: 0,
      scan: { openObjects: [], branches: [] },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('allows triple-dot compare URLs but rejects decoded traversal segments before transport', async () => {
  const network = vi.fn<typeof fetch>(async () => json({}));
  const fetch = guardedFetch(network, new Ledger('/unused', emptyLedger(id)));
  await fetch(
    `${API}${ROOT}/compare/ai-office%2Ft${id}-base...ai-office%2Ft${id}-head`,
  );
  expect(network).toHaveBeenCalledTimes(1);
  await expect(
    fetch(`${API}${ROOT}/compare/ai-office%2F..%2Fmain...head`),
  ).rejects.toThrow('Unsafe API path');
  expect(network).toHaveBeenCalledTimes(1);
});

it('drains aborted work before releasing a real lock and disposes only once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 't8-lock-'));
  const path = join(directory, 'lock');
  try {
    const controller = new AbortController();
    const scope = new GithubCaseScope(controller.signal);
    let release!: () => Promise<void>;
    let finish!: () => void;
    const pending = scope.run(async () => {
      release = await acquireLiveLock(path);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    while (!finish) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    const cleanup = vi.fn(async () => {
      await release();
    });
    const disposed = scope.dispose(cleanup);
    await expect(acquireLiveLock(path)).rejects.toThrow('held');
    await expect(scope.run(async () => {})).rejects.toThrow('aborted');
    finish();
    await pending;
    await disposed;
    const releaseNext = await acquireLiveLock(path);
    await scope.dispose(cleanup);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await expect(acquireLiveLock(path)).rejects.toThrow('held');
    await releaseNext();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('can release an acquired lock when fixture initialization fails before returning a fixture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 't8-setup-'));
  try {
    const path = join(directory, 'lock');
    const scope = new GithubCaseScope();
    let release!: () => Promise<void>;
    await expect(
      scope.run(async () => {
        release = await acquireLiveLock(path);
        throw new Error('factory failed');
      }),
    ).rejects.toThrow('factory failed');
    await scope.dispose(() => release());
    await (
      await acquireLiveLock(path)
    )();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('cancels pending real-time waits on case abort so disposal need not wait out retryAfterMs', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const time = scenarioTime('live', [], controller.signal);
  const wait = time.sleep(60_000);
  const rejection = expect(wait).rejects.toThrow('aborted');
  controller.abort();
  await rejection;
  expect(vi.getTimerCount()).toBe(0);
  await expect(time.sleep(1000)).rejects.toThrow('aborted');
});
