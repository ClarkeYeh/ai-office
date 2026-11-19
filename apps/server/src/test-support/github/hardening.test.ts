import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { GitPusher } from './pusher.js';
import { Ledger, emptyLedger } from './ledger.js';
import { scan } from './janitor.js';
import { GithubApi } from './api.js';
import { guardedFetch } from './transport.js';
import { API, ROOT, marker } from './safety.js';
import { contractTransport } from './contract-transport.js';
import { ContractFaults } from './contract-faults.js';
const id = 'a12b34c56d78';
const json = (v: unknown) => new Response(JSON.stringify(v));

it('rejects the legacy PUT merge even for an owned unprotected test base without sending any request', async () => {
  const ledger = new Ledger('/unused', {
    ...emptyLedger(id),
    resources: [{ kind: 'pr', key: `t${id}:pr`, number: 44, state: 'created' }],
  });
  const network = vi.fn<typeof fetch>();
  await expect(
    guardedFetch(network, ledger)(`${API}${ROOT}/pulls/44/merge`, {
      method: 'PUT',
      body: JSON.stringify({ sha: 'a'.repeat(40), merge_method: 'merge' }),
    }),
  ).rejects.toThrow();
  expect(network).not.toHaveBeenCalled();
});

it('scans exact imported command IDs and production claims without matching adjacent namespaces', async () => {
  const api = new GithubApi(async (input) =>
    new URL(String(input)).pathname.includes('/issues')
      ? json([
          { number: 44, body: marker('ULIDCOMMAND') },
          { number: 45, body: marker('prod123:next') },
          { number: 46, body: marker('prod1234:unrelated') },
          { number: 47, body: marker('t000000000002:other-run') },
          { number: 3, body: 'old spike' },
        ])
      : json(
          [
            'prod123-worker',
            'prod123/worker',
            'prod1234-worker',
            't000000000002-worker',
          ].map((b) => ({ ref: `refs/heads/ai-office/${b}` })),
        ),
  );
  expect(
    await scan(api, { claims: ['prod123'], commands: ['ULIDCOMMAND'] }),
  ).toEqual({
    openObjects: [44, 45, 47],
    branches: [
      'ai-office/prod123-worker',
      'ai-office/prod123/worker',
      'ai-office/t000000000002-worker',
    ],
  });
});

it('pushes with the selected token in process environment only, never the active-account helper', async () => {
  const directory = await mkdtemp(join(tmpdir(), 't8-pusher-'));
  const ledger = new Ledger(join(directory, 'ledger.json'), emptyLedger(id));
  const token = vi.fn(async () => 'synthetic-selected-credential');
  const run = vi.fn(
    async (args: string[], _cwd: string, env?: NodeJS.ProcessEnv) => {
      if (args[0] === 'remote')
        return 'https://github.com/ClarkeYeh/ai-office-spike.git';
      if (args[0] === 'show')
        return `ClarkeYeh\n${env!.GIT_AUTHOR_EMAIL}\nClarkeYeh\n${env!.GIT_COMMITTER_EMAIL}`;
      if (args[0] === 'diff-tree') return `aio-test/${id}/item-1.md`;
      if (args[0] === 'rev-parse') return 'b'.repeat(40);
      return '';
    },
  );
  const pusher = await GitPusher.create(
    ledger,
    {
      email: '123+ClarkeYeh@users.noreply.github.com',
      assertActive: async () => {},
    },
    { run, token },
  );
  try {
    await pusher.push({
      branch: `ai-office/t${id}-worker`,
      base: 'a'.repeat(40),
    });
    const push = run.mock.calls.find(([args]) => args.includes('push'))!;
    expect(push[0].join(' ')).not.toMatch(/git-credential|synthetic-selected/);
    expect(push[2]).toMatchObject({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from('x-access-token:synthetic-selected-credential').toString('base64')}`,
    });
    expect(token).toHaveBeenCalledTimes(1);
    for (const [args, , env] of run.mock.calls)
      if (!args.includes('push'))
        expect(env).not.toHaveProperty('GIT_CONFIG_VALUE_0');
  } finally {
    await pusher.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('namespaces markers before the guarded transport and isolates collection responses', async () => {
  const network = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'POST') {
      const body = (await request.json()) as { body: string; title: string };
      expect(body).toEqual({
        title: `[aio-test ${id}] Conclusion`,
        body: marker(`t${id}:issue`),
      });
      return json(body);
    }
    return json([
      { number: 44, body: marker(`t${id}:issue`) },
      { number: 45, body: marker('t000000000002:issue') },
    ]);
  });
  const fetch = contractTransport(network, id);
  expect(
    await (
      await fetch(`${API}${ROOT}/issues`, {
        method: 'POST',
        body: JSON.stringify({ title: 'Conclusion', body: marker('issue') }),
      })
    ).json(),
  ).toEqual({ title: 'Conclusion', body: marker('issue') });
  expect(await (await fetch(`${API}${ROOT}/issues`)).json()).toEqual([
    { number: 44, body: marker('issue') },
  ]);
});

it('injects lost responses after creation and delays only lists, retaining direct reads', async () => {
  let now = 0;
  const faults = new ContractFaults(() => now);
  faults.listLagMs(1000);
  faults.loseNextResponse('createIssue');
  const network = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    return json(
      request.method === 'GET' && request.url.endsWith('/issues')
        ? [{ number: 44 }]
        : { number: 44 },
    );
  });
  const fetch = faults.wrap(network);
  await expect(
    fetch(`${API}${ROOT}/issues`, { method: 'POST' }),
  ).rejects.toThrow('Injected response loss');
  expect(await (await fetch(`${API}${ROOT}/issues`)).json()).toEqual([]);
  expect(await (await fetch(`${API}${ROOT}/issues/44`)).json()).toEqual({
    number: 44,
  });
  now = 1000;
  expect(await (await fetch(`${API}${ROOT}/issues`)).json()).toEqual([
    { number: 44 },
  ]);
});
