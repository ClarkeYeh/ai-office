import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
import type { RunningServer, StartOptions } from './main.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON over HTTP
type Json = Record<string, any>;

const homes: string[] = [];
const servers: RunningServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
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

  it('refuses production mode until the Orca adapter exists, releasing the lock', async () => {
    const directory = home();
    await expect(
      startServer({ env: { AI_OFFICE_HOME: directory }, port: 0 }),
    ).rejects.toThrow(/M2/);
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

describe('backend process', () => {
  // Built by `pnpm -r build` before tests (DoD order).
  const serverMain = resolve(import.meta.dirname, '../dist/main.js');

  it('shuts down gracefully when SIGTERM repeats during shutdown', async () => {
    const directory = home();
    const child = spawn(
      process.execPath,
      [serverMain, '--dev', '--fake', 'mainline', '--port', '0'],
      {
        env: { ...process.env, AI_OFFICE_HOME: directory },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    const exited = new Promise<[number | null, NodeJS.Signals | null]>((done) =>
      child.once('exit', (code, signal) => done([code, signal])),
    );
    let out = '';
    const bootstrap = await new Promise<string>((done, fail) => {
      child.stdout.on('data', (chunk) => {
        out += String(chunk);
        const url = /Open (\S+)/.exec(out)?.[1];
        if (url) done(url);
      });
      void exited.then(() => fail(new Error(`backend exited early: ${out}`)));
    });
    // A served request means main() is past startup and listening for signals.
    expect((await fetch(bootstrap, { redirect: 'manual' })).status).toBe(302);
    expect(existsSync(join(directory, 'runtime.json'))).toBe(true);

    // Keep signalling until it exits, as an impatient supervisor would.
    const repeat = setInterval(() => child.kill('SIGTERM'), 1);
    child.kill('SIGTERM');
    const [code, signal] = await exited.finally(() => clearInterval(repeat));
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(existsSync(join(directory, 'runtime.json'))).toBe(false);
    expect(existsSync(join(directory, 'data/.lock'))).toBe(false);
  }, 60_000);
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
