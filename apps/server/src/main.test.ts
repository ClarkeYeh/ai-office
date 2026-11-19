import { EventEmitter } from 'node:events';
import * as sleepWake from './adapters/runtime-orca/sleep-wake.js';
import * as runtimeConfig from './config/runtime-config.js';
import { HealthMonitor } from './application/health/health-monitor.js';
import { TimerScheduler } from './adapters/system/index.js';
import { sessionRef, questionRef } from './adapters/runtime-orca/refs.js';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FAKE_REPO,
  checkStartOptions,
  createFakeWorld,
  orcaSubprocessPolicy,
  parseArgs,
  startServer,
  StartupError,
} from './main.js';
import { SpawnExec, CliScheduler } from './adapters/runtime-orca/index.js';
import { OrcaObserver } from './adapters/runtime-orca/observe/index.js';
import { ShimCoordinatorIdentity } from './adapters/runtime-orca/coordinator-identity/shim.js';
import * as orcaMethods from './adapters/runtime-orca/index.js';
import { SessionLogUsage } from './adapters/usage-sessionlog/index.js';
import { ObservationLoop } from './application/observation/index.js';
import { UsageCursorSchema } from './ports/refs.js';
import { createFakeScm } from './adapters/scm-fake/index.js';
import type { RunningServer, StartOptions } from './main.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON over HTTP
type Json = Record<string, any>;

const homes: string[] = [];
const servers: RunningServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) {
    if (process.env.AIO_DEBUG_HOME) console.log('kept', home);
    else rmSync(home, { recursive: true, force: true });
  }
});

const home = () => {
  const directory = mkdtempSync(join(tmpdir(), 'aio-main-'));
  homes.push(directory);
  return directory;
};

const boot = async (directory: string, options: StartOptions = {}) => {
  const server = await startServer({
    dev: true,
    fake: 'mainline',
    port: 0,
    env: { AI_OFFICE_HOME: directory },
    webDist: join(directory, 'no-web'),
    fakeFinalMergeMs: 50,
    print: () => undefined,
    ...options,
  });
  servers.push(server);
  return server;
};

/** A logged-in browser session against a running server. */
const browser = async (server: RunningServer) => {
  const exchange = await fetch(server.bootstrapUrl, { redirect: 'manual' });
  expect(exchange.status).toBe(302);
  const cookie = exchange.headers.get('set-cookie')!.split(';')[0]!;
  let key = 0;
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const response = await fetch(`${server.url}${path}`, {
      method,
      headers: {
        cookie,
        origin: server.url,
        ...(body === undefined
          ? {}
          : {
              'content-type': 'application/json',
              'idempotency-key': `test-${++key}-${Date.now()}`,
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: (text ? JSON.parse(text) : null) as Json,
    };
  };
  return { cookie, call };
};

type Browser = Awaited<ReturnType<typeof browser>>;

/** Approves stage gates as they open until `done` holds; fails on exception gates. */
const drive = async (
  ui: Browser,
  workflowId: string,
  done: (workflow: Json) => boolean,
  timeoutMs = 60_000,
) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await ui.call('GET', `/api/v1/workflows/${workflowId}`);
    const workflow = snapshot.body.readModel;
    if (done(workflow)) return workflow;
    if (Date.now() > deadline) {
      const events = await ui.call(
        'GET',
        `/api/v1/workflows/${workflowId}/events?limit=1000`,
      );
      const trace = (events.body.events as Json[])
        .map(
          (e) =>
            `${e.seq} ${e.type} ${JSON.stringify(e.payload).slice(0, 160)}`,
        )
        .join('\n');
      throw new Error(
        `Timed out at ${JSON.stringify(workflow.status)}\n${trace}`,
      );
    }
    const { body } = await ui.call('GET', '/api/v1/gates');
    for (const gate of body.gates as Json[]) {
      if (gate.workflowId !== workflowId || gate.status !== 'open') continue;
      if (gate.kind === 'exception')
        throw new Error(`Unexpected exception gate: ${JSON.stringify(gate)}`);
      if (gate.stageKind === 'final-pr') continue; // the fake owner merges it
      // The detail view carries the live GitHub hash the UI must echo (Q1).
      const detail = (
        await ui.call('GET', `/api/v1/gates/${encodeURIComponent(gate.gateId)}`)
      ).body;
      const decision = await ui.call(
        'POST',
        `/api/v1/gates/${encodeURIComponent(gate.gateId)}/decision`,
        {
          decision: 'approve',
          expectedVersion: detail.version,
          // Before the first SCM poll the GitHub body is the rendered one.
          ...(detail.conclusion === undefined
            ? {}
            : {
                githubBodyHash:
                  detail.conclusion.githubBodyHash ??
                  detail.conclusion.renderedHash,
              }),
        },
      );
      // A concurrent content update bumps the version: retry on the next pass.
      if (decision.status !== 409)
        expect(decision.status, JSON.stringify(decision.body)).toBeLessThan(
          300,
        );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe('start options', () => {
  it('refuses --fake without --dev before taking the lock', async () => {
    const directory = home();
    expect(() => checkStartOptions({ fake: 'mainline' })).toThrow(/--dev/);
    await expect(
      startServer({ fake: 'mainline', env: { AI_OFFICE_HOME: directory } }),
    ).rejects.toThrow(StartupError);
    expect(existsSync(join(directory, 'data/.lock'))).toBe(false);
    expect(() => checkStartOptions({ dev: true, fake: 'nope' })).toThrow(
      /mainline/,
    );
  });

  it('parses the CLI flags it forwards', () => {
    expect(
      parseArgs(['--dev', '--fake', 'mainline', '--port', '0', '--break-lock']),
    ).toEqual({ dev: true, fake: 'mainline', port: 0, breakLock: true });
    expect(() => parseArgs(['--fake'])).toThrow(/requires a value/);
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown option/);
  });

  it('refuses production mode until M3, releasing the lock', async () => {
    const directory = home();
    hybridConfig(directory);
    await expect(
      startServer({
        runtime: 'orca',
        env: { AI_OFFICE_HOME: directory },
        port: 0,
      }),
    ).rejects.toThrow(/M3/);
    expect(existsSync(join(directory, 'data/.lock'))).toBe(false);
  });
});

describe('packaging and subprocess policy', () => {
  it('ships SQL migrations beside the compiled migration module', () => {
    // `pnpm -r build` copies them; dist-only installs must not need src/.
    const dist = join(
      import.meta.dirname,
      '../dist/adapters/store-sqlite/migrations',
    );
    expect(existsSync(join(dist, '0001_event_store.sql'))).toBe(true);
  });

  it('runs Orca subprocesses from cli-cwd with an allow-listed environment (§6.3)', () => {
    const policy = orcaSubprocessPolicy('/home/u/.ai-office', {
      PATH: '/bin',
      HOME: '/home/u',
      ORCA_TERMINAL_HANDLE: 'term_x',
      GH_TOKEN: 'secret',
      AI_OFFICE_GITHUB_TOKEN: 'secret',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
    });
    expect(policy).toEqual({
      cwd: '/home/u/.ai-office/cli-cwd',
      env: { PATH: '/bin', HOME: '/home/u' },
    });
  });
});

describe('fake-mode backend', () => {
  it('boots on 127.0.0.1, authenticates via bootstrap and rejects a second instance', async () => {
    const directory = home();
    const lines: string[] = [];
    const server = await boot(directory, { print: (line) => lines.push(line) });
    expect(lines.join('\n')).toContain('runtime: fake');
    expect(lines.join('\n')).toContain(server.bootstrapUrl);
    expect(
      JSON.parse(readFileSync(join(directory, 'runtime.json'), 'utf8')),
    ).toMatchObject({ port: server.port, pid: process.pid });

    const ui = await browser(server);
    const health = await ui.call('GET', '/api/v1/health');
    expect(health.status).toBe(200);
    expect(JSON.stringify(health.body)).toContain('fake');
    expect((await fetch(`${server.url}/api/v1/health`)).status).toBe(401);
    const repos = await ui.call('GET', '/api/v1/repos');
    expect(repos.body.repos).toEqual([
      expect.objectContaining({ localPath: FAKE_REPO.localPath }),
    ]);
    // The gateway is mounted outside cookie auth and refuses browser origins.
    const gateway = await fetch(`${server.url}/agent/v1/submissions`, {
      method: 'POST',
      headers: { origin: server.url, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(gateway.status).toBe(403);

    await expect(boot(directory)).rejects.toThrow(String(process.pid));
    // The rejected start must not touch the holder's runtime.json.
    expect(existsSync(join(directory, 'runtime.json'))).toBe(true);

    await server.close();
    expect(existsSync(join(directory, 'runtime.json'))).toBe(false);
    expect(existsSync(join(directory, 'data/.lock'))).toBe(false);
  });

  it('runs the fake mainline end-to-end across a mid-workflow restart', async () => {
    const directory = home();
    const first = await boot(directory);
    let ui = await browser(first);
    const repoId = (await ui.call('GET', '/api/v1/repos')).body.repos[0].repoId;
    const started = await ui.call('POST', '/api/v1/workflows', {
      templateId: 'feature-to-pr',
      repoId,
      requirement: 'Add dark mode toggle',
    });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const workflowId = started.body.workflowId as string;

    // Restart once implementation is under way: slow merges keep the first item
    // in review, so commands, agents and timers are live when the backend stops.
    const world = first.fakeWorld!;
    world.scm.setMergeDelay(1_000);
    const midway = await drive(
      ui,
      workflowId,
      (w) =>
        (w.workItems as Json[] | undefined)?.some((i) =>
          ['in_review', 'merging'].includes(i.status),
        ) === true,
    );
    expect(midway.status).toBe('running');
    await first.close();
    world.scm.setMergeDelay(0);

    const second = await boot(directory, { fakeWorld: world });
    ui = await browser(second);
    const final = await drive(
      ui,
      workflowId,
      (w) => w.status === 'completed' || w.status === 'failed',
    );
    expect(final.status).toBe('completed');
    const merged = (final.workItems as Json[]).map((i) => i.status);
    expect(merged).toEqual(['merged', 'merged']);
    await second.close();
    expect(existsSync(join(directory, 'data/.lock'))).toBe(false);
  }, 120_000);
});

it('createFakeWorld disables owner timers by default and preserves explicit finalMergeMs', async () => {
  vi.useFakeTimers();
  try {
    for (const finalMergeMs of [undefined, 6000]) {
      const world = createFakeWorld('mainline', {
        readSpec: () => null,
        ...(finalMergeMs === undefined ? {} : { finalMergeMs }),
      });
      const repo = FAKE_REPO.github;
      world.scm.pushBranch(repo, 'ai-office/final', 'main');
      const pr = await world.scm.openPR(
        repo,
        { title: 'Final', body: '', base: 'main', head: 'ai-office/final' },
        { workflowId: 'wf', commandId: 'open' },
      );
      await vi.advanceTimersByTimeAsync(5999);
      expect((await world.scm.getPR(pr)).state).toBe('open');
      await vi.advanceTimersByTimeAsync(1);
      expect((await world.scm.getPR(pr)).state).toBe(
        finalMergeMs === undefined ? 'open' : 'merged',
      );
    }
  } finally {
    vi.useRealTimers();
  }
});

function hybridConfig(directory: string, extra = '') {
  writeFileSync(
    join(directory, 'config.toml'),
    '[orca]\nbin = "/replay/orca"\npreventSleep = false\nshim.closeOnExit = true\n[github]\nghBin = "/replay/gh"\n' +
      extra,
  );
}

/** Replay the process boundary: no Orca, git, ps or caffeinate process is spawned. */
function replayHybrid(
  directory: string,
  worktrees: string[] = [],
  orcaHome = join(directory, 'orca-home'),
) {
  const calls: string[] = [];
  const exec = vi
    .spyOn(SpawnExec.prototype, 'run')
    .mockImplementation(async (request) => {
      const command = request.args.slice(0, 2).join(' ');
      calls.push(command);
      let result: unknown;
      if (request.bin === 'git') {
        if (request.args.includes('rev-parse'))
          return { exitCode: 0, stdout: '.git\n/replay/repo\n' };
        if (request.args.includes('get-url'))
          return {
            exitCode: 0,
            stdout: 'git@github.com:fixture/project.git\n',
          };
        throw new Error('Unexpected git replay command');
      }
      if (command === 'worktree list')
        result = { worktrees: worktrees.map((path) => ({ path })) };
      else if (request.args[0] === 'status')
        result = { runtime: { appVersion: '1.4.259' } };
      else if (command === 'repo list')
        result = {
          repos: [
            { id: 'folder', path: orcaHome },
            { id: 'repo', path: '/replay/repo' },
          ],
        };
      else if (command === 'terminal list') result = { terminals: [] };
      else if (command === 'terminal create')
        result = { terminal: { handle: 'term_replay', connected: true } };
      else if (command === 'terminal close') result = {};
      else throw new Error('Unexpected replay command: ' + command);
      expect(realpathSync(request.cwd)).toBe(
        realpathSync(join(directory, 'cli-cwd')),
      );
      expect(request.env).not.toHaveProperty('ORCA_TERMINAL_HANDLE');
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, result }) };
    });
  return { calls, exec };
}

const hybrid = async (directory: string, options: StartOptions = {}) => {
  const server = await startServer({
    dev: true,
    runtime: 'orca',
    port: 0,
    env: {
      AI_OFFICE_HOME: directory,
      HOME: directory,
      ORCA_TERMINAL_HANDLE: 'term_parent',
    },
    webDist: join(directory, 'no-web'),
    print: () => undefined,
    ...options,
  });
  servers.push(server);
  return server;
};

describe('hybrid composition', () => {
  it('parses only the runtime flag and fences the SCM test seam before side effects', async () => {
    expect(parseArgs(['--dev', '--runtime', 'orca'])).toEqual({
      dev: true,
      runtime: 'orca',
    });
    expect(() => parseArgs(['--runtime', 'other'])).toThrow(StartupError);
    expect(() => parseArgs(['--testOnly.scm', 'anything'])).toThrow(
      StartupError,
    );
    const scm = createFakeScm();
    for (const options of [
      { dev: true, fake: 'mainline' },
      { runtime: 'orca' as const },
      { dev: true },
    ]) {
      const directory = home();
      await expect(
        startServer({
          ...options,
          testOnly: { scm },
          env: { AI_OFFICE_HOME: directory },
        }),
      ).rejects.toThrow(StartupError);
      expect(existsSync(join(directory, 'data/.lock'))).toBe(false);
    }
    expect(() =>
      checkStartOptions({ dev: true, fake: 'mainline', runtime: 'orca' }),
    ).toThrow(StartupError);
  });

  it('boots with real adapter composition, reports PP1 health and seeds fake SCM from the inspected origin', async () => {
    const directory = home();
    hybridConfig(directory);
    const replay = replayHybrid(directory);
    const lines: string[] = [];
    const server = await hybrid(directory, {
      print: (line) => lines.push(line),
    });
    const ui = await browser(server);
    expect(lines.join('\n')).toContain('runtime: orca, scm: fake (M2)');
    expect(server.fakeWorld).toBeUndefined();
    const health = await ui.call('GET', '/api/v1/health');
    expect(health.status).toBe(200);
    expect(health.body.runtime).toMatchObject({
      mode: 'orca',
      version: '1.4.259',
      verified: true,
      shim: { status: 'ok', location: join(directory, 'orca-home') },
      binPath: '/replay/orca',
      supportedRange: '>=1.4.259 <1.5',
    });
    expect(health.body.scm.ghBinPath).toBe('/replay/gh');
    expect(health.body.usage.sources).toHaveLength(2);
    expect(health.body.usage.sources[0]).toMatchObject({
      source: 'session-log',
      formatVerified: true,
    });
    expect(
      (await ui.call('POST', '/dev/fake/scm/merge-final-pr', { number: 1 }))
        .status,
    ).toBe(404);
    const repo = await ui.call('POST', '/api/v1/repos', {
      localPath: '/replay/repo',
    });
    expect(repo.status, JSON.stringify(repo.body)).toBe(201);
    expect(repo.body.github).toEqual({ owner: 'fixture', name: 'project' });
    expect(replay.calls.indexOf('terminal create')).toBeGreaterThan(
      replay.calls.indexOf('status --json'),
    );
    await server.close();
    expect(replay.calls.at(-1)).toBe('terminal close');
    expect(existsSync(join(directory, 'data/.lock'))).toBe(false);
  });

  it('publishes runtimeVerified only after CoordinatorIdentity ensure() succeeds (FX5)', async () => {
    const directory = home();
    hybridConfig(directory);
    replayHybrid(directory);
    const ensure = vi.spyOn(ShimCoordinatorIdentity.prototype, 'ensure');
    const verified = vi.spyOn(
      HealthMonitor.prototype,
      'runtimeIdentityVerified',
    );
    const server = await hybrid(directory);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(verified).toHaveBeenCalledWith(true);
    expect(verified.mock.invocationCallOrder[0]).toBeGreaterThan(
      ensure.mock.invocationCallOrder[0]!,
    );
    const ui = await browser(server);
    const health = (await ui.call('GET', '/api/v1/health')).body;
    expect(health.runtime.verified).toBe(true);
    await server.close();
    const db = new DatabaseSync(join(directory, 'data/ai-office.sqlite'));
    const published = (
      db
        .prepare('SELECT event_json FROM events WHERE workflow_id IS NULL')
        .all() as { event_json: string }[]
    )
      .map((row) => JSON.parse(row.event_json))
      .filter((event) => event.type === 'health.changed')
      .map((event) => event.payload);
    db.close();
    expect(published).toContainEqual({
      component: 'runtime',
      status: 'healthy',
      breaker: 'closed',
      runtimeVerified: true,
    });
    expect(published.map((p) => p.component).sort()).toEqual([
      'runtime',
      'scm',
      'store',
      'usage',
    ]);
  });

  it('uses the injected ScmPort only in hybrid mode and closes observer before identity and CLI', async () => {
    const directory = home();
    hybridConfig(directory);
    replayHybrid(directory);
    const scm = createFakeScm();
    scm.addRepo(
      { owner: 'fixture', name: 'project' },
      { defaultBranch: 'injected' },
    );
    const inspect = vi.spyOn(scm, 'inspectRepo');
    const observerClose = vi.spyOn(OrcaObserver.prototype, 'close');
    const identityClose = vi.spyOn(ShimCoordinatorIdentity.prototype, 'close');
    const schedulerClose = vi.spyOn(CliScheduler.prototype, 'close');
    const server = await hybrid(directory, { testOnly: { scm } });
    const ui = await browser(server);
    const repo = await ui.call('POST', '/api/v1/repos', {
      localPath: '/replay/repo',
    });
    expect(repo.body.defaultBranch).toBe('injected');
    expect(inspect).toHaveBeenCalledWith({ owner: 'fixture', name: 'project' });
    await Promise.all([server.close(), server.close()]);
    expect(observerClose.mock.invocationCallOrder[0]).toBeLessThan(
      identityClose.mock.invocationCallOrder[0]!,
    );
    expect(identityClose.mock.invocationCallOrder[0]).toBeLessThan(
      schedulerClose.mock.invocationCallOrder.at(-1)!,
    );
    expect(identityClose).toHaveBeenCalledTimes(1);
  });

  it('rejects unsafe cwd before creating a shim and releases its lock', async () => {
    const directory = home();
    hybridConfig(directory);
    const replay = replayHybrid(directory, [directory]);
    await expect(hybrid(directory)).rejects.toMatchObject({
      code: 'cli_cwd_in_worktree',
    });
    expect(replay.calls).toEqual(['worktree list']);
    expect(existsSync(join(directory, 'data/.lock'))).toBe(false);
  });

  it('rejects relative session directories before executing Orca', async () => {
    const directory = home();
    hybridConfig(directory, '[usage]\nclaudeConfigDirs = ["relative"]\n');
    const replay = replayHybrid(directory);
    await expect(hybrid(directory)).rejects.toThrow(/absolute paths/);
    expect(replay.exec).not.toHaveBeenCalled();
  });

  it('snapshots budget enforcement and spawn stall settings in fake mode without resolving real binaries', async () => {
    const directory = home();
    writeFileSync(
      join(directory, 'config.toml'),
      '[budget]\nenforcement = "off"\n[engine]\nspawnStallMs = 123456\n',
    );
    const server = await boot(directory);
    const ui = await browser(server);
    const repoId = (await ui.call('GET', '/api/v1/repos')).body.repos[0].repoId;
    const started = await ui.call('POST', '/api/v1/workflows', {
      templateId: 'feature-to-pr',
      repoId,
      requirement: 'Snapshot limits',
    });
    expect(started.status).toBe(201);
    const events = await ui.call(
      'GET',
      '/api/v1/workflows/' + started.body.workflowId + '/events',
    );
    expect(
      events.body.events.find(
        (event: Json) => event.type === 'workflow.started',
      ).payload.limits,
    ).toMatchObject({ budgetEnforcement: 'off', spawnStallMs: 123456 });
  });
});

it('passes attempt start to usage lookup and stops locating once a session is found', async () => {
  const directory = home();
  hybridConfig(directory);
  replayHybrid(directory);
  const world = createFakeWorld('mainline', {
    readSpec: (path) => readFileSync(path, 'utf8'),
  });
  const fakePort = Object.fromEntries(
    Object.getOwnPropertyNames(Object.getPrototypeOf(world.runtime))
      .filter((key) => key !== 'constructor')
      .map((key) => {
        const method = Reflect.get(world.runtime, key) as (
          ...args: unknown[]
        ) => unknown;
        return [key, method.bind(world.runtime)];
      }),
  ) as unknown as typeof world.runtime;
  vi.spyOn(orcaMethods, 'createOrcaRuntime').mockReturnValue(fakePort);
  const observations: ObservationLoop[] = [];
  const original = ObservationLoop.prototype.start;
  vi.spyOn(ObservationLoop.prototype, 'start').mockImplementation(function (
    this: ObservationLoop,
  ) {
    observations.push(this);
    original.call(this);
  });
  const locate = vi
    .spyOn(SessionLogUsage.prototype, 'locate')
    .mockResolvedValueOnce(null)
    .mockImplementation(async (ref) => ({
      attemptId: ref.attemptId,
      agent: ref.agent,
      sessionId: 'session',
      file: '/replay/session.jsonl',
    }));
  const read = vi.spyOn(SessionLogUsage.prototype, 'read').mockResolvedValue({
    samples: [],
    cursor: UsageCursorSchema.parse('cursor'),
  });
  const server = await hybrid(directory, { testOnly: { scm: world.scm } });
  const ui = await browser(server);
  const repo = await ui.call('POST', '/api/v1/repos', {
    localPath: FAKE_REPO.localPath,
  });
  expect(repo.status, JSON.stringify(repo.body)).toBe(201);
  const started = await ui.call('POST', '/api/v1/workflows', {
    templateId: 'feature-to-pr',
    repoId: repo.body.repoId,
    requirement: 'Locate a session',
  });
  expect(started.status).toBe(201);
  await server.runners.idle();
  const runner = server.runners.get(started.body.workflowId)!;
  const attempt = Object.values(runner.state.attempts).find((a) => a.agentRef)!;
  expect(attempt).toBeDefined();
  for (let i = 0; i < 3; i++)
    await observations[0]!.pollUsage(runner, attempt.attemptId);
  expect(locate).toHaveBeenCalledTimes(2);
  expect(locate).toHaveBeenLastCalledWith(
    expect.objectContaining({
      startedAt: attempt.spawnedAt,
      attemptId: attempt.attemptId,
    }),
  );
  expect(read).toHaveBeenCalledTimes(2);
});

describe('explicit dev startup and approved shim location', () => {
  it.each([
    [{}, /Production.*M3/],
    [{ runtime: 'orca' }, /Production.*M3/],
    [{ dev: true }, /requires --fake.*--runtime orca/],
  ] as const)(
    'refuses %j before config, directories or runtime side effects',
    async (options, message) => {
      const directory = join(home(), 'must-not-be-created');
      const resolveConfig = vi.spyOn(runtimeConfig, 'resolveRuntimeConfig');
      const exec = vi
        .spyOn(SpawnExec.prototype, 'run')
        .mockRejectedValue(new Error('No process allowed'));
      await expect(
        startServer({ ...options, env: { AI_OFFICE_HOME: directory } }),
      ).rejects.toThrow(message);
      expect(resolveConfig).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
      expect(existsSync(directory)).toBe(false);
    },
  );

  it('uses a pre-registered folder outside the isolated data dir and reports new handles', async () => {
    const directory = home(),
      approved = home();
    hybridConfig(directory);
    const replay = replayHybrid(directory, [], approved);
    const created = vi.fn();
    const server = await hybrid(directory, {
      orcaHome: approved,
      testOnly: { onShimCreated: created },
    });
    expect(
      parseArgs(['--dev', '--runtime', 'orca', '--orca-home', approved]),
    ).toMatchObject({ orcaHome: approved });
    expect(created).toHaveBeenCalledExactlyOnceWith('term_replay');
    const create = replay.exec.mock.calls.find(
      ([request]) => request.args.slice(0, 2).join(' ') === 'terminal create',
    )![0];
    expect(create.args).toContain('path:' + approved);
    expect(realpathSync(create.cwd)).toBe(
      realpathSync(join(directory, 'cli-cwd')),
    );
    expect(server.dataDir).toBe(directory);
    expect(replay.calls).not.toContain('repo add');
    const ui = await browser(server);
    expect(
      (await ui.call('GET', '/api/v1/health')).body.runtime.shim.location,
    ).toBe(approved);
  });

  it('rejects relative/fake-mode folders and never registers an unknown folder', async () => {
    expect(() =>
      checkStartOptions({ dev: true, runtime: 'orca', orcaHome: 'relative' }),
    ).toThrow(/absolute path/);
    expect(() =>
      checkStartOptions({ dev: true, fake: 'mainline', orcaHome: '/approved' }),
    ).toThrow(/--runtime orca/);
    const directory = home();
    hybridConfig(directory);
    const replay = replayHybrid(directory);
    await expect(
      hybrid(directory, { orcaHome: '/not-registered' }),
    ).rejects.toMatchObject({ code: 'shim_folder_workspace_unregistered' });
    expect(replay.calls).not.toContain('repo add');
    expect(replay.calls).not.toContain('terminal create');
  });
});

it('shares one long-poll per run, one caffeinate and the current observer across wake, reply and shutdown', async () => {
  const directory = home();
  hybridConfig(directory);
  writeFileSync(
    join(directory, 'config.toml'),
    readFileSync(join(directory, 'config.toml'), 'utf8').replace(
      'preventSleep = false',
      'preventSleep = true',
    ),
  );
  const replay = replayHybrid(directory);
  const replayRun = replay.exec.getMockImplementation()!;
  let activePolls = 0,
    maxPolls = 0,
    pollsStarted = 0;
  const envelope = (result: unknown) => ({
    exitCode: 0,
    stdout: JSON.stringify({ ok: true, result }),
  });
  replay.exec.mockImplementation(async (request) => {
    if (request.args[0] !== 'orchestration') return replayRun(request);
    switch (request.args[1]) {
      case 'run-show':
        return envelope({
          run: {
            id: 'run-replay',
            coordinator_handle: 'term_replay',
            consumer_generation: 1,
          },
        });
      case 'request-show':
        return envelope({ state: 'absent' });
      case 'inbox':
        return envelope({ messages: [] });
      case 'worker-list':
        return envelope({ workers: [] });
      case 'task-list':
        return envelope({ tasks: [] });
      case 'check': {
        activePolls++;
        pollsStarted++;
        maxPolls = Math.max(maxPolls, activePolls);
        return new Promise((resolve) =>
          request.signal!.addEventListener(
            'abort',
            () => {
              setTimeout(() => {
                activePolls--;
                resolve(envelope({ messages: [] }));
              }, 20);
            },
            { once: true },
          ),
        );
      }
      default:
        throw new Error('Unexpected replay operation');
    }
  });
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  const spawn = vi.fn(() => child);
  const originalWrap = sleepWake.withSleepWake;
  const decorated: ReturnType<typeof originalWrap>[] = [];
  vi.spyOn(sleepWake, 'withSleepWake').mockImplementation(
    (runtime, options) => {
      const result = originalWrap(
        { ...runtime, answer: vi.fn(async () => {}) },
        { ...options, platform: 'darwin', spawn },
      );
      decorated.push(result);
      return result;
    },
  );
  const observe = vi.spyOn(OrcaObserver.prototype, 'observe');
  const answered = vi.spyOn(OrcaObserver.prototype, 'markAnswered');
  const healthRestore = vi.spyOn(HealthMonitor.prototype, 'restore');
  const healthClose = vi.spyOn(HealthMonitor.prototype, 'close');
  const scheduled = vi.spyOn(TimerScheduler.prototype, 'schedule');
  const server = await hybrid(directory);
  expect(decorated).toHaveLength(1);
  const runtime = decorated[0]!;
  const run = sessionRef('run-replay');
  let batch = await runtime.observe(run, null);
  batch = await runtime.observe(run, batch.cursor);
  expect(pollsStarted).toBe(1);
  expect(activePolls).toBe(1);
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(spawn.mock.calls[0]).toEqual([
    '/usr/bin/caffeinate',
    ['-i', '-w', String(process.pid)],
  ]);
  const before = observe.mock.instances.at(-1);
  const health = healthRestore.mock.instances[0] as HealthMonitor;
  const tick = scheduled.mock.calls.find(
    ([timer]) => timer.id === 'aio-health:clock',
  )![0];
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(Date.parse(tick.fireAt) + 60_000);
    await health.onTimer(tick);
  } finally {
    vi.useRealTimers();
  }
  await runtime.observe(run, batch.cursor);
  expect(observe.mock.instances.at(-1)).not.toBe(before);
  expect(maxPolls).toBe(1);
  expect(activePolls).toBe(1);
  expect(spawn).toHaveBeenCalledTimes(1);
  await runtime.answer(questionRef('question'), 'answer', {
    workflowId: 'workflow',
    commandId: 'answer',
  });
  expect(answered.mock.instances.at(-1)).toBe(observe.mock.instances.at(-1));
  const ui = await browser(server);
  expect(
    (await ui.call('GET', '/api/v1/health')).body.runtime.warnings,
  ).toContain('host_slept');
  await server.close();
  expect(activePolls).toBe(0);
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(healthClose).toHaveBeenCalled();
  expect(
    replay.exec.mock.calls.some(([r]) => r.bin === '/usr/bin/caffeinate'),
  ).toBe(false);
});

it('reports a fresh fake office as owned and a dev hijack as a takeover', async () => {
  const server = await boot(home());
  const ui = await browser(server);
  const runOwned = async () =>
    (await ui.call('GET', '/api/v1/health')).body.runtime.runOwned;
  // The adapter reports ownership `none` before any run exists.
  expect(await runOwned()).toBe(true);
  const repoId = (await ui.call('GET', '/api/v1/repos')).body.repos[0].repoId;
  const started = await ui.call('POST', '/api/v1/workflows', {
    templateId: 'feature-to-pr',
    repoId,
    requirement: 'Hijack me',
  });
  expect(started.status).toBe(201);
  await server.runners.idle();
  const hijack = await ui.call('POST', '/dev/fake/runtime/hijack', {});
  expect(hijack.body.hijacked).toBeGreaterThan(0);
  await vi.waitFor(async () => expect(await runOwned()).toBe(false), {
    timeout: 10_000,
  });
});
