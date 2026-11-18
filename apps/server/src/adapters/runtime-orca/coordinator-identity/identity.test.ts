import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PortError } from '../../../ports/errors.js';
import { RuntimeEventSchema } from '../../../ports/runtime-events.js';
import { CwdGuard, DefaultOrcaCli } from '../index.js';
import type { ExecRequest } from '../cli/types.js';
import type { AdapterState } from '../state.js';
import { ShimCoordinatorIdentity, shimMarker } from './shim.js';

const dataDir = '/tmp/aio-data';
const home = join(dataDir, 'orca-home');
const marker = shimMarker(dataDir);
const RUN = 'run_3d70ed17e5de';
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
type Terminal = {
  handle: string;
  title?: string | null;
  incarnationId?: string;
};
interface World {
  repos: string[];
  terminals: Terminal[];
  runs: Record<
    string,
    { coordinator_handle: string; consumer_generation: number }
  >;
  created: number;
  /** Responses by command words, consumed before the world's own behaviour. */
  failures: Record<string, string[]>;
}
const ok = (result: unknown) => JSON.stringify({ ok: true, result });
const err = (code: string) => JSON.stringify({ ok: false, error: { code } });
const flag = (args: readonly string[], name: string) =>
  args[args.indexOf(name) + 1]!;
function memory(): AdapterState {
  const values = new Map<string, unknown>();
  return {
    read: (key) => structuredClone(values.get(key) ?? null),
    write: (key, value) => void values.set(key, structuredClone(value)),
  };
}
/** Replay exec: answers like Orca 1.4.259 (fixture shapes) from a small world model. */
function respond(world: World, args: readonly string[]): string {
  const words = args.slice(0, 2).join(' ');
  const failure = world.failures[words]?.shift();
  if (failure) return err(failure);
  switch (words) {
    case 'repo list':
      return ok({ repos: world.repos.map((path) => ({ id: 'r', path })) });
    case 'terminal list':
      return ok({ terminals: world.terminals, truncated: false });
    case 'terminal create': {
      const terminal = {
        handle: `term_00000000-0000-4000-8000-${String(++world.created).padStart(12, '0')}`,
        title: flag(args, '--title'),
        incarnationId: `inc-${world.created}`,
      };
      world.terminals.push(terminal);
      return ok({ terminal });
    }
    case 'terminal close': {
      const handle = flag(args, '--terminal');
      world.terminals = world.terminals.filter((t) => t.handle !== handle);
      return ok({ closed: 1 });
    }
    case 'orchestration run-show':
      return ok({
        run: { id: flag(args, '--id'), ...world.runs[flag(args, '--id')] },
      });
    case 'orchestration run-use': {
      const run = world.runs[flag(args, '--id')]!;
      run.coordinator_handle = flag(args, '--from');
      run.consumer_generation += 1;
      return ok({ run: { id: flag(args, '--id'), ...run } });
    }
    default:
      return ok({});
  }
}
async function setup(
  overrides: Partial<World> = {},
  options: { repoMainWorktree?: string; closeOnExit?: boolean } = {},
) {
  const world: World = {
    repos: [home],
    terminals: [],
    runs: {},
    created: 0,
    failures: {},
    ...overrides,
  };
  const requests: ExecRequest[] = [];
  const cliCwd = await mkdtemp(join(tmpdir(), 'aio-identity-'));
  dirs.push(cliCwd);
  let clock = 1_800_000_000_000;
  const state = memory();
  const identityRef: { current?: ShimCoordinatorIdentity } = {};
  const cli = new DefaultOrcaCli({
    bin: '/bin/orca',
    env: { PATH: '/bin', HOME: '/tmp/home' },
    cwdGuard: new CwdGuard(cliCwd, async () => []),
    identity: {
      argsFor: (kind, run, context) =>
        identityRef.current!.argsFor(kind, run, context),
    },
    exec: {
      run: async (request) => {
        requests.push(request);
        return { exitCode: 0, stdout: respond(world, request.args) };
      },
    },
  });
  const make = () =>
    (identityRef.current = new ShimCoordinatorIdentity({
      cli,
      state,
      dataDir,
      shimLocation: 'folder-workspace',
      now: () => clock,
      ...options,
    }));
  const identity = make();
  const calls = (words: string) =>
    requests.filter((r) => r.args.slice(0, 2).join(' ') === words);
  return {
    world,
    identity,
    cli,
    requests,
    calls,
    restart: make,
    advance: (ms: number) => (clock += ms),
  };
}

describe('CoordinatorIdentity argsFor', () => {
  it('maps kinds to identity flags and scopes inbox and terminal targets', async () => {
    const { identity, calls } = await setup();
    const shim = (await identity.ensure({ force: true })).handle;
    expect(await identity.argsFor('mutate', RUN)).toEqual(['--from', shim]);
    expect(await identity.argsFor('consume', RUN)).toEqual([
      '--terminal',
      shim,
      '--run',
      RUN,
    ]);
    expect(await identity.argsFor('read', RUN)).toEqual([]);
    expect(
      await identity.argsFor('read', undefined, {
        command: ['orchestration', 'inbox'],
        mailbox: { kind: 'run', id: RUN },
      }),
    ).toEqual(['--terminal', `run:${RUN}`]);
    expect(
      await identity.argsFor('mutate', undefined, {
        command: ['worktree', 'create'],
      }),
    ).toEqual([]);
    expect(
      await identity.argsFor('read', undefined, {
        command: ['terminal', 'show'],
      }),
    ).toEqual(['--terminal', shim]);
    await expect(
      identity.argsFor('mutate', undefined, {
        command: ['terminal', 'close'],
        terminal: shim,
      }),
    ).rejects.toMatchObject({ code: 'terminal_close_not_permitted' });
    await expect(identity.argsFor('consume')).rejects.toMatchObject({
      code: 'consume_run_required',
    });
    expect(calls('terminal create')).toHaveLength(1);
  });
  it('creates the shim lazily for the first mutating command', async () => {
    const { identity, calls } = await setup();
    const args = await identity.argsFor('mutate', RUN);
    expect(args[1]).toMatch(/^term_/);
    expect(calls('terminal create')).toHaveLength(1);
  });
});

describe('CoordinatorIdentity shim lifecycle', () => {
  it('creates the shim in the registered folder workspace with the hashed title', async () => {
    const { identity, calls } = await setup();
    const status = await identity.ensure({ force: true });
    expect(status.restored).toBe(false);
    const [create] = calls('terminal create');
    expect(create!.args).toEqual([
      'terminal',
      'create',
      '--worktree',
      `path:${home}`,
      '--title',
      `AI Office · 請勿關閉 ${marker}`,
      '--command',
      'exec cat > /dev/null',
      '--json',
    ]);
    expect(create!.args).not.toContain('--from');
    expect(calls('terminal list')[0]!.args).toContain(`path:${home}`);
    expect(identity.health()).toEqual({
      shim: 'ready',
      shimLocation: home,
      ownership: 'none',
      warnings: [],
    });
  });
  it('never registers the folder workspace: setup error, or explicit fallback with a warning', async () => {
    const missing = await setup({ repos: [] });
    await expect(
      missing.identity.ensure({ force: true }),
    ).rejects.toMatchObject({
      category: 'guard',
      code: 'shim_folder_workspace_unregistered',
    });
    expect(missing.calls('terminal create')).toHaveLength(0);
    expect(missing.requests.some((r) => r.args[1] === 'add')).toBe(false);
    const fallback = await setup({ repos: [] }, { repoMainWorktree: '/repo' });
    await fallback.identity.ensure({ force: true });
    expect(fallback.calls('terminal create')[0]!.args).toContain('path:/repo');
    expect(fallback.identity.health().warnings).toEqual([
      'shim_folder_fallback',
    ]);
  });
  it('adopts one titled shim, keeps the newest of duplicates and closes only titled ones', async () => {
    const { identity, world, calls } = await setup({
      terminals: [
        { handle: 'term_old', title: `AI Office · 請勿關閉 ${marker}` },
        { handle: 'term_user', title: 'my shell' },
        {
          handle: 'term_other',
          title: 'AI Office · 請勿關閉 aio-shim:ffffffffffff',
        },
        { handle: 'term_new', title: `AI Office · 請勿關閉 ${marker}` },
      ],
    });
    const status = await identity.ensure({ force: true });
    expect(status.handle).toBe('term_new');
    expect(calls('terminal create')).toHaveLength(0);
    expect(
      calls('terminal close').map((r) => flag(r.args, '--terminal')),
    ).toEqual(['term_old']);
    expect(world.terminals.map((t) => t.handle)).toEqual([
      'term_user',
      'term_other',
      'term_new',
    ]);
  });
  it('P2a: keeps a listed shim with the same incarnation even with a null title', async () => {
    const { identity, world, calls, restart, advance } = await setup();
    const { handle } = await identity.ensure({ force: true });
    await identity.track(RUN, {
      id: RUN,
      coordinator_handle: handle,
      consumer_generation: 1,
    });
    world.runs[RUN] = { coordinator_handle: handle, consumer_generation: 1 };
    world.terminals[0]!.title = null;
    advance(60_000);
    const after = restart();
    const status = await after.ensure({ force: true });
    expect(status).toEqual({ handle, restored: false });
    expect(calls('terminal create')).toHaveLength(1);
    expect(calls('orchestration run-use')).toHaveLength(0);
    expect(after.drainEvents()).toEqual([]);
    expect(await after.checkOwnership(RUN, { force: true })).toBe('owned');
  });
  it('shim gone: recreate, run-use each run once, identity_restored, then no false hijack', async () => {
    const { identity, world, calls, advance } = await setup();
    const { handle: old } = await identity.ensure({ force: true });
    world.runs = {
      [RUN]: { coordinator_handle: old, consumer_generation: 1 },
      run_b: { coordinator_handle: old, consumer_generation: 1 },
    };
    await identity.track(RUN);
    await identity.track('run_b');
    world.terminals = [];
    const status = await identity.ensure({ force: true });
    expect(status.restored).toBe(true);
    expect(status.handle).not.toBe(old);
    expect(status.runs).toEqual([RUN, 'run_b']);
    const uses = calls('orchestration run-use');
    expect(uses).toHaveLength(2);
    for (const use of uses) {
      expect(flag(use.args, '--from')).toBe(status.handle);
      expect(flag(use.args, '--retry-request')).toMatch(/^[0-9a-f-]{36}$/);
      expect(use.args).toContain('--full');
    }
    const events = identity.drainEvents();
    expect(events).toHaveLength(1);
    expect(RuntimeEventSchema.parse(events[0])).toMatchObject({
      type: 'runtime.identity_restored',
      newShim: status.handle,
      runs: [RUN, 'run_b'],
    });
    expect(world.runs[RUN]!.consumer_generation).toBe(2);
    advance(31_000);
    expect(await identity.checkOwnership(RUN)).toBe('owned');
    expect(identity.drainEvents()).toEqual([]);
  });
  it('treats a changed incarnation for the same handle as a lost shim', async () => {
    const { identity, world, calls } = await setup();
    const { handle } = await identity.ensure({ force: true });
    world.terminals[0]!.incarnationId = 'inc-reborn';
    const status = await identity.ensure({ force: true });
    expect(status.handle).not.toBe(handle);
    expect(calls('terminal create')).toHaveLength(2);
  });
  it('throttles ensure to once per 30 seconds unless forced and shares a pass', async () => {
    const { identity, calls, advance } = await setup();
    await Promise.all([
      identity.ensure({ force: true }),
      identity.ensure({ force: true }),
    ]);
    expect(calls('terminal list')).toHaveLength(1);
    advance(10_000);
    await identity.ensure();
    expect(calls('terminal list')).toHaveLength(1);
    await identity.ensure({ force: true });
    expect(calls('terminal list')).toHaveLength(2);
    advance(30_000);
    await identity.ensure();
    expect(calls('terminal list')).toHaveLength(3);
  });
  it('closes the shim on exit only when configured; the next start rebinds runs', async () => {
    const kept = await setup();
    await kept.identity.ensure({ force: true });
    await kept.identity.close();
    expect(kept.calls('terminal close')).toHaveLength(0);
    const closing = await setup({}, { closeOnExit: true });
    const { handle } = await closing.identity.ensure({ force: true });
    closing.world.runs[RUN] = {
      coordinator_handle: handle,
      consumer_generation: 1,
    };
    await closing.identity.track(RUN);
    await closing.identity.close();
    expect(closing.world.terminals).toEqual([]);
    const next = closing.restart();
    const status = await next.ensure({ force: true });
    expect(status).toMatchObject({ restored: true, runs: [RUN] });
  });
});

describe('CoordinatorIdentity configuration edges', () => {
  it('uses the repo main worktree when configured, without repo list', async () => {
    const s = await setup({ repos: [] }, { repoMainWorktree: '/repo' });
    const identity = new ShimCoordinatorIdentity({
      cli: s.cli,
      state: memory(),
      dataDir,
      shimLocation: 'repo-main-worktree',
    });
    await expect(identity.ensure({ force: true })).rejects.toMatchObject({
      code: 'shim_location_unavailable',
    });
  });
  it('tolerates a stale duplicate on close and forgets untracked runs', async () => {
    const { identity, world, calls } = await setup({
      terminals: [
        { handle: 'term_a', title: `x ${marker}` },
        { handle: 'term_b', title: `x ${marker}` },
      ],
      failures: { 'terminal close': ['terminal_handle_stale'] },
    });
    expect((await identity.ensure({ force: true })).handle).toBe('term_b');
    expect(calls('terminal close')).toHaveLength(1);
    world.runs[RUN] = { coordinator_handle: 'term_b', consumer_generation: 1 };
    await identity.track(RUN);
    expect(identity.health().ownership).toBe('owned');
    identity.untrack(RUN);
    expect(identity.health().ownership).toBe('none');
  });
});

describe('CoordinatorIdentity ownership and reclaim', () => {
  async function owned() {
    const s = await setup();
    const { handle } = await s.identity.ensure({ force: true });
    s.world.runs[RUN] = { coordinator_handle: handle, consumer_generation: 1 };
    await s.identity.track(RUN);
    return { ...s, handle };
  }
  it('consumer_fenced emits identity_hijacked at once and never calls run-use', async () => {
    const { identity, world, cli, calls } = await owned();
    world.runs[RUN] = {
      coordinator_handle: 'term_intruder',
      consumer_generation: 2,
    };
    world.failures['orchestration check'] = ['consumer_fenced'];
    const check = () =>
      cli.run(['orchestration', 'check'], {
        kind: 'consume',
        run: RUN,
        priority: 'consume',
        requestId: '00000000-0000-4000-8000-000000000024',
      });
    await expect(identity.withIdentity(RUN, check)).rejects.toMatchObject({
      category: 'hijacked',
    });
    expect(identity.drainEvents()).toEqual([
      expect.objectContaining({
        type: 'runtime.identity_hijacked',
        run: RUN,
        coordinatorHandle: 'term_intruder',
        consumerGeneration: 2,
      }),
    ]);
    expect(calls('orchestration run-use')).toHaveLength(0);
    expect(identity.health().ownership).toBe('hijacked');
    // Hijacked runs are not rebound by ensure either, and the event is not repeated.
    world.terminals = [];
    await identity.ensure({ force: true });
    expect(calls('orchestration run-use')).toHaveLength(0);
    expect(await identity.checkOwnership(RUN, { force: true })).toBe(
      'hijacked',
    );
    expect(identity.drainEvents()).toEqual([]);
  });
  it('detects a generation change on our own handle as a hijack', async () => {
    const { identity, world, handle } = await owned();
    world.runs[RUN] = { coordinator_handle: handle, consumer_generation: 5 };
    expect(await identity.checkOwnership(RUN, { force: true })).toBe(
      'hijacked',
    );
  });
  it('throttles ownership checks per run', async () => {
    const { identity, calls, advance } = await owned();
    const before = calls('orchestration run-show').length;
    await identity.checkOwnership(RUN);
    await identity.checkOwnership(RUN);
    expect(calls('orchestration run-show')).toHaveLength(before + 1);
    advance(30_000);
    await identity.checkOwnership(RUN);
    expect(calls('orchestration run-show')).toHaveLength(before + 2);
  });
  it('reclaimSession rebinds once and is idempotent', async () => {
    const { identity, world, calls, handle } = await owned();
    world.runs[RUN] = {
      coordinator_handle: 'term_intruder',
      consumer_generation: 2,
    };
    await identity.checkOwnership(RUN, { force: true });
    identity.drainEvents();
    expect(await identity.reclaimSession(RUN)).toEqual({ reclaimed: true });
    expect(await identity.reclaimSession(RUN)).toEqual({ reclaimed: true });
    expect(calls('orchestration run-use')).toHaveLength(1);
    expect(world.runs[RUN]).toEqual({
      coordinator_handle: handle,
      consumer_generation: 3,
    });
    expect(await identity.checkOwnership(RUN, { force: true })).toBe('owned');
    expect(identity.health().ownership).toBe('owned');
    expect(identity.drainEvents()).toEqual([]);
  });
  it('identity error: ensure, then retry once with the same request id', async () => {
    const { identity, world, cli, calls, handle } = await owned();
    world.terminals = [];
    world.failures['orchestration send'] = ['no_active_sender_terminal'];
    const requestId = '00000000-0000-4000-8000-0000000000aa';
    const send = () =>
      cli.run(['orchestration', 'send', '--to', 'dispatch:ctx_1'], {
        kind: 'mutate',
        priority: 'mutate',
        requestId,
      });
    await identity.withIdentity(RUN, send);
    const sends = calls('orchestration send');
    expect(sends).toHaveLength(2);
    expect(sends.map((r) => flag(r.args, '--retry-request'))).toEqual([
      requestId,
      requestId,
    ]);
    expect(flag(sends[0]!.args, '--from')).toBe(handle);
    expect(flag(sends[1]!.args, '--from')).not.toBe(handle);
    expect(calls('orchestration run-use')).toHaveLength(1);
  });
  it('a second identity error is surfaced, not retried again', async () => {
    const { identity, world, cli, calls } = await owned();
    world.failures['orchestration send'] = [
      'no_active_sender_terminal',
      'stable_pane_required',
    ];
    const send = () =>
      cli.run(['orchestration', 'send'], {
        kind: 'mutate',
        priority: 'mutate',
        requestId: '00000000-0000-4000-8000-0000000000ab',
      });
    const error = await identity.withIdentity(RUN, send).catch((e) => e);
    expect(error).toBeInstanceOf(PortError);
    expect(error).toMatchObject({ category: 'identity' });
    expect(calls('orchestration send')).toHaveLength(2);
  });
});
