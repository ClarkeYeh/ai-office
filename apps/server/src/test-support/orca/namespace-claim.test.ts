import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecRequest } from '../../adapters/runtime-orca/cli/types.js';
import { assertCommand } from './command-gate.js';
import { OrcaHarness } from './harness.js';
import { cleanup, emptyLedger, leftovers } from './ledger.js';
import type { CleanupDriver } from './ledger.js';
import {
  claimedBranch,
  claimedWorktree,
  TEST_REPO_URL,
  testBranch,
} from './safety.js';
import { scanResources } from './scan.js';
import { GitRemoteScm } from './scm-gitremote/index.js';
import { git } from './scm-gitremote/git.js';

/*
 * T17 namespace claims (coordinator-approved generalization of §1.4): a
 * workflow the harness started owns exactly ai-office/<id>/*, ai-office/<id>-*
 * and aio-<id>-*. Unclaimed ai-office/<otherId>/* stays refused and is never
 * deleted.
 */
const NS = 'a1b2c3d4e5f6';
const OTHER = '0123456789ab';
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const temp = async (prefix: string) => {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

describe('claimed namespace predicates', () => {
  it('accepts exactly the claimed workflow branches and worktrees', () => {
    for (const b of [
      `ai-office/${NS}/meeting`,
      `ai-office/${NS}/feature-a2`,
      `ai-office/${NS}-add-a-greeting`,
    ])
      expect(claimedBranch(b, [NS])).toBe(true);
    expect(claimedWorktree(`aio-${NS}-meeting`, [NS])).toBe(true);
  });
  it('refuses unclaimed ids, wildcards, the bare namespace and odd refs', () => {
    for (const b of [
      `ai-office/${OTHER}/meeting`,
      `ai-office/${NS}`,
      `ai-office/${NS}/`,
      `ai-office/${NS}x/meeting`,
      `ai-office/${NS}//x`,
      `ai-office/${NS}/../main`,
      `ai-office/${NS}/x.lock`,
      'ai-office/*',
      'main',
    ])
      expect(claimedBranch(b, [NS]), b).toBe(false);
    expect(claimedBranch(`ai-office/${NS}/x`, ['*'])).toBe(false);
    expect(claimedBranch(`ai-office/${NS}/x`, [])).toBe(false);
    expect(claimedWorktree(`aio-${OTHER}-meeting`, [NS])).toBe(false);
    expect(() => testBranch(`ai-office/${OTHER}/x`, true, [NS])).toThrow(
      'Non-test branch refused',
    );
    expect(() => testBranch(`ai-office/${NS}/x`)).toThrow();
    expect(() => testBranch(`ai-office/${NS}/x`, false, [NS])).not.toThrow();
  });
});

describe('cleanup and the command gate', () => {
  const driver = () => {
    const calls: string[] = [];
    const record =
      (kind: string) =>
      async (id: string): Promise<void> => {
        calls.push(`${kind} ${id}`);
      };
    const d: CleanupDriver = {
      stop: record('stop'),
      release: record('release'),
      removeWorktree: record('rm'),
      closeShim: record('close'),
      deleteRemote: record('remote'),
      deleteLocal: record('local'),
      failTask: record('task'),
    };
    return { calls, d };
  };
  it('deletes claimed branches and keeps the namespace as a leftover until done', async () => {
    const l = emptyLedger('/spike', TEST_REPO_URL, '/tmp/x');
    l.namespaces.push({ id: NS, done: false });
    l.remoteBranches.push({ id: `ai-office/${NS}-slug`, done: false });
    l.localBranches.push({ id: `ai-office/${NS}/meeting`, done: false });
    const { calls, d } = driver();
    await cleanup(l, d, async () => undefined);
    expect(calls).toEqual([
      `remote ai-office/${NS}-slug`,
      `local ai-office/${NS}/meeting`,
    ]);
    expect(leftovers(l)).toEqual([{ kind: 'namespaces', id: NS }]);
  });
  it('never deletes an unclaimed ai-office/<otherId>/* branch', async () => {
    const l = emptyLedger('/spike', TEST_REPO_URL, '/tmp/x');
    l.namespaces.push({ id: NS, done: false });
    l.remoteBranches.push({ id: `ai-office/${OTHER}/meeting`, done: false });
    l.localBranches.push({ id: `ai-office/${OTHER}/meeting`, done: false });
    const { calls, d } = driver();
    await expect(cleanup(l, d, async () => undefined)).rejects.toThrow(
      'Non-test branch refused',
    );
    expect(calls).toEqual([]);
  });
  it('removes only claimed worktrees through the gate', () => {
    const l = emptyLedger('/spike', TEST_REPO_URL, '/tmp/x');
    l.namespaces.push({ id: NS, done: false });
    const wt = (id: string, ns: string) => ({
      id,
      name: `aio-${ns}-meeting`,
      comment: 'aio:cmd-1 base:abc',
      branch: `ai-office/${ns}/meeting`,
      done: false,
    });
    l.worktrees.push(wt('wt-mine', NS), wt('wt-other', OTHER));
    expect(() =>
      assertCommand(['worktree', 'rm', '--worktree', 'id:wt-mine'], l, false),
    ).not.toThrow();
    expect(() =>
      assertCommand(['worktree', 'rm', '--worktree', 'id:wt-other'], l, false),
    ).toThrow('Non-test worktree refused');
  });
});

describe('scan with claims', () => {
  it('inventories claimed resources and ignores other workflows', async () => {
    const calls: string[][] = [];
    const ok = (result: unknown) => ({
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, result }),
    });
    const found = await scanResources(
      '/spike',
      '/home/.ai-office/orca-home',
      async (kind, args) => {
        calls.push([kind, ...args]);
        if (kind === 'orca' && args[0] === 'worktree')
          return ok({
            worktrees: [
              { id: 'w1', displayName: `aio-${NS}-meeting` },
              { id: 'w2', displayName: `aio-${OTHER}-meeting` },
            ],
          });
        if (kind === 'orca') return ok({ terminals: [] });
        if (args.includes('for-each-ref'))
          return {
            exitCode: 0,
            stdout: `ai-office/${NS}/meeting\nai-office/${OTHER}/meeting\n`,
          };
        return {
          exitCode: 0,
          stdout: `${'a'.repeat(40)}\trefs/heads/ai-office/${NS}-slug\n${'b'.repeat(40)}\trefs/heads/ai-office/${OTHER}-slug\n`,
        };
      },
      [],
      [NS],
    );
    expect(found.map((r) => `${r.kind} ${r.id}`)).toEqual([
      'worktree w1',
      `localBranch ai-office/${NS}/meeting`,
      `remoteBranch ai-office/${NS}-slug`,
    ]);
    const lsRemote = calls.find((c) => c.includes('ls-remote'))!;
    expect(lsRemote).toContain(`refs/heads/ai-office/${NS}/*`);
    expect(lsRemote).not.toContain('refs/heads/ai-office/*');
  });
});

describe('harness claim and adoption', () => {
  async function harness(state: {
    worktrees: Record<string, unknown>[];
    local: string[];
    remote: string[];
    workers: Record<string, unknown>[];
  }) {
    const home = await temp('aio-ns-home-');
    const repo = await temp('aio-ns-repo-');
    vi.stubEnv('HOME', home);
    const mutations: string[] = [];
    const ok = (result: unknown) => ({
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, result }),
    });
    const h = await OrcaHarness.create({
      repoPath: repo,
      sourceRoot: process.cwd(),
      orcaBin: '/synthetic/orca',
      worktreePaths: async () => [],
      env: { AIO_REAL_ORCA: '1', HOME: home },
      exec: {
        run: async (r: ExecRequest) => {
          const a = r.args;
          if (r.bin === 'git') {
            if (a.includes('get-url'))
              return { exitCode: 0, stdout: TEST_REPO_URL };
            if (a.includes('for-each-ref'))
              return { exitCode: 0, stdout: state.local.join('\n') };
            if (a.includes('ls-remote') && a.includes('--heads'))
              return {
                exitCode: 0,
                stdout: state.remote
                  .map((b) => `${'c'.repeat(40)}\trefs/heads/${b}`)
                  .join('\n'),
              };
            mutations.push(`git ${a.slice(2).join(' ')}`);
            const branch = a.at(-1)!;
            state.local = state.local.filter((b) => b !== branch);
            state.remote = state.remote.filter((b) => b !== branch);
            return { exitCode: 0, stdout: '' };
          }
          if (a[1] === 'run-show')
            return ok({
              run: { id: a[3], coordinator_handle: 'term_backend' },
            });
          if (a[1] === 'worker-list') return ok({ workers: state.workers });
          if (a[0] === 'worktree' && a[1] === 'list')
            return ok({ worktrees: state.worktrees });
          if (a[0] === 'terminal' && a[1] === 'list')
            return ok({ terminals: [] });
          mutations.push(a.slice(0, 4).join(' '));
          if (a[0] === 'worktree' && a[1] === 'rm')
            state.worktrees = state.worktrees.filter(
              (w) => `id:${w.id}` !== a[3],
            );
          if (a[1] === 'worker-stop') return ok({ state: 'stopped' });
          if (a[1] === 'worker-release') return ok({ state: 'released' });
          return ok({ closed: true });
        },
      },
    });
    dirs.push(h.ledger.dataDir);
    return { h, mutations };
  }

  it('keeps the claim pending until bound, then cleans only claimed resources', async () => {
    const state = {
      worktrees: [
        {
          id: 'w-mine',
          displayName: `aio-${NS}-meeting`,
          branch: `refs/heads/ai-office/${NS}/meeting`,
          comment: 'aio:cmd-1 base:abc',
        },
        {
          id: 'w-other',
          displayName: `aio-${OTHER}-meeting`,
          branch: `refs/heads/ai-office/${OTHER}/meeting`,
          comment: 'aio:cmd-2 base:abc',
        },
      ],
      local: [`ai-office/${NS}/meeting`, `ai-office/${OTHER}/meeting`],
      remote: [`ai-office/${NS}-slug`, `ai-office/${OTHER}-slug`],
      workers: [
        { dispatchId: 'ctx_live', terminalState: 'retained' },
        { dispatchId: 'ctx_gone', terminalState: 'released' },
      ],
    };
    const { h, mutations } = await harness(state);
    const bind = await h.claimWorkflowNamespace();
    expect(leftovers(h.ledger)).toEqual([
      { kind: 'pending:workflow-namespace', id: expect.any(String) },
    ]);
    await expect(h.clean()).rejects.toThrow('Unresolved mutation receipt');
    await expect(bind('not-a-short-id')).rejects.toThrow();
    await bind(NS);
    h.ledger.shims.push({ id: 'term_backend', done: true });
    await expect(h.adoptBackendRun('run_backend')).resolves.toBeUndefined();
    await h.clean();
    expect(mutations).toEqual([
      'orchestration worker-stop --dispatch ctx_live',
      'orchestration worker-release --dispatch ctx_live',
      'worktree rm --worktree id:w-mine',
      `git push origin --delete ai-office/${NS}-slug`,
      `git branch -D ai-office/${NS}/meeting`,
    ]);
    expect(state.local).toEqual([`ai-office/${OTHER}/meeting`]);
    expect(state.remote).toEqual([`ai-office/${OTHER}-slug`]);
    expect(leftovers(h.ledger)).toEqual([]);
    await expect(h.assertClean()).resolves.toBeUndefined();
  });

  it('refuses to adopt a run coordinated by an unledgered terminal', async () => {
    const { h } = await harness({
      worktrees: [],
      local: [],
      remote: [],
      workers: [],
    });
    await expect(h.adoptBackendRun('run_backend')).rejects.toThrow(
      'Run is not coordinated by a ledgered shim',
    );
    expect(h.ledger.runs).toEqual([]);
  });

  it('fails closed when a claimed worktree name sits on an unclaimed branch', async () => {
    const { h, mutations } = await harness({
      worktrees: [
        {
          id: 'w-odd',
          displayName: `aio-${NS}-meeting`,
          branch: `refs/heads/ai-office/${OTHER}/meeting`,
          comment: 'aio:cmd-1',
        },
      ],
      local: [],
      remote: [],
      workers: [],
    });
    await (
      await h.claimWorkflowNamespace()
    )(NS);
    await expect(h.clean()).rejects.toThrow(
      'Claimed worktree on an unclaimed branch',
    );
    expect(mutations).toEqual([]);
  });
});

describe(
  'git-only SCM with claims (offline bare remote)',
  { timeout: 30_000 },
  () => {
    it('writes claimed workflow branches, refuses and never deletes unclaimed ones', async () => {
      const dir = await temp('aio-test-ns-bare-');
      const remote = join(dir, 'remote.git'),
        clone = join(dir, 'writer');
      await git(dir, ['init', '--bare', '--initial-branch=main', remote]);
      await mkdir(clone);
      await git(clone, ['clone', '--', remote, '.']);
      await writeFile(join(clone, 'a.txt'), 'a\n');
      await git(clone, ['add', '.']);
      await git(clone, ['commit', '-m', 'Initial']);
      await git(clone, ['push', 'origin', 'HEAD:refs/heads/main']);
      await git(clone, [
        'push',
        'origin',
        `HEAD:refs/heads/ai-office/${OTHER}/meeting`,
      ]);
      let active: string[] = [NS];
      const scm = await GitRemoteScm.create({
        remote,
        namespaces: () => active,
      });
      try {
        const repo = { owner: 'ClarkeYeh', name: 'ai-office-spike' };
        const c = { workflowId: NS, commandId: 'ensure' };
        await scm.ensureBranch(repo, `ai-office/${NS}-slug`, 'main', c);
        await expect(
          scm.ensureBranch(repo, `ai-office/${OTHER}-slug`, 'main', c),
        ).rejects.toMatchObject({ category: 'guard', code: 'branch' });
        await expect(
          scm.deleteBranch(repo, `ai-office/${OTHER}/meeting`),
        ).rejects.toMatchObject({ category: 'guard', code: 'branch' });
        expect(
          await git(remote, ['branch', '--list', `ai-office/${OTHER}/meeting`]),
        ).toContain(`ai-office/${OTHER}/meeting`);
        // A finished claim no longer authorizes writes.
        active = [];
        await expect(
          scm.deleteBranch(repo, `ai-office/${NS}-slug`),
        ).rejects.toMatchObject({ category: 'guard', code: 'branch' });
        active = [NS];
        await scm.deleteBranch(repo, `ai-office/${NS}-slug`);
        expect(
          await git(remote, ['branch', '--list', `ai-office/${NS}-slug`]),
        ).toBe('');
      } finally {
        await scm.dispose();
      }
    });

    it('simulates the owner merge of the final PR without pushing the default branch', async () => {
      const dir = await temp('aio-test-ns-final-');
      const remote = join(dir, 'remote.git'),
        clone = join(dir, 'writer');
      await git(dir, ['init', '--bare', '--initial-branch=main', remote]);
      await mkdir(clone);
      await git(clone, ['clone', '--', remote, '.']);
      await writeFile(join(clone, 'a.txt'), 'a\n');
      await git(clone, ['add', '.']);
      await git(clone, ['commit', '-m', 'Initial']);
      await git(clone, ['push', 'origin', 'HEAD:refs/heads/main']);
      const mainSha = await git(remote, ['rev-parse', 'main']);
      const scm = await GitRemoteScm.create({ remote, namespaces: () => [NS] });
      try {
        const repo = { owner: 'ClarkeYeh', name: 'ai-office-spike' };
        const c = (commandId: string) => ({ workflowId: NS, commandId });
        const head = `ai-office/${NS}-slug`;
        await scm.ensureBranch(repo, head, 'main', c('b'));
        const pr = await scm.openPR(
          repo,
          { title: 'Final', body: '', base: 'main', head },
          c('pr'),
        );
        scm.simulateOwnerMerge(pr);
        expect((await scm.getPR(pr)).state).toBe('merged');
        expect(() => scm.simulateOwnerMerge(pr)).toThrow();
        expect(await git(remote, ['rev-parse', 'main'])).toBe(mainSha);
        const worker = await scm.openPR(
          repo,
          { title: 'Worker', body: '', base: head, head },
          c('pr2'),
        );
        expect(() => scm.simulateOwnerMerge(worker)).toThrow();
      } finally {
        await scm.dispose();
      }
    });
  },
);
