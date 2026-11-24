import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrcaRuntime } from './index.js';
import { workerStartLaunchArgs } from './agents.js';
import { CwdGuard } from '../cli/cwd.js';
import { DefaultOrcaCli } from '../cli/index.js';
import { CliScheduler } from '../cli/scheduler.js';
import type { ExecRequest } from '../cli/types.js';
import { DispatchLedger } from '../ledger.js';
import {
  sessionRef,
  workspaceRef,
  agentRef,
  questionRef,
  encodeCursor,
} from '../refs.js';
import type { GitCli } from '../git/index.js';
import { marker } from './context.js';
import type { MethodOptions } from './context.js';
import type { Worktree } from './workspaces.js';
import { PortError } from '../../../ports/errors.js';

const sha = 'a'.repeat(40),
  repo = { orcaRepoId: 'repo', localPath: '/repo' },
  correlation = { workflowId: 'wf', commandId: 'command' },
  session = sessionRef('run');
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'aio-t5-'));
  dirs.push(dataDir);
  const data = new Map<string, unknown>();
  const state = {
    read: (key: string) => structuredClone(data.get(key) ?? null),
    write: (key: string, value: unknown) => {
      data.set(key, structuredClone(value));
    },
  };
  state.write('orca:sessions', { run: repo });
  const ledger = new DispatchLedger(state);
  const identity: MethodOptions['identity'] = {
    ensure: vi.fn(async () => ({ handle: 'term_shim', restored: false })),
    withIdentity: async (_run, fn) => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof PortError && e.category === 'identity') {
          await identity.ensure({ force: true });
          return fn();
        }
        throw e;
      }
    },
    track: vi.fn(async () => {}),
    reclaimSession: vi.fn(async () => ({ reclaimed: true })),
    health: () => ({ shim: 'ready', ownership: 'owned' }),
    checkOwnership: vi.fn(async () => 'owned' as const),
  };
  let worktrees: Worktree[] = [];
  const inventory: { path: string; branch: string; head: string }[] = [];
  const git: GitCli = {
    fetch: vi.fn(async () => {}),
    originContains: vi.fn(async () => true),
    revParse: vi.fn(async () => sha),
    localBranch: vi.fn(async () => null),
    isAncestor: vi.fn(async () => true),
    status: vi.fn(async () => []),
    originUrl: vi.fn(async () => 'https://example.test/repo'),
    directories: vi.fn(async () => ({ commonDir: '.git', topLevel: '/repo' })),
    worktrees: vi.fn(async () => inventory),
    deleteBranch: vi.fn(async () => {}),
    createBranch: vi.fn(async () => {}),
    resetBranch: vi.fn(async () => {}),
    checkoutBranch: vi.fn(async (path, branch) => {
      inventory.find((w) => w.path === path)!.branch = `refs/heads/${branch}`;
    }),
    deleteCreatedBranch: vi.fn(async () => {}),
  };
  const calls: ExecRequest[] = [];
  const workers: Record<string, unknown>[] = [];
  const tasks: Record<string, unknown>[] = [];
  let custom:
    | ((
        r: ExecRequest,
      ) => Promise<
        { result?: unknown; error?: string; exitCode?: number } | undefined
      >)
    | undefined;
  const exec = {
    run: async (r: ExecRequest) => {
      calls.push(r);
      const override = await custom?.(r);
      const args = r.args,
        key = args.slice(0, 2).join(' '),
        value = (flag: string) => args[args.indexOf(flag) + 1]!;
      let result: unknown = {};
      if (override?.error)
        return {
          stdout: JSON.stringify({
            ok: false,
            error: { code: override.error },
          }),
          exitCode: 1,
        };
      if (override && 'result' in override) result = override.result;
      else if (key === 'worktree list') result = { worktrees };
      else if (key === 'worktree show') {
        const w = worktrees.find((w) => `id:${w.id}` === value('--worktree'));
        if (!w)
          return {
            stdout: JSON.stringify({
              ok: false,
              error: { code: 'worktree_not_found' },
            }),
            exitCode: 1,
          };
        result = { worktree: w };
      } else if (key === 'worktree create') {
        const w = {
          id: `wt-${calls.length}`,
          path: `/receipt/path-${calls.length}`,
          branch: `refs/heads/${value('--branch')}`,
          repoId: 'repo',
          head: sha,
          comment: value('--comment'),
          displayName: value('--name'),
        };
        worktrees.push(w);
        inventory.push({ path: w.path, branch: w.branch, head: sha });
        result = { worktree: w };
      } else if (key === 'worktree rm') {
        const id = value('--worktree').slice(3);
        const w = worktrees.find((w) => w.id === id);
        worktrees = worktrees.filter((w) => w.id !== id);
        const i = inventory.findIndex((t) => t.path === w?.path);
        if (i >= 0) inventory.splice(i, 1);
      } else if (key === 'orchestration run-create')
        result = { run: { id: 'run' } };
      else if (key === 'orchestration run-list')
        result = { runs: [{ id: 'run', objective: 'workflow aio:open' }] };
      else if (key === 'orchestration worker-start')
        result = { state: 'ready', dispatchId: 'ctx' };
      else if (key === 'orchestration worker-list') result = { workers };
      else if (key === 'orchestration task-list') result = { tasks };
      else if (key === 'orchestration inbox') result = { messages: [] };
      else if (key === 'orchestration request-show')
        result = { state: 'absent' };
      else if (key === 'orchestration worker-show')
        result = {
          dispatch: { runId: 'run', assigneePaneKey: 'pane' },
          worker: { state: 'stopped' },
        };
      else if (key === 'repo list')
        result = { repos: [{ id: 'repo', path: '/repo' }] };
      return {
        stdout: JSON.stringify({ ok: true, result }),
        exitCode: override?.exitCode ?? 0,
      };
    },
  };
  const cli = new DefaultOrcaCli({
    bin: '/replay/orca',
    env: {},
    exec,
    cwdGuard: new CwdGuard(dataDir, async () => []),
    scheduler: new CliScheduler(10000, 4),
    identity: {
      argsFor: async (kind, run, ctx) =>
        ctx?.mailbox
          ? [
              '--terminal',
              `${ctx.mailbox.kind}:${ctx.mailbox.kind === 'run' ? run : ctx.mailbox.id}`,
            ]
          : kind === 'mutate'
            ? ['--from', 'term_shim']
            : [],
    },
  });
  const options = {
    cli,
    git,
    identity,
    ledger,
    state,
    ids: { orcaRequestId: () => '00000000-0000-5000-8000-000000000001' },
    logger: { info: vi.fn() },
    dataDir,
    observer: {
      observe: vi.fn(async () => ({ events: [], cursor: encodeCursor({}) })),
    },
    version: {
      check: vi.fn(async () => ({ version: '1.4.259', verified: true })),
    },
  };
  const runtime = createOrcaRuntime(options);
  const prepare = {
    session,
    repo,
    baseBranch: sha,
    fetchBranch: 'main',
    baseSha: sha,
    name: 'aio-work',
    branch: 'ai-office/work',
    correlation,
  };
  const addWorkspace = () => {
    const w = {
      id: 'existing',
      path: '/receipt/existing',
      branch: 'refs/heads/ai-office/existing',
      repoId: 'repo',
      head: sha,
      comment: `aio:command base:${sha}`,
      displayName: 'existing',
    };
    worktrees.push(w);
    inventory.push({ path: w.path, branch: w.branch, head: sha });
    return workspaceRef(w.id);
  };
  const spawn = {
    session,
    agent: 'codex' as const,
    title: 'Work',
    prompt: 'Read the approved specification.',
    workspace: {
      kind: 'existing-worktree' as const,
      workspace: addWorkspace(),
      readOnly: false,
    },
    correlation: { ...correlation, commandId: 'spawn' },
    keepOpen: true,
  };
  return {
    runtime,
    options,
    prepare,
    spawn,
    calls,
    git,
    ledger,
    state,
    identity,
    inventory,
    workers,
    tasks,
    setCustom: (fn: typeof custom) => {
      custom = fn;
    },
    worktrees: () => worktrees,
  };
}
const command = (r: ExecRequest, key: string) =>
  r.args.slice(0, 2).join(' ') === key;
it('fetches pinned bases, verifies receipt paths, replays and rejects changed input', async () => {
  const f = await fixture();
  const p = await f.runtime.prepareWorkspace(f.prepare);
  expect(p.baseSha).toBe(sha);
  expect(p.path).toMatch(/^\/receipt\//);
  expect(f.git.fetch).toHaveBeenCalledWith('/repo', 'main');
  expect(f.calls.find((r) => command(r, 'worktree create'))?.args).toContain(
    sha,
  );
  expect(await f.runtime.prepareWorkspace(f.prepare)).toEqual(p);
  await expect(
    f.runtime.prepareWorkspace({ ...f.prepare, baseSha: 'b'.repeat(40) }),
  ).rejects.toMatchObject({ category: 'bug', code: 'request_mismatch' });
});
it('resolves fetched origin bases and rejects unfetched local branch names', async () => {
  const f = await fixture();
  await f.runtime.prepareWorkspace({
    ...f.prepare,
    baseBranch: 'origin/main',
    baseSha: undefined,
    fetchBranch: undefined,
  });
  expect(f.git.revParse).toHaveBeenCalledWith(
    '/repo',
    'refs/remotes/origin/main',
  );
  const g = await fixture();
  await expect(
    g.runtime.prepareWorkspace({
      ...g.prepare,
      baseBranch: 'main',
      baseSha: undefined,
      fetchBranch: undefined,
    }),
  ).rejects.toMatchObject({ code: 'base_fetch_required' });
});
it('guards occupied branches before worktree creation', async () => {
  const f = await fixture();
  f.inventory.push({
    path: '/occupied',
    branch: `refs/heads/${f.prepare.branch}`,
    head: sha,
  });
  await expect(f.runtime.prepareWorkspace(f.prepare)).rejects.toMatchObject({
    code: 'branch_in_use',
  });
  expect(f.calls.some((r) => command(r, 'worktree create'))).toBe(false);
});
it('checkoutExisting pre-creates or safely resets W before creating the worktree', async () => {
  for (const existing of [false, true]) {
    const f = await fixture();
    f.inventory.splice(0);
    if (existing) vi.mocked(f.git.localBranch).mockResolvedValue(sha);
    await f.runtime.prepareWorkspace({
      ...f.prepare,
      checkoutExisting: true,
      fetchBranch: f.prepare.branch,
    });
    expect(
      existing ? f.git.resetBranch : f.git.createBranch,
    ).toHaveBeenCalledWith('/repo', f.prepare.branch, sha);
  }
});
it('propagates unpushed guard before resetting existing work', async () => {
  const f = await fixture();
  f.inventory.splice(0);
  vi.mocked(f.git.localBranch).mockResolvedValue(sha);
  vi.mocked(f.git.resetBranch).mockRejectedValue(
    new PortError('guard', 'unpushed_commits', 'Unsafe'),
  );
  await expect(
    f.runtime.prepareWorkspace({
      ...f.prepare,
      checkoutExisting: true,
      fetchBranch: f.prepare.branch,
    }),
  ).rejects.toMatchObject({ code: 'unpushed_commits' });
  expect(f.calls.some((r) => command(r, 'worktree create'))).toBe(false);
});
it.each([false, true])(
  'removes a suffixed receipt before guard/fallback (checkoutExisting=%s)',
  async (existing) => {
    const f = await fixture();
    f.inventory.splice(0);
    let first = true;
    f.setCustom(async (r) => {
      if (command(r, 'worktree create') && first) {
        first = false;
        const w = {
          id: 'suffix',
          repoId: 'repo',
          path: '/actual/suffix',
          branch: `refs/heads/${f.prepare.branch}-2`,
          head: sha,
          comment: `aio:command base:${sha}`,
        };
        f.worktrees().push(w);
        f.inventory.push({ path: w.path, branch: w.branch, head: sha });
        return { result: { worktree: w } };
      }
      return undefined;
    });
    const req = {
      ...f.prepare,
      ...(existing
        ? { checkoutExisting: true as const, fetchBranch: f.prepare.branch }
        : {}),
    };
    if (existing) {
      const result = await f.runtime.prepareWorkspace(req);
      expect(result.path).not.toBe('/actual/suffix');
      expect(f.git.checkoutBranch).toHaveBeenCalled();
    } else
      await expect(f.runtime.prepareWorkspace(req)).rejects.toMatchObject({
        code: 'branch_suffixed',
      });
    expect(
      f.calls.some(
        (r) => command(r, 'worktree rm') && r.args.includes('id:suffix'),
      ),
    ).toBe(true);
    expect(f.git.deleteCreatedBranch).toHaveBeenCalledWith(
      '/repo',
      `${f.prepare.branch}-2`,
      sha,
    );
  },
);
it('does not dispose dirty or unpushed work, and treats missing workspaces as disposed', async () => {
  const f = await fixture();
  vi.mocked(f.git.status).mockResolvedValue(['changed.ts']);
  await expect(
    f.runtime.disposeWorkspace(f.spawn.workspace.workspace),
  ).rejects.toMatchObject({ code: 'workspace_dirty' });
  vi.mocked(f.git.status).mockResolvedValue([]);
  vi.mocked(f.git.revParse).mockResolvedValue('b'.repeat(40));
  vi.mocked(f.git.originContains).mockResolvedValue(false);
  await expect(
    f.runtime.disposeWorkspace(f.spawn.workspace.workspace),
  ).rejects.toMatchObject({ code: 'workspace_unpushed' });
  await f.runtime.disposeWorkspace(workspaceRef('absent'));
  expect(await f.runtime.inspectWorkspace(workspaceRef('absent'))).toEqual({
    clean: false,
    changedFiles: [],
  });
});
it('disposes only marked workspaces and explicitly deletes retained local branches', async () => {
  const f = await fixture();
  vi.mocked(f.git.localBranch).mockResolvedValue(sha);
  await f.runtime.disposeWorkspace(f.spawn.workspace.workspace);
  expect(f.git.deleteCreatedBranch).toHaveBeenCalledWith(
    '/repo',
    'ai-office/existing',
    sha,
  );
  const g = await fixture();
  g.worktrees()[0]!.comment = 'unmanaged';
  await expect(
    g.runtime.disposeWorkspace(g.spawn.workspace.workspace),
  ).rejects.toMatchObject({ code: 'workspace_not_managed' });
});
it('writes pending ledger before worker-start and accepts exit 1 with ready receipt', async () => {
  const f = await fixture();
  f.setCustom(async (r) => {
    if (command(r, 'orchestration worker-start')) {
      expect(f.ledger.byCommand('spawn')?.state).toBe('pending');
      const path = r.args[r.args.indexOf('--spec-file') + 1]!;
      expect(await readFile(path, 'utf8')).toBe(f.spawn.prompt);
      return {
        result: { state: 'ready', dispatchId: 'ctx', turnStart: 'unobserved' },
        exitCode: 1,
      };
    }
    return undefined;
  });
  const a = await f.runtime.spawnAgent(f.spawn);
  expect(a).toBe('ctx');
  expect(f.ledger.byCommand('spawn')?.state).toBe('started');
  expect(await f.runtime.spawnAgent(f.spawn)).toBe(a);
  expect(
    f.calls.filter((r) => command(r, 'orchestration worker-start')),
  ).toHaveLength(1);
});
it.each([
  [{ agent: 'claude-code' as const }, ['--agent', 'claude'], false],
  [
    { agent: 'claude-code' as const, effort: 'high' as const },
    ['--agent', 'claude'],
    true,
  ],
  [
    { agent: 'codex' as const, model: 'gpt-x' },
    ['--agent', 'codex', '--model', 'gpt-x'],
    false,
  ],
  [
    { agent: 'codex' as const, model: 'gpt-x', effort: 'low' as const },
    ['--agent', 'codex', '--model', 'gpt-x', '--effort', 'low'],
    false,
  ],
])(
  'passes --effort only together with --model (Orca rejects it alone): %o',
  (req, args, droppedEffort) => {
    expect(workerStartLaunchArgs(req)).toEqual({ args, droppedEffort });
  },
);
it('starts a model-less high-effort role without --effort and logs the drop once', async () => {
  const f = await fixture();
  f.setCustom(async (r) =>
    command(r, 'orchestration worker-start')
      ? { result: { state: 'ready', dispatchId: `ctx-${f.calls.length}` } }
      : undefined,
  );
  const lead = {
    ...f.spawn,
    agent: 'claude-code' as const,
    effort: 'high' as const,
  };
  await f.runtime.spawnAgent(lead);
  await f.runtime.spawnAgent({
    ...lead,
    correlation: { ...lead.correlation, commandId: 'spawn-2' },
  });
  const starts = f.calls.filter((r) =>
    command(r, 'orchestration worker-start'),
  );
  expect(starts).toHaveLength(2);
  for (const start of starts) {
    expect(start.args).not.toContain('--effort');
    expect(start.args).not.toContain('--model');
  }
  expect(f.options.logger.info).toHaveBeenCalledTimes(1);
  expect(f.options.logger.info).toHaveBeenCalledWith(
    { effort: 'high' },
    expect.stringContaining('effort ignored'),
  );
});
it('reconciles outcome_unknown by the SAME request receipt without another worker-start', async () => {
  const f = await fixture();
  f.setCustom(async (r) =>
    command(r, 'orchestration worker-start')
      ? { result: { state: 'outcome_unknown', dispatchId: 'ctx' }, exitCode: 1 }
      : command(r, 'orchestration request-show')
        ? {
            result: {
              state: 'completed',
              method: 'orchestration.workerStart',
              receipt: { state: 'ready', dispatchId: 'ctx' },
            },
          }
        : undefined,
  );
  expect(await f.runtime.spawnAgent(f.spawn)).toBe('ctx');
  const start = f.calls.find((r) => command(r, 'orchestration worker-start'))!,
    show = f.calls.find((r) => command(r, 'orchestration request-show'))!;
  expect(show.args).toContain(
    start.args[start.args.indexOf('--retry-request') + 1],
  );
  expect(
    f.calls.filter((r) => command(r, 'orchestration worker-start')),
  ).toHaveLength(1);
});
it('recovers absent receipts by task marker and cleans failed-start residual dispatches', async () => {
  for (const failed of [false, true]) {
    const f = await fixture();
    f.workers.push({
      dispatchId: 'ctx',
      taskId: 'task',
      runId: 'run',
      workerState: failed ? 'failed' : 'ready',
    });
    f.tasks.push({ id: 'task', title: 'aio:spawn Work' });
    f.setCustom(async (r) =>
      command(r, 'orchestration worker-start')
        ? {
            result: {
              state: failed ? 'failed' : 'outcome_unknown',
              dispatchId: 'ctx',
            },
            exitCode: 1,
          }
        : undefined,
    );
    if (failed) {
      await expect(f.runtime.spawnAgent(f.spawn)).rejects.toMatchObject({
        code: 'failed',
      });
      expect(
        f.calls.some(
          (r) =>
            command(r, 'orchestration worker-release') &&
            r.args.includes('ctx'),
        ),
      ).toBe(true);
      await expect(f.runtime.spawnAgent(f.spawn)).rejects.toMatchObject({
        code: 'failed',
      });
    } else expect(await f.runtime.spawnAgent(f.spawn)).toBe('ctx');
  }
});
it('leaves unresolved starts transient and does not mint another request id', async () => {
  const f = await fixture();
  f.setCustom(async (r) =>
    command(r, 'orchestration worker-start')
      ? { result: { state: 'outcome_unknown', dispatchId: 'ctx' }, exitCode: 1 }
      : undefined,
  );
  await expect(f.runtime.spawnAgent(f.spawn)).rejects.toMatchObject({
    category: 'transient',
    code: 'outcome_unknown',
  });
  expect(f.ledger.byCommand('spawn')?.state).toBe('pending');
});
it.each(['no_active_sender_terminal', 'stable_pane_required'])(
  'retries identity error %s once with unchanged argv',
  async (code) => {
    const f = await fixture();
    let count = 0;
    f.setCustom(async (r) =>
      command(r, 'orchestration worker-start') && count++ === 0
        ? { error: code }
        : undefined,
    );
    await f.runtime.spawnAgent(f.spawn);
    const attempts = f.calls.filter((r) =>
      command(r, 'orchestration worker-start'),
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.args).toEqual(attempts[1]!.args);
    expect(f.identity.ensure).toHaveBeenCalledWith({ force: true });
  },
);
it('does not retry request mismatch or hijacked ownership', async () => {
  const f = await fixture();
  f.setCustom(async (r) =>
    command(r, 'orchestration worker-start')
      ? { error: 'request_mismatch' }
      : undefined,
  );
  await expect(f.runtime.spawnAgent(f.spawn)).rejects.toMatchObject({
    category: 'bug',
  });
  expect(
    f.calls.filter((r) => command(r, 'orchestration worker-start')),
  ).toHaveLength(1);
  const g = await fixture();
  vi.mocked(g.identity.checkOwnership).mockResolvedValue('hijacked');
  await expect(g.runtime.spawnAgent(g.spawn)).rejects.toMatchObject({
    category: 'hijacked',
  });
  expect(g.calls.some((r) => command(r, 'orchestration worker-start'))).toBe(
    false,
  );
});
it('maps follow-up dispatches to the original agent and keeps replay targets stable', async () => {
  const f = await fixture();
  await f.runtime.spawnAgent(f.spawn);
  f.setCustom(async (r) =>
    command(r, 'orchestration send')
      ? {
          result: {
            state: 'ready',
            dispatchId: 'follow',
            delivery: 'follow_up',
            followUpOf: 'ctx',
          },
        }
      : undefined,
  );
  const msg = {
    subject: 'next',
    body: 'Continue',
    correlation: { ...correlation, commandId: 'send' },
  };
  await f.runtime.send(agentRef('ctx'), msg);
  expect(f.ledger.agentFor('follow')).toBe('ctx');
  await f.runtime.send(agentRef('ctx'), msg);
  expect(f.calls.filter((r) => command(r, 'orchestration send'))).toHaveLength(
    1,
  );
  expect(f.calls.find((r) => command(r, 'orchestration send'))?.args).toContain(
    `${marker('send')} next`,
  );
  await f.runtime.stop(agentRef('ctx'));
  expect(
    f.calls.find((r) => command(r, 'orchestration worker-stop'))?.args,
  ).toContain('follow');
  await f.runtime.release(agentRef('ctx'), { removeWorkspace: true });
  expect(f.calls.some((r) => command(r, 'worktree rm'))).toBe(false);
});
it('settles a send delivered into a working dispatch without leaving it pending (M2-FX12 b)', async () => {
  const f = await fixture();
  await f.runtime.spawnAgent(f.spawn);
  f.setCustom(async (r) =>
    command(r, 'orchestration send')
      ? { result: { state: 'ready', dispatchId: 'ctx' } }
      : undefined,
  );
  await f.runtime.send(agentRef('ctx'), {
    subject: 'forward',
    body: 'Question for you',
    correlation: { ...correlation, commandId: 'forward' },
  });
  expect(f.ledger.byCommand('forward')).toBeUndefined();
  expect(f.ledger.all().some((e) => e.state === 'pending')).toBe(false);
  expect(f.ledger.agentFor('ctx')).toBe('ctx');
});
it('guards unmanaged and auto-released dispatches', async () => {
  const f = await fixture();
  await expect(
    f.runtime.send(agentRef('unknown'), {
      subject: 'x',
      body: 'x',
      correlation,
    }),
  ).rejects.toMatchObject({ code: 'dispatch_not_managed' });
  await f.runtime.spawnAgent({ ...f.spawn, keepOpen: false });
  f.workers.push({
    dispatchId: 'ctx',
    taskId: 't',
    runId: 'run',
    terminalState: 'released',
  });
  await expect(
    f.runtime.send(agentRef('ctx'), {
      subject: 'x',
      body: 'x',
      correlation: { ...correlation, commandId: 'released-send' },
    }),
  ).rejects.toMatchObject({ code: 'dispatch_released' });
});
it('pages worker-list and resolves caller with pane verification', async () => {
  const f = await fixture();
  f.tasks.push({ id: 't', title: 'aio:spawn Work' });
  f.setCustom(async (r) =>
    command(r, 'orchestration worker-list')
      ? {
          result: r.args.includes('--cursor')
            ? {
                workers: [
                  {
                    dispatchId: 'ctx',
                    taskId: 't',
                    runId: 'run',
                    agentTerminalHandle: 'term_worker',
                  },
                ],
              }
            : // Orca 1.4.259 reports the cursor under `page` (M2-FX13).
              { workers: [], page: { hasMore: true, nextCursor: 'page2' } },
        }
      : undefined,
  );
  expect(
    await f.runtime.resolveCaller({
      terminalHandle: 'term_worker',
      paneKey: 'pane',
    }),
  ).toBe('ctx');
  expect(
    await f.runtime.resolveCaller({
      terminalHandle: 'term_worker',
      paneKey: 'wrong',
    }),
  ).toBeNull();
});
it('refuses a worker-list page with more rows but no cursor (M2-FX13)', async () => {
  const f = await fixture();
  f.setCustom(async (r) =>
    command(r, 'orchestration worker-list')
      ? { result: { workers: [], page: { hasMore: true, nextCursor: null } } }
      : undefined,
  );
  await expect(
    f.runtime.resolveCaller({ terminalHandle: 'term_worker', paneKey: 'pane' }),
  ).rejects.toMatchObject({ code: 'runtime_contract_mismatch' });
});
it('answers only a known run question and leaves a recoverable marker', async () => {
  const f = await fixture();
  f.setCustom(async (r) =>
    command(r, 'orchestration inbox')
      ? { result: { messages: [{ id: 'q', type: 'question' }] } }
      : undefined,
  );
  await f.runtime.answer(questionRef('q'), 'Approved', correlation);
  const reply = f.calls.find((r) => command(r, 'orchestration reply'))!;
  expect(reply.args).toContain(`${marker('command')}\nApproved`);
  expect(await f.runtime.findCommandByMarker('command')).toEqual({
    kind: 'runtime.answer',
    result: {},
  });
});
it('opens, recovers and reclaims sessions, reports cached health, and inspects repo', async () => {
  const f = await fixture();
  expect(
    await f.runtime.openSession({
      workflowId: 'wf',
      repo,
      objective: 'Build',
      correlation: { ...correlation, commandId: 'open' },
    }),
  ).toBe('run');
  expect(await f.runtime.findCommandByMarker('open')).toEqual({
    kind: 'runtime.openSession',
    result: { session: 'run' },
  });
  expect(await f.runtime.reclaimSession(session)).toEqual({ reclaimed: true });
  await f.runtime.closeSession(session);
  expect(await f.runtime.inspectLocalRepo('/repo')).toEqual({
    isGitMainWorktree: true,
    originUrl: 'https://example.test/repo',
    runtimeRepoId: 'repo',
  });
  await f.runtime.health();
  await f.runtime.health();
  expect(f.options.version.check).toHaveBeenCalledTimes(1);
});
it('honors replayed receipts and reports pending, absent and completed requests', async () => {
  const f = await fixture();
  let result: unknown = { state: 'pending' };
  f.setCustom(async (r) =>
    command(r, 'orchestration request-show')
      ? { result }
      : command(r, 'orchestration run-create')
        ? { result: { run: { id: 'run' }, mutation: { replayed: true } } }
        : undefined,
  );
  expect(await f.runtime.inspectRequest('request', 'open')).toEqual({
    status: 'pending',
  });
  result = { state: 'absent' };
  expect(await f.runtime.inspectRequest('request', 'open')).toEqual({
    status: 'absent',
  });
  result = {
    state: 'completed',
    method: 'orchestration.runCreate',
    receipt: {
      run: { id: 'run', objective: 'aio:open' },
      mutation: { replayed: true },
    },
  };
  expect(await f.runtime.inspectRequest('request', 'open')).toEqual({
    status: 'completed',
    result: { kind: 'runtime.openSession', result: { session: 'run' } },
  });
  expect(
    await f.runtime.openSession({
      workflowId: 'wf',
      repo,
      objective: 'Build',
      correlation,
    }),
  ).toBe('run');
});
it('retries failed-start cleanup without starting another worker', async () => {
  const f = await fixture();
  f.workers.push({
    dispatchId: 'ctx',
    taskId: 'task',
    runId: 'run',
    workerState: 'failed',
  });
  f.tasks.push({ id: 'task', title: 'aio:spawn Work' });
  let releases = 0;
  f.setCustom(async (r) =>
    command(r, 'orchestration worker-start')
      ? { result: { state: 'failed', dispatchId: 'ctx' } }
      : command(r, 'orchestration worker-release') && releases++ === 0
        ? { error: 'runtime_unavailable' }
        : undefined,
  );
  await expect(f.runtime.spawnAgent(f.spawn)).rejects.toMatchObject({
    category: 'transient',
  });
  await expect(f.runtime.spawnAgent(f.spawn)).rejects.toMatchObject({
    code: 'failed',
  });
  expect(
    f.calls.filter((r) => command(r, 'orchestration worker-start')),
  ).toHaveLength(1);
  expect(releases).toBe(2);
});
it('does not upgrade a pending spawn when caller resolution rebuilds concurrently', async () => {
  const f = await fixture();
  let resume!: () => void, entered!: () => void;
  const inside = new Promise<void>((r) => {
    entered = r;
  });
  const wait = new Promise<void>((r) => {
    resume = r;
  });
  f.workers.push({
    dispatchId: 'ctx',
    taskId: 'task',
    runId: 'run',
    agentTerminalHandle: 'term_worker',
  });
  f.tasks.push({ id: 'task', title: 'aio:spawn Work' });
  f.setCustom(async (r) => {
    if (command(r, 'orchestration worker-start')) {
      entered();
      await wait;
    }
    return undefined;
  });
  const spawn = f.runtime.spawnAgent(f.spawn);
  await inside;
  expect(
    await f.runtime.resolveCaller({ terminalHandle: 'term_worker' }),
  ).toBeNull();
  expect(f.ledger.byCommand('spawn')?.state).toBe('pending');
  resume();
  expect(await spawn).toBe('ctx');
});
it('rejects a suffixed workspace left by an interrupted create instead of replaying it', async () => {
  const f = await fixture();
  const w = f.worktrees()[0]!;
  w.displayName = f.prepare.name;
  w.branch = 'refs/heads/ai-office/work-2';
  f.inventory[0]!.branch = w.branch;
  await expect(f.runtime.prepareWorkspace(f.prepare)).rejects.toMatchObject({
    code: 'branch_suffixed',
  });
  expect(f.calls.some((r) => command(r, 'worktree rm'))).toBe(true);
});
it('fetches legacy new-worktree spawn bases and removes only its owned worktree on release', async () => {
  const f = await fixture();
  const a = await f.runtime.spawnAgent({
    ...f.spawn,
    workspace: {
      kind: 'new-worktree',
      baseBranch: 'main',
      name: 'planner',
      branch: 'ai-office/planner',
    },
  });
  expect(f.git.fetch).toHaveBeenCalledWith('/repo', 'main');
  const created = f.calls.find((r) => command(r, 'worktree create'))!;
  expect(created.args).toContain(sha);
  await f.runtime.release(a, { removeWorkspace: true });
  expect(f.calls.some((r) => command(r, 'worktree rm'))).toBe(true);
});
it('reports the worktree a new-worktree spawn created, also in its saved result (M5 §4.2)', async () => {
  const f = await fixture();
  const p = await f.runtime.prepareWorkspace(f.prepare);
  await f.runtime.spawnAgent({
    ...f.spawn,
    workspace: {
      kind: 'existing-worktree',
      workspace: p.workspace,
      readOnly: false,
    },
  });
  // An existing worktree belongs to its prepareWorkspace, not to the spawn.
  expect(f.runtime.spawnedWorkspace!('spawn')).toBeUndefined();
  expect(await f.runtime.findCommandByMarker('spawn')).toEqual({
    kind: 'runtime.spawnAgent',
    result: { agent: 'ctx' },
  });
  const g = await fixture();
  await g.runtime.spawnAgent({
    ...g.spawn,
    workspace: {
      kind: 'new-worktree',
      baseBranch: 'main',
      name: 'planner',
      branch: 'ai-office/planner',
    },
  });
  const created = g.runtime.spawnedWorkspace!('spawn');
  expect(created).toEqual(expect.any(String));
  expect(await g.runtime.findCommandByMarker('spawn')).toEqual({
    kind: 'runtime.spawnAgent',
    result: { agent: 'ctx', workspace: created },
  });
  expect(g.runtime.spawnedWorkspace!('unknown')).toBeUndefined();
});
it.each([false, true])(
  'release of backend-prepared existing workspaces honors removeWorkspace=%s',
  async (removeWorkspace) => {
    const f = await fixture();
    const p = await f.runtime.prepareWorkspace(f.prepare);
    const agent = await f.runtime.spawnAgent({
      ...f.spawn,
      workspace: {
        kind: 'existing-worktree',
        workspace: p.workspace,
        readOnly: false,
      },
    });
    await f.runtime.release(agent, { removeWorkspace });
    expect(
      f.calls.some(
        (r) =>
          command(r, 'worktree rm') && r.args.includes(`id:${p.workspace}`),
      ),
    ).toBe(removeWorkspace);
  },
);
it('preserves a prepared existing workspace when another unreleased agent shares it', async () => {
  const f = await fixture();
  const p = await f.runtime.prepareWorkspace(f.prepare);
  let i = 0;
  f.setCustom(async (r) =>
    command(r, 'orchestration worker-start')
      ? { result: { state: 'ready', dispatchId: `ctx-${++i}` } }
      : undefined,
  );
  const request = {
    ...f.spawn,
    workspace: {
      kind: 'existing-worktree' as const,
      workspace: p.workspace,
      readOnly: true,
    },
  };
  const first = await f.runtime.spawnAgent(request);
  const second = await f.runtime.spawnAgent({
    ...request,
    correlation: { ...correlation, commandId: 'second' },
  });
  await expect(
    f.runtime.release(first, { removeWorkspace: true }),
  ).rejects.toMatchObject({ code: 'workspace_in_use' });
  expect(f.calls.some((r) => command(r, 'worktree rm'))).toBe(false);
  await f.runtime.release(second, { removeWorkspace: true });
  expect(f.calls.some((r) => command(r, 'worktree rm'))).toBe(true);
});
it('preserves backend-prepared existing workspaces with unpushed commits', async () => {
  const f = await fixture();
  const p = await f.runtime.prepareWorkspace(f.prepare);
  const agent = await f.runtime.spawnAgent({
    ...f.spawn,
    workspace: {
      kind: 'existing-worktree',
      workspace: p.workspace,
      readOnly: false,
    },
  });
  vi.mocked(f.git.revParse).mockResolvedValue('b'.repeat(40));
  vi.mocked(f.git.originContains).mockResolvedValue(false);
  await expect(
    f.runtime.release(agent, { removeWorkspace: true }),
  ).rejects.toMatchObject({ code: 'workspace_unpushed' });
  expect(f.calls.some((r) => command(r, 'worktree rm'))).toBe(false);
});
it('warns for chat receipts without changing Orca settings', async () => {
  const f = await fixture();
  await f.runtime.health();
  f.setCustom(async (r) =>
    command(r, 'orchestration worker-start')
      ? {
          result: { state: 'ready', dispatchId: 'ctx', mode: { mode: 'chat' } },
        }
      : undefined,
  );
  await f.runtime.spawnAgent(f.spawn);
  expect((await f.runtime.health()).warnings).toContain(
    'chat_worker_identity_degraded',
  );
  expect((await createOrcaRuntime(f.options).health()).warnings).toContain(
    'chat_worker_identity_degraded',
  );
});
it('does not repeat worker-start while the original request is still pending', async () => {
  const f = await fixture();
  f.ledger.pending({ commandId: 'spawn', run: 'run', keepOpen: true });
  f.setCustom(async (r) =>
    command(r, 'orchestration request-show')
      ? { result: { state: 'pending' } }
      : undefined,
  );
  await expect(f.runtime.spawnAgent(f.spawn)).rejects.toMatchObject({
    category: 'transient',
    code: 'outcome_unknown',
  });
  expect(f.calls.some((r) => command(r, 'orchestration worker-start'))).toBe(
    false,
  );
});
it('reports a missing checkout even when Orca retains a stale catalog entry', async () => {
  const f = await fixture();
  vi.mocked(f.git.status).mockRejectedValue(
    new PortError('permanent', 'git_command_failed', 'Git command failed'),
  );
  expect(await f.runtime.inspectWorkspace(f.spawn.workspace.workspace)).toEqual(
    { clean: false, changedFiles: [] },
  );
});
it('recovers a reply marker from the dispatch inbox when the receipt and local result are absent', async () => {
  const f = await fixture();
  f.workers.push({ dispatchId: 'ctx', taskId: 'task', runId: 'run' });
  f.tasks.push({ id: 'task', title: 'aio:spawn Work' });
  f.setCustom(async (r) =>
    command(r, 'orchestration inbox') && r.args.includes('dispatch:ctx')
      ? {
          result: {
            messages: [
              {
                id: 'reply',
                thread_id: 'question',
                type: 'status',
                body: 'aio:answered\nApproved',
              },
            ],
          },
        }
      : undefined,
  );
  expect(await f.runtime.findCommandByMarker('answered')).toEqual({
    kind: 'runtime.answer',
    result: {},
  });
});
it('targets the latest resource owner after a follow-up receipt was lost and workers arrive newest first', async () => {
  const f = await fixture();
  await f.runtime.spawnAgent(f.spawn);
  f.workers.push(
    {
      dispatchId: 'follow',
      taskId: 'new',
      runId: 'run',
      followUpOf: 'ctx',
      resource: { originDispatchId: 'ctx', ownerDispatchId: 'follow' },
    },
    { dispatchId: 'ctx', taskId: 'old', runId: 'run' },
  );
  f.tasks.push(
    { id: 'new', title: 'aio:next Work' },
    { id: 'old', title: 'aio:spawn Work' },
  );
  await f.runtime.stop(agentRef('ctx'));
  expect(
    f.calls.find((r) => command(r, 'orchestration worker-stop'))?.args,
  ).toContain('follow');
});
it('retries a release that raced a stop under a fresh request id, and accepts a settled dispatch (M2-T17 D8)', async () => {
  const f = await fixture();
  await f.runtime.spawnAgent(f.spawn);
  // Still stopping: Orca refuses the release and the worker is not settled.
  f.workers.push({
    dispatchId: 'ctx',
    taskId: 'task',
    runId: 'run',
    workerState: 'ready',
    terminalState: 'retained',
  });
  let refusals = 1;
  f.setCustom(async (r) =>
    command(r, 'orchestration worker-release') && refusals-- > 0
      ? { error: 'dispatch_inactive' }
      : undefined,
  );
  await expect(
    f.runtime.release(agentRef('ctx'), { removeWorkspace: false }),
  ).rejects.toMatchObject({
    category: 'transient',
    code: 'release_pending_stop',
  });
  // The retry carries a new request key (`release:ctx#1`), so Orca cannot
  // replay the stored refusal; it then succeeds once the stop has settled.
  expect(f.state.read('orca:release-retry:ctx')).toBe(1);
  await f.runtime.release(agentRef('ctx'), { removeWorkspace: false });
  expect(
    f.calls.filter((r) => command(r, 'orchestration worker-release')),
  ).toHaveLength(2);
  // Already settled with its terminal released: the refusal means released.
  const g = await fixture();
  await g.runtime.spawnAgent(g.spawn);
  g.workers.push({
    dispatchId: 'ctx',
    taskId: 'task',
    runId: 'run',
    workerState: 'stopped',
    terminalState: 'released',
  });
  g.setCustom(async (r) =>
    command(r, 'orchestration worker-release')
      ? { error: 'dispatch_inactive' }
      : undefined,
  );
  await expect(
    g.runtime.release(agentRef('ctx'), { removeWorkspace: false }),
  ).resolves.toBeUndefined();
});
it('treats a worktree Orca reports as selector_not_found as already disposed (M2-T17 D9)', async () => {
  const f = await fixture();
  f.setCustom(async (r) =>
    command(r, 'worktree show') ? { error: 'selector_not_found' } : undefined,
  );
  await expect(
    f.runtime.disposeWorkspace(workspaceRef('wt-gone')),
  ).resolves.toBeUndefined();
  expect(f.calls.some((r) => command(r, 'worktree rm'))).toBe(false);
});

it.each([
  'integrator',
  'worker',
  'other-pushed-branch',
  'unpushed',
  'unpushed-branch',
] as const)(
  'checks detached %s tips independently of the created branch',
  async (shape) => {
    const f = await fixture();
    const request = { ...f.prepare, branch: 'ai-office/wf/merge-1' };
    const p = await f.runtime.prepareWorkspace(request);
    const w = f.worktrees().find((w) => w.id === p.workspace)!;
    w.branch = '';
    const tip = 'b'.repeat(40);
    const branchSha =
      shape === 'worker'
        ? tip
        : shape === 'integrator' || shape === 'unpushed'
          ? sha
          : 'c'.repeat(40);
    vi.mocked(f.git.revParse).mockResolvedValue(tip);
    vi.mocked(f.git.localBranch).mockResolvedValue(branchSha);
    vi.mocked(f.git.originContains).mockImplementation(
      async (_repo, value) =>
        !(shape === 'unpushed' && value === tip) &&
        !(shape === 'unpushed-branch' && value === branchSha),
    );
    if (shape === 'unpushed' || shape === 'unpushed-branch') {
      await expect(
        f.runtime.disposeWorkspace(p.workspace),
      ).rejects.toMatchObject({
        category: 'guard',
        code: 'workspace_unpushed',
      });
      expect(f.worktrees()).toContain(w);
      expect(f.git.deleteCreatedBranch).not.toHaveBeenCalled();
      expect(f.calls.some((r) => command(r, 'worktree rm'))).toBe(false);
    } else {
      await f.runtime.disposeWorkspace(p.workspace);
      expect(f.git.deleteCreatedBranch).toHaveBeenCalledWith(
        '/repo',
        request.branch,
        branchSha,
      );
      expect(
        f.calls.find((r) => command(r, 'worktree rm'))!.args,
      ).not.toContain('--delete-branch');
    }
    expect(f.git.fetch).toHaveBeenLastCalledWith('/repo');
    expect(f.git.fetch).not.toHaveBeenCalledWith(expect.anything(), '');
  },
);

it('surfaces a separate branch deletion failure after removing a detached workspace', async () => {
  const f = await fixture();
  const p = await f.runtime.prepareWorkspace(f.prepare);
  const agent = await f.runtime.spawnAgent({
    ...f.spawn,
    workspace: {
      kind: 'existing-worktree',
      workspace: p.workspace,
      readOnly: false,
    },
  });
  f.worktrees().find((w) => w.id === p.workspace)!.branch = '';
  vi.mocked(f.git.revParse).mockResolvedValue('b'.repeat(40));
  vi.mocked(f.git.localBranch).mockResolvedValue(sha);
  vi.mocked(f.git.deleteCreatedBranch).mockRejectedValue(
    new PortError('guard', 'unpushed_commits', 'Branch changed'),
  );
  await expect(
    f.runtime.release(agent, { removeWorkspace: true }),
  ).rejects.toMatchObject({ code: 'unpushed_commits' });
  expect(f.calls.find((r) => command(r, 'worktree rm'))!.args).not.toContain(
    '--delete-branch',
  );
});
