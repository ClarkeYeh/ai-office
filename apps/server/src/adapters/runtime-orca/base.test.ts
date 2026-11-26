import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, mkdir, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  DefaultOrcaCli,
  CwdGuard,
  CliScheduler,
  CliMetrics,
  DispatchLedger,
  DefaultGitCli,
  VersionMonitor,
  agentRef,
  encodeCursor,
  decodeCursor,
} from './index.js';
import { orcaError } from './errors.js';
import { ProcessGroups } from './cli/process.js';
import type { ExecRequest, ExecResult } from './cli/types.js';
import type { AdapterState } from './state.js';
import type { CoordinatorIdentity } from './coordinator-identity/index.js';
const dirs: string[] = [];
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'aio-runtime-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
function memory(): AdapterState {
  const values = new Map<string, unknown>();
  return {
    read: (key) => structuredClone(values.get(key) ?? null),
    write: (key, value) => {
      values.set(key, structuredClone(value));
    },
  };
}
const uuid = '00000000-0000-4000-8000-000000000001';
const env = {
  PATH: '/bin',
  HOME: '/tmp/home',
  USER: 'tester',
  ORCA_TERMINAL_HANDLE: 'hidden',
  CLAUDE_CODE_SESSION_ID: 'hidden',
  GH_TOKEN: 'hidden',
  CODEX_HOME: 'hidden',
  AI_OFFICE_TOKEN: 'hidden',
  GH_CONFIG_DIR: '/tmp/gh',
};
async function fixture(
  output: ExecResult = { exitCode: 0, stdout: '{"ok":true,"result":{}}' },
) {
  const requests: ExecRequest[] = [];
  const cwdGuard = new CwdGuard(await directory(), async () => []);
  const run = vi.fn(async (request: ExecRequest) => {
    requests.push(request);
    return output;
  });
  const cli = new DefaultOrcaCli({
    bin: '/bin/orca',
    env,
    cwdGuard,
    exec: { run },
    identity: {
      argsFor: async (kind, run) =>
        kind === 'mutate'
          ? ['--from', 'shim']
          : kind === 'consume'
            ? ['--terminal', 'shim', '--run', run!]
            : [],
    },
  });
  return { cli, requests, run, cwdGuard };
}
describe('CLI safety and receipts', () => {
  it('isolates environment, fixes cwd, centralizes identity and request ids', async () => {
    const f = await fixture();
    await f.cli.run(['orchestration', 'run-create'], {
      kind: 'mutate',
      priority: 'worker-read',
      requestId: uuid,
    });
    expect(f.requests[0]?.env).toEqual({
      PATH: '/bin',
      HOME: '/tmp/home',
      USER: 'tester',
    });
    expect(f.requests[0]?.cwd).toBe(await realpath(f.cwdGuard.cwd));
    expect(f.requests[0]?.args).toEqual([
      'orchestration',
      'run-create',
      '--from',
      'shim',
      '--json',
      '--full',
      '--retry-request',
      uuid,
    ]);
    for (const flag of [
      '--from',
      '--from=other',
      '--terminal',
      '--run',
      '--retry-request',
    ]) {
      await expect(
        f.cli.run(['status', flag], { kind: 'read', priority: 'identity' }),
      ).rejects.toMatchObject({ category: 'guard' });
    }
    await expect(
      f.cli.run(['orchestration', 'send'], {
        kind: 'mutate',
        priority: 'mutate',
      }),
    ).rejects.toMatchObject({ code: 'request_id_required' });
    expect(f.requests).toHaveLength(1);
  });
  it('consuming check gets shim, explicit run and durable request id', async () => {
    const f = await fixture();
    await f.cli.run(['orchestration', 'check', '--wait'], {
      kind: 'consume',
      run: 'run-a',
      priority: 'consume',
      requestId: uuid,
    });
    expect(f.requests[0]?.args).toEqual([
      'orchestration',
      'check',
      '--wait',
      '--terminal',
      'shim',
      '--run',
      'run-a',
      '--json',
      '--full',
      '--retry-request',
      uuid,
    ]);
  });
  it('accepts an unobserved turn despite exit 1; rejects failed/unknown receipts even with ok true', async () => {
    for (const state of [
      'ready',
      'turn_start_unobserved',
      'failed',
      'outcome_unknown',
    ]) {
      const f = await fixture({
        stdout: JSON.stringify({
          ok: true,
          result: { state, dispatchId: 'ctx-a' },
        }),
        exitCode: 1,
      });
      const result = f.cli.run(['orchestration', 'worker-start'], {
        kind: 'mutate',
        priority: 'mutate',
        requestId: uuid,
      });
      if (state === 'failed' || state === 'outcome_unknown')
        await expect(result).rejects.toMatchObject({
          code: state,
          retryable: false,
        });
      else expect((await result).result.dispatchId).toBe('ctx-a');
    }
    const f = await fixture({
      stdout: '{"ok":true,"result":{"state":"release_unknown"}}',
      exitCode: 1,
    });
    await expect(
      f.cli.run(['orchestration', 'worker-release'], {
        kind: 'mutate',
        priority: 'mutate',
        requestId: uuid,
      }),
    ).rejects.toMatchObject({ code: 'release_unknown' });
  });
  it('uses error codes, validates result schemas and does not expose response text', async () => {
    for (const [code, category] of Object.entries({
      no_active_sender_terminal: 'identity',
      stable_pane_required: 'identity',
      consumer_fenced: 'hijacked',
      request_mismatch: 'bug',
      runtime_unavailable: 'transient',
      task_not_startable: 'permanent',
      ECONNREFUSED: 'transient',
    }))
      expect(orcaError(code).category).toBe(category);
    for (const stdout of [
      'bad secret output',
      '{"ok":true}',
      '{"ok":false,"error":{"message":"secret"}}',
    ]) {
      const f = await fixture({ stdout, exitCode: 0 });
      await expect(
        f.cli.run(['status'], { kind: 'read', priority: 'identity' }),
      ).rejects.toMatchObject({
        category: 'contract_mismatch',
        message: 'Runtime response does not match its contract',
      });
    }
    const f = await fixture({
      stdout:
        '{"ok":false,"error":{"code":"consumer_fenced","message":"secret"}}',
      exitCode: 0,
    });
    await expect(
      f.cli.run(['status'], { kind: 'read', priority: 'identity' }),
    ).rejects.toMatchObject({
      category: 'hijacked',
      message: 'Orca command failed',
    });
    const missing = await fixture();
    await expect(
      missing.cli.run(
        ['status'],
        { kind: 'read', priority: 'identity' },
        z.object({ version: z.string() }),
      ),
    ).rejects.toMatchObject({ category: 'contract_mismatch' });
  });
  it('rejects cwd under a registered root, including symlinks, and refreshes after 60 seconds', async () => {
    const dir = await directory();
    let now = 0;
    let paths: string[] = [];
    const list = vi.fn(async () => paths);
    const guard = new CwdGuard(dir, list, () => now);
    await guard.check();
    paths = [dir];
    await guard.check();
    expect(list).toHaveBeenCalledTimes(1);
    now = 60_000;
    await expect(guard.check()).rejects.toMatchObject({
      category: 'guard',
      code: 'cli_cwd_in_worktree',
    });
    const other = await directory();
    await mkdir(join(other, 'real'));
    await symlink(join(other, 'real'), join(other, 'cli-cwd'));
    await expect(
      new CwdGuard(other, async () => [join(other, 'real')]).check(),
    ).rejects.toMatchObject({ category: 'guard' });
    await expect(
      new CwdGuard(await directory(), async () => ['relative/path']).check(),
    ).rejects.toMatchObject({ category: 'guard' });
  });
});
describe('rate limit, priority, metrics', () => {
  it('caps sliding windows for ten workers over sixty simulated minutes and never starves mutations', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const pressure = vi.fn();
    const scheduler = new CliScheduler(120, 4, Date.now, pressure);
    const started: number[] = [];
    for (let minute = 0; minute < 60; minute++) {
      const jobs = Array.from({ length: 10 }, () =>
        Array.from({ length: 11 }, () =>
          // The whole window is the critical lane's; bulk has its own test.
          scheduler.schedule('worker-list', async () => {
            started.push(Date.now());
          }),
        ),
      ).flat();
      const mutate = vi.fn(async () => {
        started.push(Date.now());
      });
      const mutation = scheduler.schedule('mutate', mutate);
      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.all([...jobs, mutation]);
      expect(mutate).toHaveBeenCalledOnce();
    }
    for (const time of new Set(started))
      expect(
        started.filter((at) => at > time - 60_000 && at <= time).length,
      ).toBeLessThanOrEqual(120);
    expect(pressure).toHaveBeenCalledWith(true);
    scheduler.close();
  });
  it('counts a long poll once and runs queued mutations before reads', async () => {
    const scheduler = new CliScheduler(120, 1);
    let release!: () => void;
    const long = scheduler.schedule(
      'consume',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const order: string[] = [];
    const read = scheduler.schedule('worker-read', async () => {
      order.push('read');
    });
    const mutation = scheduler.schedule('mutate', async () => {
      order.push('mutate');
    });
    await Promise.resolve();
    expect(scheduler.callsPerMinute()).toBe(1);
    release();
    await Promise.all([long, read, mutation]);
    expect(order).toEqual(['mutate', 'read']);
    scheduler.close();
  });
  it('records only command labels, latency percentiles, failures and estimated CPU', () => {
    let now = 0;
    const metrics = new CliMetrics(() => now);
    metrics.record('status', 10, false);
    metrics.record('status', 20, true);
    expect(metrics.snapshot()).toMatchObject({
      cpuSecondsPerMinute: 0.34,
      commands: { status: { p50Ms: 10, p95Ms: 20, failureRate: 0.5 } },
    });
    now = 60_000;
    expect(metrics.snapshot().completedCallsPerMinute).toBe(0);
  });
});
describe('ledger and references', () => {
  it('persists pending before spawn, retains stable AgentRef across follow-ups and rebuilds an empty cache', () => {
    const store = memory(),
      ledger = new DispatchLedger(store);
    ledger.pending({
      commandId: 'c1',
      run: 'r',
      keepOpen: true,
      attemptId: 'attempt',
    });
    expect(new DispatchLedger(store).isPendingTitle('aio:c1 title')).toBe(true);
    expect(ledger.started('c1', 'd1').agent).toBe('d1');
    ledger.pending({ commandId: 'c2', run: 'r', keepOpen: true });
    ledger.started('c2', 'd2', 'd1');
    expect(ledger.agentFor('d2')).toBe(agentRef('d1'));
    const rebuilt = new DispatchLedger(memory());
    rebuilt.rebuild(
      'r',
      {
        workers: [
          {
            dispatchId: 'd2',
            taskId: 't2',
            runId: 'r',
            resource: {
              originDispatchId: 'd1',
              retainedReason: 'user_requested',
            },
          },
          { dispatchId: 'd1', taskId: 't1', runId: 'r' },
          { dispatchId: 'foreign', taskId: 't3', runId: 'r' },
        ],
      },
      {
        tasks: [
          { id: 't1', title: 'aio:c1 title' },
          { id: 't2', title: 'aio:c2 follow up' },
          { id: 't3', title: 'unmanaged' },
        ],
      },
    );
    expect(rebuilt.agentFor('d2')).toBe('d1');
    expect(rebuilt.byDispatch('foreign')).toBeUndefined();
    expect(rebuilt.byDispatch('d2')).toMatchObject({
      state: 'started',
      keepOpen: true,
      stoppedByBackend: false,
    });
    ledger.stopped('d1');
    expect(new DispatchLedger(store).byDispatch('d1')?.stoppedByBackend).toBe(
      true,
    );
    expect(() => ledger.started('c1', 'different')).toThrow();
  });
  it('never links a dispatch without a parent id to a dispatchless pending entry (M2-FX12 a, b)', () => {
    const ledger = new DispatchLedger(memory());
    for (const [id, attemptId] of [
      ['meeting/spawn', 'meeting/attempt'],
      ['oncall/spawn', 'oncall/attempt'],
    ] as const) {
      ledger.pending({ commandId: id, run: 'r', keepOpen: true, attemptId });
      ledger.started(id, id === 'meeting/spawn' ? 'd-meet' : 'd-call');
    }
    // A send into a working dispatch (no follow-up) stays pending, dispatchless.
    ledger.pending({
      commandId: 'oncall/send',
      run: 'r',
      keepOpen: true,
      attemptId: 'oncall/attempt',
    });
    ledger.rebuild(
      'r',
      {
        workers: [
          { dispatchId: 'd-call', taskId: 't2', runId: 'r' },
          // Released meeting rows report no resource and no followUpOf.
          { dispatchId: 'd-meet', taskId: 't1', runId: 'r' },
        ],
      },
      {
        tasks: [
          { id: 't1', title: 'aio:meeting/spawn lead' },
          { id: 't2', title: 'aio:oncall/spawn lead' },
        ],
      },
    );
    expect(ledger.byDispatch('d-meet')).toMatchObject({
      agent: 'd-meet',
      attemptId: 'meeting/attempt',
    });
    expect(ledger.byDispatch('d-call')).toMatchObject({
      agent: 'd-call',
      attemptId: 'oncall/attempt',
    });
    ledger.discard('oncall/send');
    expect(ledger.byCommand('oncall/send')).toBeUndefined();
    // Only pending, dispatchless entries are discarded.
    ledger.discard('meeting/spawn');
    expect(ledger.byDispatch('d-meet')?.state).toBe('started');
  });
  it('uses pure dispatch ids and versioned base64url JSON with a caller-owned schema', () => {
    expect(agentRef('ctx-123')).toBe('ctx-123');
    const schema = z.object({ lastSeq: z.number() });
    const cursor = encodeCursor({ lastSeq: 2 });
    expect(decodeCursor(cursor, schema)).toEqual({ lastSeq: 2 });
    expect(() => decodeCursor(encodeCursor({ wrong: 2 }), schema)).toThrow();
    expect(Buffer.from(cursor, 'base64url').toString()).toBe(
      '{"v":1,"data":{"lastSeq":2}}',
    );
  });
  it('kills only matching orphan group leaders and never persists command text', async () => {
    const store = memory(),
      groups = new ProcessGroups(store);
    groups.add(10, '/bin/orca status --json');
    groups.add(20, '/bin/orca status --json');
    expect(JSON.stringify(store.read('orca:process-groups'))).not.toContain(
      '/bin/orca',
    );
    const kill = vi.fn();
    expect(
      await new ProcessGroups(store).cleanup(
        async (pid) =>
          pid === 10
            ? ' 10 /bin/orca status --json\n 11 child'
            : '20 unrelated process',
        kill,
      ),
    ).toBe(1);
    expect(kill).toHaveBeenCalledExactlyOnceWith(10);
  });
});
describe('git and versions', () => {
  it('allows passthrough only on fetch, guards branch deletion and returns filenames without diff content', async () => {
    const f = await fixture();
    const git = new DefaultGitCli({
      exec: { run: f.run },
      env,
      cwdGuard: f.cwdGuard,
    });
    f.run.mockResolvedValue({ exitCode: 0, stdout: '' });
    await git.fetch('/repo', 'ai-office/topic');
    expect(f.run.mock.calls.at(-1)?.[0].env.GH_CONFIG_DIR).toBe('/tmp/gh');
    await git.revParse('/repo', 'HEAD');
    expect(f.requests.at(-1)?.env.GH_CONFIG_DIR).toBeUndefined();
    f.run.mockResolvedValue({ exitCode: 0, stdout: ' M one\0R  new\0old\0' });
    expect(await git.status('/repo')).toEqual(['one', 'new', 'old']);
    await expect(
      git.fetch('/repo', '--upload-pack=evil'),
    ).rejects.toMatchObject({ category: 'guard' });
    await expect(git.deleteBranch('/repo', 'main')).rejects.toMatchObject({
      code: 'branch_not_managed',
    });
    f.run.mockResolvedValue({
      exitCode: 0,
      stdout: 'worktree /wt\0branch refs/heads/ai-office/topic\0\0',
    });
    await expect(
      git.deleteBranch('/repo', 'ai-office/topic'),
    ).rejects.toMatchObject({ code: 'branch_in_use' });
    f.run
      .mockResolvedValueOnce({ exitCode: 0, stdout: '' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '' });
    await expect(
      git.deleteBranch('/repo', 'ai-office/topic'),
    ).rejects.toMatchObject({ code: 'branch_unpushed' });
  });
  it('refreshes version every five minutes and each health probe, warning on changes', async () => {
    const f = await fixture({
      exitCode: 0,
      stdout: '{"ok":true,"result":{"runtime":{"appVersion":"1.4.259"}}}',
    });
    let now = 0;
    const versions = new VersionMonitor(
      f.cli,
      { min: '1.4.259', max: '1.4.259' },
      () => now,
    );
    expect((await versions.check()).verified).toBe(true);
    await versions.check();
    expect(f.run).toHaveBeenCalledTimes(1);
    await versions.check(true);
    expect(f.run).toHaveBeenCalledTimes(2);
    now = 300_000;
    f.run.mockResolvedValue({
      exitCode: 0,
      stdout: '{"ok":true,"result":{"runtime":{"appVersion":"1.4.260"}}}',
    });
    expect(await versions.check()).toMatchObject({
      verified: false,
      warnings: ['version_changed'],
    });
    f.run.mockResolvedValue({
      exitCode: 0,
      stdout: '{"ok":true,"result":{"runtime":{"appVersion":"1.4.258"}}}',
    });
    await expect(versions.check(true)).rejects.toMatchObject({
      code: 'orca_version_unsupported',
    });
  });
});

it('delays call 121 until the oldest start leaves the sliding window', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const scheduler = new CliScheduler();
  const work = vi.fn(async () => {});
  const calls = Array.from({ length: 121 }, () =>
    scheduler.schedule('worker-list', work),
  );
  await vi.advanceTimersByTimeAsync(59_999);
  expect(work).toHaveBeenCalledTimes(120);
  await vi.advanceTimersByTimeAsync(1);
  await Promise.all(calls);
  expect(work).toHaveBeenCalledTimes(121);
  scheduler.close();
});

describe('priority lane (FX-CLI-BUDGET)', () => {
  it('keeps a reserved share and a slot for the critical lane', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const scheduler = new CliScheduler(120, 4);
    const work = vi.fn(async () => {});
    const bulk = Array.from({ length: 100 }, () =>
      scheduler.schedule('worker-read', work),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    // Bulk stops at 120 − 40 per minute…
    expect(work).toHaveBeenCalledTimes(80);
    // …and the status list still starts at once.
    const list = vi.fn(async () => {});
    await scheduler.schedule('worker-list', list);
    expect(list).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(bulk);
    expect(work).toHaveBeenCalledTimes(100);
    scheduler.close();
  });
  it('a startup burst of 5 spawns never delays a due status list by more than 1 s', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const scheduler = new CliScheduler(120, 4);
    const busy = (ms: number) => () =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));
    // Five spawns at once: worktree show, worker-start (~4 s), task-list,
    // plus the first transcript reads of every new worker.
    const burst = Array.from({ length: 5 }, async () => {
      await scheduler.schedule('bulk', busy(200));
      await scheduler.schedule('mutate', busy(4_000));
      await scheduler.schedule('bulk', busy(200));
    });
    const reads = Array.from({ length: 20 }, () =>
      scheduler.schedule('worker-read', busy(300)),
    );
    // The status list is due every 2 s; record how late each one starts.
    const delays: number[] = [];
    const lists: Promise<void>[] = [];
    for (let due = 0; due <= 60_000; due += 2_000)
      setTimeout(() => {
        lists.push(
          scheduler.schedule('worker-list', async () => {
            delays.push(Date.now() - due);
            await busy(700)();
          }),
        );
      }, due);
    await vi.advanceTimersByTimeAsync(62_000);
    await Promise.all([...burst, ...reads, ...lists]);
    expect(delays).toHaveLength(31);
    expect(Math.max(...delays)).toBeLessThanOrEqual(1_000);
    scheduler.close();
  });
  it('runs identity checks (shim ensure, ownership run-show) in the critical lane (FX-TAIL)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const scheduler = new CliScheduler(120, 4);
    const work = vi.fn(async () => {});
    const bulk = Array.from({ length: 100 }, () =>
      scheduler.schedule('bulk', work),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(work).toHaveBeenCalledTimes(80);
    // The bulk minute is used up; the ownership check still starts at once.
    const show = vi.fn(async () => {});
    await scheduler.schedule('identity', show);
    expect(show).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(bulk);
    scheduler.close();
  });
  it('never lets bulk calls occupy the last slot', async () => {
    const scheduler = new CliScheduler(120, 3);
    const releases: (() => void)[] = [];
    const slow = () =>
      new Promise<void>((resolve) => {
        releases.push(resolve);
      });
    const reads = Array.from({ length: 5 }, () =>
      scheduler.schedule('bulk', slow),
    );
    await Promise.resolve();
    expect(releases).toHaveLength(2);
    const list = vi.fn(async () => {});
    await scheduler.schedule('worker-list', list);
    expect(list).toHaveBeenCalledOnce();
    // Release the reads (and those that start after them) until all ran.
    let released = 0;
    while (released < 5) {
      await new Promise((r) => setTimeout(r, 0));
      const batch = releases.splice(0);
      released += batch.length;
      batch.forEach((release) => release());
    }
    await Promise.all(reads);
    scheduler.close();
  });
});

it('rejects mutation commands disguised as reads', async () => {
  const f = await fixture();
  await expect(
    f.cli.run(['orchestration', 'worker-start'], {
      kind: 'read',
      priority: 'identity',
    }),
  ).rejects.toMatchObject({ code: 'command_kind_mismatch' });
  expect(f.run).not.toHaveBeenCalled();
});

it('refreshes expired inventory outside a saturated CLI slot without spending a phantom call', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const scheduler = new CliScheduler(2, 1);
  // Mock only filesystem guard work; its refresh uses the same scheduler as calls.
  let freshUntil = 60_000;
  const cwdGuard = new CwdGuard(await directory(), async () => []);
  const { CwdInventoryExpired } = await import('./errors.js');
  vi.spyOn(cwdGuard, 'check').mockImplementation(async (refresh = true) => {
    if (Date.now() >= freshUntil) {
      if (!refresh) throw new CwdInventoryExpired();
      await scheduler.schedule('identity', async () => {
        freshUntil = Date.now() + 60_000;
      });
    }
    return '/safe/cli-cwd';
  });
  const run = vi.fn(async () => ({
    stdout: '{"ok":true,"result":{}}',
    exitCode: 0,
  }));
  const cli = new DefaultOrcaCli({
    bin: 'orca',
    env: {},
    cwdGuard,
    scheduler,
    exec: { run },
    identity: { argsFor: async () => [] },
  });
  await cli.run(['status'], { kind: 'read', priority: 'identity' });
  await cli.run(['status'], { kind: 'read', priority: 'identity' });
  const delayed = cli.run(['status'], { kind: 'read', priority: 'identity' });
  await vi.advanceTimersByTimeAsync(60_000);
  await delayed;
  expect(run).toHaveBeenCalledTimes(3);
  expect(scheduler.callsPerMinute()).toBe(2);
  scheduler.close();
});

it('routes inbox mailbox targets through identity and respects native non-request commands', async () => {
  const f = await fixture();
  const argsFor = vi.fn<CoordinatorIdentity['argsFor']>(
    async (_kind, _run, context) =>
      context?.mailbox
        ? ['--terminal', `${context.mailbox.kind}:${context.mailbox.id}`]
        : [],
  );
  const cli = new DefaultOrcaCli({
    bin: 'orca',
    env,
    cwdGuard: f.cwdGuard,
    exec: { run: f.run },
    identity: { argsFor },
  });
  await cli.run(['orchestration', 'inbox', '--full'], {
    kind: 'read',
    run: 'r',
    mailbox: { kind: 'run', id: 'r' },
    priority: 'consume',
  });
  expect(f.requests[0]?.args).toEqual([
    'orchestration',
    'inbox',
    '--full',
    '--terminal',
    'run:r',
    '--json',
  ]);
  await expect(
    cli.run(['orchestration', 'inbox'], { kind: 'read', priority: 'consume' }),
  ).rejects.toMatchObject({ code: 'inbox_target_required' });
  await cli.run(['worktree', 'create', '--name', 'aio-test'], {
    kind: 'mutate',
    priority: 'mutate',
  });
  expect(f.requests[1]?.args).toEqual([
    'worktree',
    'create',
    '--name',
    'aio-test',
    '--json',
  ]);
});

describe('command allowlist', () => {
  const mutations = [
    'worker-start',
    'send',
    'reply',
    'worker-stop',
    'worker-release',
    'run-create',
    'run-use',
    'task-update',
  ];
  it.each(mutations)(
    'allows orchestration %s with the existing mutation guards',
    async (command) => {
      const f = await fixture({
        exitCode: 0,
        stdout:
          '{"ok":true,"result":{"state":"ready","dispatchId":"ctx-test"}}',
      });
      await f.cli.run(['orchestration', command], {
        kind: 'mutate',
        priority: 'mutate',
        requestId: uuid,
      });
      expect(f.run).toHaveBeenCalledOnce();
    },
  );
  it.each([
    ['status'],
    ['repo', 'list'],
    ['repo', 'show'],
    ['worktree', 'list'],
    ['worktree', 'show'],
    ['terminal', 'list'],
    ['terminal', 'show'],
    ['terminal', 'read'],
    ...[
      'worker-list',
      'worker-show',
      'worker-read',
      'run-show',
      'run-list',
      'task-list',
      'request-show',
    ].map((cmd) => ['orchestration', cmd]),
  ])('preserves read command %j', async (...args) => {
    const f = await fixture();
    await f.cli.run(args, { kind: 'read', priority: 'identity' });
    expect(f.run).toHaveBeenCalledOnce();
  });
  it.each([
    ['worktree', 'create'],
    ['worktree', 'rm'],
    ['terminal', 'create'],
  ])('allows native mutation %s %s', async (...args) => {
    const f = await fixture();
    await f.cli.run(args, { kind: 'mutate', priority: 'mutate' });
    expect(f.run).toHaveBeenCalledOnce();
  });
  it.each([
    ['orchestration', 'reset'],
    ['repo', 'add'],
    ['repo', 'hide'],
    ['repo', 'rm'],
    ['worktree', 'set'],
    ['account', 'list'],
    ['account', 'login'],
    ['account', 'unknown'],
    ['serve'],
    ['unknown'],
    [],
    ['terminal', 'close', '--all'],
    ['terminal', 'close', '--all=true'],
    ['terminal', 'close', 'term-one', '--all'],
    ['--json', 'orchestration', 'reset'],
  ])(
    'blocks unsupported command %j before identity or subprocess work',
    async (...args) => {
      const f = await fixture();
      const identity = { argsFor: vi.fn(async () => []) };
      const check = vi.spyOn(f.cwdGuard, 'check');
      const cli = new DefaultOrcaCli({
        bin: 'orca',
        env,
        cwdGuard: f.cwdGuard,
        exec: { run: f.run },
        identity,
      });
      for (const kind of ['mutate', 'consume', 'read'] as const) {
        await expect(
          cli.run(args, { kind, priority: 'mutate', requestId: uuid }),
        ).rejects.toMatchObject({
          category: 'guard',
          code: 'command_not_allowed',
        });
      }
      expect(identity.argsFor).not.toHaveBeenCalled();
      expect(check).not.toHaveBeenCalled();
      expect(f.run).not.toHaveBeenCalled();
    },
  );
  it('allows one explicit terminal handle and rejects implicit, multiple or identity-injected bulk targets', async () => {
    const f = await fixture();
    const argsFor = vi.fn<CoordinatorIdentity['argsFor']>(async () => []);
    const cli = new DefaultOrcaCli({
      bin: 'orca',
      env,
      cwdGuard: f.cwdGuard,
      exec: { run: f.run },
      identity: { argsFor },
    });
    await cli.run(['terminal', 'close', 'term_test'], {
      kind: 'mutate',
      priority: 'mutate',
    });
    argsFor.mockResolvedValue(['--terminal', 'term_test']);
    await cli.run(['terminal', 'close'], {
      kind: 'mutate',
      priority: 'mutate',
    });
    for (const identity of [
      [],
      ['--terminal', 'term_one', '--terminal', 'term_two'],
      ['--all'],
      ['--terminal', 'term_test', '--all'],
    ]) {
      argsFor.mockResolvedValue(identity);
      await expect(
        cli.run(['terminal', 'close'], { kind: 'mutate', priority: 'mutate' }),
      ).rejects.toMatchObject({ code: 'command_not_allowed' });
    }
    argsFor.mockResolvedValue([]);
    await expect(
      cli.run(['terminal', 'close', 'term_one', 'term_two'], {
        kind: 'mutate',
        priority: 'mutate',
      }),
    ).rejects.toMatchObject({ code: 'command_not_allowed' });
    expect(f.run).toHaveBeenCalledTimes(2);
  });
});
