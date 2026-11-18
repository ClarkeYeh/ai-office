import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StartOptions } from '../../main.js';
import {
  COMPOSED_SHIM_OPTION,
  type ComposedShimSeam,
} from './composed-shim-seam.js';
import { OrcaHarness } from './harness.js';
import { TEST_REPO_URL } from './safety.js';
import { scanResources } from './scan.js';

const startServer = vi.hoisted(() => vi.fn());
vi.mock('../../main.js', () => ({ startServer }));
const { run } = await import('./composed-live.js');

const dirs: string[] = [];
let home: string;
/** Open terminals in the approved folder, by handle → title. */
let terminals: Map<string, string>;
let calls: string[][];
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'aio-composed-home-'));
  dirs.push(home);
  terminals = new Map([['term_user', 'user-shell']]);
  calls = [];
  vi.stubEnv('HOME', home);
  vi.stubEnv('AIO_ORCA_BIN', '/synthetic/orca');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  startServer.mockReset();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const ok = (result: unknown) => JSON.stringify({ ok: true, result });
async function harness() {
  const repo = await mkdtemp(join(tmpdir(), 'aio-composed-repo-'));
  dirs.push(repo);
  const h = await OrcaHarness.create({
    repoPath: repo,
    sourceRoot: process.cwd(),
    orcaBin: '/synthetic/orca',
    worktreePaths: async () => [],
    env: { AIO_REAL_ORCA: '1', HOME: home },
    exec: {
      run: async (r) => {
        if (r.bin === 'git')
          return {
            exitCode: 0,
            stdout: r.args.includes('get-url') ? TEST_REPO_URL : '',
          };
        calls.push([...r.args]);
        if (r.args[0] === 'worktree')
          return { exitCode: 0, stdout: ok({ worktrees: [] }) };
        if (r.args[1] === 'list')
          return {
            exitCode: 0,
            stdout: ok({
              terminals: [...terminals].map(([handle, title]) => ({
                handle,
                title,
              })),
            }),
          };
        if (r.args[1] === 'close') {
          terminals.delete(r.args[r.args.indexOf('--terminal') + 1]!);
          return { exitCode: 0, stdout: ok({ closed: true }) };
        }
        throw new Error(`Unexpected synthetic command ${r.args.join(' ')}`);
      },
    },
  });
  dirs.push(h.ledger.dataDir);
  return h;
}
const seamOf = (options: StartOptions) =>
  (options.testOnly as unknown as Record<string, ComposedShimSeam>)[
    COMPOSED_SHIM_OPTION
  ]!;

it('ledgers the composed shim, shuts down, and cleans to ledger 0 and scan 0', async () => {
  const h = await harness();
  const close = vi.fn(async () => undefined);
  startServer.mockImplementation(async (options: StartOptions) => {
    expect(h.ledger.pending).toEqual([
      expect.objectContaining({ kind: 'composed-backend' }),
    ]);
    const seam = seamOf(options);
    await seam.onShimCreated('term_composed');
    // The handle is persisted before the backend may use it.
    const saved = JSON.parse(await readFile(h.ledgerPath, 'utf8')) as {
      shims: { id: string }[];
    };
    expect(saved.shims).toEqual([
      expect.objectContaining({ id: 'term_composed' }),
    ]);
    terminals.set(
      'term_composed',
      `AI Office · 請勿關閉 ${h.ledger.shimMarkers[0]}`,
    );
    return { close };
  });
  await run(h);
  const [options] = startServer.mock.calls[0]! as [StartOptions];
  const backendHome = join(h.ledger.dataDir, 'backend');
  expect(options).toMatchObject({ dev: true, runtime: 'orca', port: 0 });
  expect(options.env?.AI_OFFICE_HOME).toBe(backendHome);
  expect(seamOf(options).folder).toBe(join(home, '.ai-office', 'orca-home'));
  expect(await readFile(join(backendHome, 'config.toml'), 'utf8')).toContain(
    'bin = "/synthetic/orca"',
  );
  expect(close).toHaveBeenCalledOnce();
  expect(h.ledger.pending).toEqual([]);
  expect(h.ledger.shims).toEqual([{ id: 'term_composed', done: false }]);
  await h.clean();
  expect(calls).toContainEqual([
    'terminal',
    'close',
    '--terminal',
    'term_composed',
    '--json',
  ]);
  await h.assertClean();
  expect(terminals.has('term_user')).toBe(true);
});

it('fails closed while the backend ignores the shim-folder seam', async () => {
  const h = await harness();
  const close = vi.fn(async () => undefined);
  startServer.mockResolvedValue({ close });
  await expect(run(h)).rejects.toThrow('reported no shim');
  expect(close).toHaveBeenCalledOnce();
  expect(h.ledger.pending).toHaveLength(1);
  await expect(h.clean()).rejects.toThrow('Unresolved mutation receipt');
});

it('fails the scan while a composed shim of this ledger stays open', async () => {
  const h = await harness();
  const backendHome = join(h.ledger.dataDir, 'backend');
  await mkdir(backendHome);
  const effects = await h.composedBackend(backendHome);
  terminals.set('term_stray', `AI Office · 請勿關閉 ${effects.marker}`);
  terminals.set('term_owner', 'AI Office · 請勿關閉 aio-shim:000000000000');
  expect(await h.scan()).toEqual([
    {
      kind: 'shim',
      id: 'term_stray',
      name: expect.stringContaining(effects.marker),
    },
  ]);
});

it('matches composed shims only by an owned marker', async () => {
  const found = await scanResources(
    '/spike',
    '/home/test/.ai-office/orca-home',
    async (kind, args) => ({
      exitCode: 0,
      stdout:
        kind === 'git'
          ? ''
          : ok(
              args[0] === 'worktree'
                ? { worktrees: [] }
                : {
                    terminals: [
                      {
                        handle: 'a',
                        title: 'AI Office · 請勿關閉 aio-shim:aaaaaaaaaaaa',
                      },
                      {
                        handle: 'b',
                        title: 'AI Office · 請勿關閉 aio-shim:bbbbbbbbbbbb',
                      },
                    ],
                  },
            ),
    }),
    ['aio-shim:aaaaaaaaaaaa'],
  );
  expect(found.map((r) => r.id)).toEqual(['a']);
});
