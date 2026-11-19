import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openGate } from './gate.js';
import { acquireLiveLock } from './lock.js';
import { Ledger, emptyLedger, loadLedger } from './ledger.js';
import { GithubApi } from './api.js';
import { cleanup, scan } from './janitor.js';
import { API, ROOT, marker, assertBranch, assertRemote } from './safety.js';
import { guardedFetch } from './transport.js';
import { RecordingFetch, ReplayFetch } from './recording.js';
import { commitEnvironment, verifyRemotes, GitPusher } from './pusher.js';
import { git } from './process.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function dir() {
  const d = await mkdtemp(join(tmpdir(), 'github-unit-'));
  dirs.push(d);
  return d;
}
const runId = 'a12b34c56d78';
const command = `t${runId}:issue`;
const json = (data: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(data), { status });
const env = { AIO_REAL_GITHUB: '1' };
async function ledger() {
  return new Ledger(join(await dir(), 'ledger.json'), emptyLedger(runId));
}
function probe(
  overrides: {
    selected?: string;
    active?: string;
    remaining?: number;
    id?: unknown;
  } = {},
) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === '/user')
      return json({
        login:
          request.headers.get('Authorization') === 'Bearer selected'
            ? (overrides.selected ?? 'ClarkeYeh')
            : (overrides.active ?? 'ClarkeYeh'),
      });
    if (path === '/rate_limit')
      return json({
        resources: { core: { remaining: overrides.remaining ?? 2000 } },
      });
    if (path === '/users/ClarkeYeh') return json({ id: overrides.id ?? 123 });
    return json({});
  });
}

describe('live safety gate', () => {
  it('refuses opt-in, CI and repo before acquiring credentials or making requests', async () => {
    for (const options of [
      { env: {} },
      { env: { AIO_REAL_GITHUB: 'true' } },
      ...['', 'true', 'false'].map((CI) => ({ env: { ...env, CI } })),
      { env, repo: 'ClarkeYeh/ai-office' },
    ]) {
      const fetch = probe(),
        token = vi.fn();
      await expect(openGate({ ...options, fetch, token })).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
      expect(token).not.toHaveBeenCalled();
    }
  });
  it.each([
    { selected: 'other' },
    { active: 'other' },
    { remaining: 1499 },
    { id: 'bad' },
  ])('refuses identity or quota and releases the lock (%j)', async (fault) => {
    const lockPath = join(await dir(), 'lock');
    await expect(
      openGate({
        env,
        lockPath,
        fetch: probe(fault),
        token: async (active) => (active ? 'active' : 'selected'),
      }),
    ).rejects.toThrow();
    const release = await acquireLiveLock(lockPath);
    await release();
  });
  it('validates credentials separately, rejects foreign URLs and closes transport', async () => {
    const token = vi.fn(async (active: boolean) =>
      active ? 'active' : 'selected',
    );
    const transport = probe();
    const gate = await openGate({
      env,
      lockPath: join(await dir(), 'lock'),
      fetch: transport,
      token,
    });
    expect(token.mock.calls).toEqual([[false], [true]]);
    expect(gate.email).toBe('123+ClarkeYeh@users.noreply.github.com');
    for (const url of [
      `${API}/repos/ClarkeYeh/ai-office/issues`,
      'https://example.invalid/',
      `${API}${ROOT}/issues#bad`,
    ])
      await expect(gate.fetch(url)).rejects.toThrow();
    await gate.close();
    await expect(gate.fetch(`${API}${ROOT}/issues`)).rejects.toThrow('closed');
  });
  it('does not steal live or malformed locks and safely recovers a dead pid', async () => {
    const path = join(await dir(), 'lock');
    const release = await acquireLiveLock(path);
    await expect(acquireLiveLock(path)).rejects.toThrow();
    await release();
    await writeFile(path, 'broken');
    await expect(acquireLiveLock(path)).rejects.toThrow();
    await writeFile(path, JSON.stringify({ pid: 2147483647 }));
    await (
      await acquireLiveLock(path)
    )();
  });
});

describe('ledger and guarded transport', () => {
  it('persists intent before POST and retains it after response loss', async () => {
    const l = await ledger();
    const fetch = guardedFetch(
      async () => {
        expect((await loadLedger(l.path)).resources).toEqual([
          { kind: 'issue', key: command, state: 'intent' },
        ]);
        throw new Error('lost');
      },
      l,
      async () => {},
    );
    await expect(
      fetch(`${API}${ROOT}/issues`, {
        method: 'POST',
        body: JSON.stringify({
          title: `[aio-test ${runId}] test`,
          body: marker(command),
        }),
      }),
    ).rejects.toThrow('lost');
    expect((await loadLedger(l.path)).resources[0]?.state).toBe('intent');
  });
  it('adds the response number and refuses foreign writes and unsafe endpoints', async () => {
    const l = await ledger(),
      network = vi.fn<typeof fetch>(async () => json({ number: 44 }));
    const fetch = guardedFetch(network, l, async () => {});
    await fetch(`${API}${ROOT}/issues`, {
      method: 'POST',
      body: JSON.stringify({
        title: `[aio-test ${runId}] test`,
        body: marker(command),
      }),
    });
    expect((await loadLedger(l.path)).resources[0]).toMatchObject({
      number: 44,
      state: 'created',
    });
    for (const [method, path, body] of [
      ['PATCH', '/git/refs/heads/main', {}],
      ['DELETE', '/issues/44', {}],
      ['POST', '/git/refs', { ref: 'refs/heads/main', sha: 'a'.repeat(40) }],
      ['PATCH', '/issues/3', { state: 'closed' }],
      ['POST', '/issues', { title: 'bad', body: marker('other:cmd') }],
      ['POST', '/labels', { name: 'unrelated' }],
      ['PATCH', '/pulls/44', { base: 'main' }],
    ] as const)
      await expect(
        fetch(`${API}${ROOT}${path}`, { method, body: JSON.stringify(body) }),
      ).rejects.toThrow();
    expect(
      network.mock.calls.filter(
        ([input, init]) => new Request(input, init).method !== 'GET',
      ),
    ).toHaveLength(1);
  });
});

describe('janitor', () => {
  it('recovers lost responses, closes PRs before issues and branches, verifies and is idempotent', async () => {
    const l = await ledger();
    await l.intent('issue', command);
    await l.created(await l.intent('pr', `t${runId}:pr`), 45);
    await l.created(await l.intent('branch', `ai-office/t${runId}-worker`));
    const issue = {
      number: 44,
      state: 'open',
      body: marker(command),
      user: { login: 'ClarkeYeh' },
    };
    const pr = {
      number: 45,
      state: 'open',
      body: marker(`t${runId}:pr`),
      user: { login: 'ClarkeYeh' },
    };
    let branch = true;
    const writes: string[] = [];
    const api = new GithubApi(async (input, init) => {
      const request = new Request(input, init),
        url = new URL(request.url),
        path = decodeURIComponent(url.pathname.slice(ROOT.length));
      if (request.method !== 'GET') writes.push(`${request.method} ${path}`);
      if (path === '/pulls') return json([pr]);
      if (path === '/issues')
        return json(
          url.searchParams.get('state') === 'open'
            ? [issue, pr].filter((o) => o.state === 'open')
            : [issue],
        );
      if (path === '/issues/44/labels') return json([]);
      if (path === '/pulls/45' || path === '/issues/44') {
        const o = path === '/pulls/45' ? pr : issue;
        if (request.method === 'PATCH') o.state = 'closed';
        return json(o);
      }
      if (path.startsWith('/branches/'))
        return json(branch ? { protected: false } : {}, branch ? 200 : 404);
      if (path.startsWith('/git/refs/')) {
        branch = false;
        return json(null, 204);
      }
      if (path.startsWith('/git/matching-refs/'))
        return json(
          branch ? [{ ref: `refs/heads/ai-office/t${runId}-worker` }] : [],
        );
      throw new Error('Unexpected fake route');
    });
    const result = await cleanup(l, api, { apply: true });
    expect(result).toEqual({
      leftovers: 0,
      scan: { openObjects: [], branches: [] },
    });
    expect(writes.map((s) => s.split(' ')[0])).toEqual([
      'PATCH',
      'POST',
      'PATCH',
      'DELETE',
    ]);
    const count = writes.length;
    await cleanup(l, api, { apply: true });
    expect(writes).toHaveLength(count);
    expect(
      (await loadLedger(l.path)).resources.every((r) => r.state === 'done'),
    ).toBe(true);
  });
  it('keeps invisible intents unresolved, does not mutate on dry run, and scans other runs', async () => {
    const l = await ledger();
    await l.intent('issue', command);
    const network = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.method).toBe('GET');
      const url = new URL(request.url);
      return json(
        url.searchParams.get('state') === 'open'
          ? [
              { number: 50, body: marker('t000000000002:cmd') },
              { number: 3, body: 'old spike' },
            ]
          : [],
      );
    });
    const result = await cleanup(l, new GithubApi(network));
    expect(result.leftovers).toBe(1);
    expect(result.scan.openObjects).toEqual([50]);
    expect((await scan(new GithubApi(network))).branches).toEqual([]);
  });
});

describe('record/replay', () => {
  it('normalizes run ids, strips secrets, matches query/body/order and rehydrates known bodies', async () => {
    const body = `Known synthetic ${marker(command)}`;
    const recording = new RecordingFetch(
      async () =>
        new Response(
          JSON.stringify({
            body,
            title: `[aio-test ${runId}] ok`,
            email: 'secret@example.invalid',
            token: 'ghp_secret123',
          }),
          {
            status: 201,
            headers: {
              Authorization: 'Bearer ghp_hidden',
              'Set-Cookie': 'secret',
              etag: '"abc"',
            },
          },
        ),
      runId,
    );
    const url = `${API}${ROOT}/issues?state=all&page=1`;
    const init = { method: 'POST', body: JSON.stringify({ body }) };
    await recording.fetch(url, init);
    const text = JSON.stringify(recording.recordings);
    expect(text).not.toContain('secret@example');
    expect(text).not.toContain('ghp_');
    expect(text).not.toContain(runId);
    expect(text).not.toContain('Known synthetic');
    const replay = new ReplayFetch(recording.recordings, {
      runId,
      bodies: [body],
    });
    expect(() => replay.assertConsumed()).toThrow();
    await expect(
      replay.fetch(url, { method: 'POST', body: '{}' }),
    ).rejects.toThrow();
    expect(await (await replay.fetch(url, init)).json()).toMatchObject({
      body,
    });
    replay.assertConsumed();
    await expect(replay.fetch(url, init)).rejects.toThrow();
    const path = join(await dir(), 'recording.json');
    await recording.save(path);
    expect(await readFile(path, 'utf8')).not.toContain('secret@example');
  });
  it('preserves 304 empty responses and uses deterministic unknown-body placeholders', async () => {
    const recording = new RecordingFetch(
      async () =>
        new Response(null, { status: 304, headers: { etag: '"abc"' } }),
    );
    await recording.fetch(`${API}${ROOT}/issues`);
    const replay = new ReplayFetch(recording.recordings);
    const result = await replay.fetch(`${API}${ROOT}/issues`);
    expect(result.status).toBe(304);
    expect(await result.text()).toBe('');
    replay.assertConsumed();
  });
});

describe('git pusher', () => {
  it('rejects foreign namespaces and remotes, including extra push destinations', async () => {
    for (const branch of [
      'main',
      'clarke/spike-w1',
      'feature/spike-gh',
      `ai-office/t${runId}evil`,
      'ai-office/t000000000002-worker',
    ])
      expect(() => assertBranch(branch, runId)).toThrow();
    for (const remote of [
      'https://github.com/ClarkeYeh/ai-office.git',
      'https://token@github.com/ClarkeYeh/ai-office-spike.git',
      'https://github.com/ClarkeYeh/ai-office-spike.git/evil',
    ])
      expect(() => assertRemote(remote)).toThrow();
    await expect(
      verifyRemotes(
        '/synthetic',
        async () =>
          'https://github.com/ClarkeYeh/ai-office-spike.git\nhttps://evil.invalid',
      ),
    ).rejects.toThrow();
    expect(() => commitEnvironment('private@example.invalid')).toThrow();
  });
  it('creates deterministic commits with pinned author and committer in a local git repo', async () => {
    const path = await dir(),
      env = commitEnvironment('123+ClarkeYeh@users.noreply.github.com');
    await git(['init'], path, env);
    await git(['config', 'user.email', 'private@example.invalid'], path, env);
    await writeFile(join(path, 'test.md'), 'synthetic');
    await git(['add', 'test.md'], path, env);
    await git(
      ['-c', 'commit.gpgsign=false', 'commit', '-m', 'synthetic'],
      path,
      env,
    );
    const identity = await git(
      ['show', '-s', '--format=%an%n%ae%n%cn%n%ce%n%aI%n%cI'],
      path,
      env,
    );
    expect(identity).toBe(
      'ClarkeYeh\n123+ClarkeYeh@users.noreply.github.com\nClarkeYeh\n123+ClarkeYeh@users.noreply.github.com\n2026-01-01T00:00:00Z\n2026-01-01T00:00:00Z',
    );
  });
  it('refuses a bad clone origin before clone or push', async () => {
    const run = vi.fn(async () => 'https://github.com/ClarkeYeh/other.git');
    await expect(
      GitPusher.create(
        await ledger(),
        {
          email: '123+ClarkeYeh@users.noreply.github.com',
          assertActive: async () => {},
        },
        { run, sourcePath: '/synthetic' },
      ),
    ).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('integration seams', () => {
  it('imports production resources only from matched events in the selected workflow', async () => {
    const { registerEvents } = await import('./ledger.js');
    const l = await ledger();
    const issued = {
      commandId: '01ABCDEFGHIJKLMNOPQRSTUVWX',
      kind: 'scm.createIssue',
      args: { repo: { owner: 'ClarkeYeh', name: 'ai-office-spike' } },
    };
    await registerEvents(
      l,
      [
        { type: 'command.issued', workflowId: 'wf', payload: issued },
        {
          type: 'command.succeeded',
          workflowId: 'other',
          payload: { ...issued, result: { issue: 99 } },
        },
        {
          type: 'command.succeeded',
          workflowId: 'wf',
          payload: {
            commandId: issued.commandId,
            kind: issued.kind,
            result: { issue: 55 },
          },
        },
      ],
      'wf',
      'prod123',
    );
    expect((await loadLedger(l.path)).resources).toEqual([
      { kind: 'issue', key: issued.commandId, number: 55, state: 'created' },
    ]);
  });
  it.each([
    ['main', false, false],
    [`ai-office/t${runId}-int`, true, false],
    [`ai-office/t${runId}-int`, false, true],
  ])(
    'POST /merges into %s (protected %s) is allowed: %s',
    async (base, isProtected, allowed) => {
      const method = (
        input: Parameters<typeof fetch>[0],
        init?: RequestInit,
      ) => (input instanceof Request ? input.method : (init?.method ?? 'GET'));
      const network = vi.fn<typeof fetch>(async (input, init) =>
        method(input, init) === 'GET'
          ? json({ protected: isProtected })
          : json({ sha: 'b'.repeat(40) }, 201),
      );
      const request = guardedFetch(network, await ledger(), async () => {})(
        `${API}${ROOT}/merges`,
        {
          method: 'POST',
          body: JSON.stringify({
            base,
            head: 'a'.repeat(40),
            commit_message: 'w1 (#44)',
          }),
        },
      );
      if (allowed)
        await expect(request).resolves.toMatchObject({ status: 201 });
      else await expect(request).rejects.toThrow();
      expect(
        network.mock.calls.some(
          ([input, init]) => method(input, init) === 'POST',
        ),
      ).toBe(allowed);
    },
  );
  it('refuses default-base merge before issuing PUT', async () => {
    const l = await ledger();
    await l.created(await l.intent('pr', command), 44);
    const network = vi.fn<typeof fetch>(async () =>
      json({
        number: 44,
        body: marker(command),
        user: { login: 'ClarkeYeh' },
        base: { ref: 'main' },
      }),
    );
    await expect(
      guardedFetch(network, l, async () => {})(`${API}${ROOT}/pulls/44/merge`, {
        method: 'PUT',
        body: JSON.stringify({ sha: 'a'.repeat(40), merge_method: 'merge' }),
      }),
    ).rejects.toThrow();
    expect(
      network.mock.calls.every(
        ([input, init]) => new Request(input, init).method === 'GET',
      ),
    ).toBe(true);
  });
  it('refuses protected branch cleanup and does not delete it', async () => {
    const l = await ledger();
    await l.created(await l.intent('branch', `ai-office/t${runId}-protected`));
    const network = vi.fn<typeof fetch>(async () => json({ protected: true }));
    await expect(
      cleanup(l, new GithubApi(network), { apply: true }),
    ).rejects.toThrow('protected');
    expect(
      network.mock.calls.every(
        ([input, init]) => new Request(input, init).method === 'GET',
      ),
    ).toBe(true);
  });
  it('restores pagination links and replaces unknown body summaries deterministically', async () => {
    const recording = new RecordingFetch(
      async () =>
        new Response(JSON.stringify({ body: 'Unknown synthetic text' }), {
          headers: { link: `<${API}${ROOT}/issues?page=2>; rel="next"` },
        }),
    );
    await recording.fetch(`${API}${ROOT}/issues`);
    const replay = new ReplayFetch(recording.recordings);
    const response = await replay.fetch(`${API}${ROOT}/issues`);
    expect(response.headers.get('link')).toBe(
      `<${API}${ROOT}/issues?page=2>; rel="next"`,
    );
    expect(await response.json()).toEqual({
      body: expect.stringMatching(/^\[recorded body [a-f0-9]{16}\]$/),
    });
    await recording.save(join(await dir(), 'pages.json'));
  });
  it('runs the complete pusher against local git, intercepting only network destinations', async () => {
    const source = await dir(),
      identity = commitEnvironment('123+ClarkeYeh@users.noreply.github.com');
    await git(['init'], source, identity);
    await writeFile(join(source, 'base.md'), 'synthetic base');
    await git(['add', 'base.md'], source, identity);
    await git(
      ['-c', 'commit.gpgsign=false', 'commit', '-m', 'base'],
      source,
      identity,
    );
    const base = await git(['rev-parse', 'HEAD'], source, identity);
    const pushes: string[][] = [];
    const run: typeof git = async (args, cwd, env) => {
      if (args[0] === 'clone')
        return git(['clone', '--no-checkout', source, args.at(-1)!], cwd, env);
      if (args[0] === 'remote')
        return 'https://github.com/ClarkeYeh/ai-office-spike.git';
      if (args.includes('push')) {
        pushes.push(args);
        return '';
      }
      return git(args, cwd, env);
    };
    const l = await ledger(),
      authorize = vi.fn(async () => {});
    const pusher = await GitPusher.create(
      l,
      { email: identity.GIT_AUTHOR_EMAIL!, assertActive: authorize },
      { run },
    );
    try {
      await expect(pusher.push({ branch: 'main', base })).rejects.toThrow();
      const branch = `ai-office/t${runId}-worker`;
      const sha = await pusher.push({ branch, base, itemKey: 'one' });
      expect(sha).toMatch(/^[a-f0-9]{40}$/);
      expect(pushes).toHaveLength(1);
      expect(pushes[0]?.at(-1)).toBe(`HEAD:refs/heads/${branch}`);
      expect(pushes[0]).not.toContain('--force');
      expect(
        await git(
          ['diff-tree', '--no-commit-id', '--name-only', '-r', sha],
          pusher.path,
          identity,
        ),
      ).toBe(`aio-test/${runId}/one-1.md`);
      expect((await loadLedger(l.path)).resources[0]?.state).toBe('created');
      expect(authorize).toHaveBeenCalledTimes(2);
    } finally {
      await pusher.close();
    }
  });
});
