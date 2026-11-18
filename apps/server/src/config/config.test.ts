import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GhTokenSpawn } from './read-gh-token.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireInstanceLock,
  createDataDirectories,
  InstanceLockedError,
  readGhToken,
  readSettings,
  resolveDataDir,
  SettingsSchema,
} from './index.js';

const directories: string[] = [];
function home(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aio-config-'));
  directories.push(directory);
  createDataDirectories(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('settings', () => {
  it('resolves the default home and override', () => {
    expect(resolveDataDir({ HOME: '/home/example' })).toBe(
      '/home/example/.ai-office',
    );
    expect(
      resolveDataDir({ HOME: '/home/example', AI_OFFICE_HOME: '/tmp/custom/' }),
    ).toBe('/tmp/custom');
    expect(() => resolveDataDir({ AI_OFFICE_HOME: 'relative' })).toThrow(
      'absolute',
    );
  });
  it('creates directories and restricts specs, including an existing directory', () => {
    const directory = home();
    for (const child of [
      'templates',
      'data',
      'data/specs',
      'logs',
      'cli-cwd',
      'orca-home',
    ])
      expect(statSync(`${directory}/${child}`).isDirectory()).toBe(true);
    expect(statSync(`${directory}/data/specs`).mode & 0o777).toBe(0o700);
  });
  it('uses the specification defaults and merges partial settings', () => {
    const directory = home();
    const defaults = readSettings(directory);
    expect(defaults).toEqual({
      server: { port: 4319 },
      orca: {
        bin: 'orca',
        supportedRange: '>=1.4.259 <1.5',
        shimLocation: 'folder-workspace',
        shim: { closeOnExit: false },
        cliConcurrency: 4,
        maxCallsPerMinute: 120,
        preventSleep: true,
      },
      engine: { spawnStallMs: 600000 },
      budget: { enforcement: 'on' },
      usage: {
        budgetFormula: 'inputUncached + output + cacheWrite',
        claudeConfigDirs: [],
        codexHomes: [],
      },
      github: { tokenSource: 'auto', ghBin: '' },
      env: { passthrough: ['GH_CONFIG_DIR', 'XDG_CONFIG_HOME'] },
      limits: { globalAgents: 10 },
      retention: { workerBranches: 'delete-on-complete' },
    });
    writeFileSync(
      `${directory}/config.toml`,
      '[server]\nport = 4320\n[orca]\nshim.closeOnExit = true\n',
    );
    expect(readSettings(directory).server.port).toBe(4320);
    expect(readSettings(directory).orca.shim.closeOnExit).toBe(true);
  });
  it('reports invalid field paths without echoing values', () => {
    const directory = home();
    writeFileSync(
      `${directory}/config.toml`,
      '[server]\nport = "sensitive-value"\n[limits]\nglobalAgents = 0',
    );
    expect(() => readSettings(directory)).toThrow(
      'server.port, limits.globalAgents',
    );
    expect(() => readSettings(directory)).not.toThrow('sensitive-value');
    writeFileSync(`${directory}/config.toml`, '[server');
    expect(() => readSettings(directory)).toThrow('TOML syntax');
  });
});

describe('GitHub token', () => {
  it('prefers the explicit environment token without spawning', () => {
    const run = vi.fn<GhTokenSpawn>();
    expect(
      readGhToken(
        SettingsSchema.parse({}),
        '/tmp/example',
        { AI_OFFICE_GITHUB_TOKEN: ' example-value\n' },
        run,
      ),
    ).toBe('example-value');
    expect(run).not.toHaveBeenCalled();
  });
  it('uses only the fixed command, filtered environment and dedicated cwd', () => {
    const run = vi.fn<GhTokenSpawn>().mockReturnValue({
      pid: 1,
      output: [],
      stdout: 'example-value\n',
      stderr: '',
      status: 0,
      signal: null,
    });
    const settings = SettingsSchema.parse({
      github: { ghBin: '/custom/gh' },
      env: {
        passthrough: [
          'CUSTOM_CONFIG',
          'GH_CONFIG_DIR',
          'XDG_CONFIG_HOME',
          'GH_TOKEN',
          'GITHUB_TOKEN',
          'ORCA_TEST',
          'CODEX_TEST',
          'CLAUDE_TEST',
          'AI_OFFICE_GITHUB_TOKEN',
        ],
      },
    });
    expect(
      readGhToken(
        settings,
        '/tmp/example',
        {
          PATH: '/bin',
          HOME: '/tmp/home',
          GH_CONFIG_DIR: '/config',
          XDG_CONFIG_HOME: '/xdg',
          CUSTOM_CONFIG: 'custom',
          GH_TOKEN: 'excluded',
          GITHUB_TOKEN: 'excluded',
          ORCA_TEST: 'excluded',
          CODEX_TEST: 'excluded',
          CLAUDE_TEST: 'excluded',
          UNLISTED: 'excluded',
        },
        run,
      ),
    ).toBe('example-value');
    expect(run).toHaveBeenCalledWith(
      '/custom/gh',
      ['auth', 'token'],
      expect.objectContaining({
        shell: false,
        cwd: '/tmp/example/cli-cwd',
        env: {
          PATH: '/bin',
          HOME: '/tmp/home',
          GH_CONFIG_DIR: '/config',
          XDG_CONFIG_HOME: '/xdg',
          CUSTOM_CONFIG: 'custom',
        },
        timeout: 10_000,
      }),
    );
  });
  it('honors explicit token sources and sanitizes failures', () => {
    const run = vi.fn<GhTokenSpawn>().mockImplementation(() => {
      throw new Error('sensitive-value');
    });
    expect(() =>
      readGhToken(
        SettingsSchema.parse({ github: { tokenSource: 'env' } }),
        home(),
        {},
        run,
      ),
    ).toThrow('Set AI_OFFICE_GITHUB_TOKEN');
    expect(run).not.toHaveBeenCalled();
    expect(() =>
      readGhToken(
        SettingsSchema.parse({ github: { tokenSource: 'gh' } }),
        home(),
        { AI_OFFICE_GITHUB_TOKEN: 'ignored' },
        run,
      ),
    ).toThrow('GitHub authentication failed');
  });
});

describe('instance lock and runtime information', () => {
  it('rejects a live owner with its pid and releases idempotently', () => {
    const directory = home();
    const lock = acquireInstanceLock(directory);
    expect(() => acquireInstanceLock(directory)).toThrow(InstanceLockedError);
    expect(() => acquireInstanceLock(directory)).toThrow(String(process.pid));
    lock.release();
    lock.release();
    acquireInstanceLock(directory).release();
  });
  it('rejects a separate live process and takes over after it exits', async () => {
    const directory = home();
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
    );
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const exited = new Promise<void>((resolve) =>
      child.once('exit', () => resolve()),
    );
    try {
      writeFileSync(
        `${directory}/data/.lock`,
        JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }),
      );
      expect(() => acquireInstanceLock(directory)).toThrow(String(child.pid));
    } finally {
      child.kill();
      await exited;
    }
    const lock = acquireInstanceLock(directory);
    expect(lock.pid).toBe(process.pid);
    lock.release();
  });
  it('fails closed on malformed locks', () => {
    const directory = home();
    writeFileSync(`${directory}/data/.lock`, '{}');
    expect(() => acquireInstanceLock(directory)).toThrow(
      'Invalid instance lock',
    );
  });
  it('writes private runtime information only through a current holder', () => {
    const directory = home();
    const lock = acquireInstanceLock(directory);
    writeFileSync(`${directory}/runtime.json`, 'old', { mode: 0o644 });
    const runtime = lock.writeRuntime(4319);
    expect(
      JSON.parse(readFileSync(`${directory}/runtime.json`, 'utf8')),
    ).toEqual({ port: 4319, pid: process.pid, startedAt: lock.startedAt });
    expect(runtime.port).toBe(4319);
    expect(statSync(`${directory}/runtime.json`).mode & 0o777).toBe(0o600);
    lock.release();
    expect(() => lock.writeRuntime(4320)).toThrow(
      'Only the instance lock holder',
    );
  });
  it('does not remove or write through a replaced lock', () => {
    const directory = home();
    const lock = acquireInstanceLock(directory);
    rmSync(`${directory}/data/.lock`);
    writeFileSync(`${directory}/data/.lock`, 'replacement');
    expect(() => lock.writeRuntime(4319)).toThrow(
      'Only the instance lock holder',
    );
    lock.release();
    expect(readFileSync(`${directory}/data/.lock`, 'utf8')).toBe('replacement');
  });
  it('removes its own runtime.json on release but leaves a foreign one', () => {
    const directory = home();
    const lock = acquireInstanceLock(directory);
    lock.writeRuntime(4319);
    lock.release();
    expect(existsSync(`${directory}/runtime.json`)).toBe(false);
    const next = acquireInstanceLock(directory);
    writeFileSync(
      `${directory}/runtime.json`,
      JSON.stringify({ port: 1, pid: 1, startedAt: next.startedAt }),
    );
    next.release();
    expect(existsSync(`${directory}/runtime.json`)).toBe(true);
  });
  it('treats a lock recorded with its own pid but not held here as stale (container pid 1)', () => {
    const directory = home();
    writeFileSync(
      `${directory}/data/.lock`,
      JSON.stringify({ pid: process.pid, startedAt: '2026-01-01T00:00:00Z' }),
    );
    const lock = acquireInstanceLock(directory);
    expect(lock.startedAt).not.toBe('2026-01-01T00:00:00Z');
    expect(() => acquireInstanceLock(directory)).toThrow(InstanceLockedError);
    lock.release();
  });
  it('breaks a lock only when asked, naming pid and start time otherwise', async () => {
    const directory = home();
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { stdio: 'ignore' },
    );
    await new Promise<void>((resolve) => child.once('spawn', resolve));
    try {
      writeFileSync(
        `${directory}/data/.lock`,
        JSON.stringify({ pid: child.pid, startedAt: '2026-01-01T00:00:00Z' }),
      );
      expect(() => acquireInstanceLock(directory)).toThrow(
        /2026-01-01T00:00:00Z.*--break-lock/,
      );
      const lock = acquireInstanceLock(directory, { breakLock: true });
      expect(lock.pid).toBe(process.pid);
      lock.release();
    } finally {
      child.kill();
    }
  });
  it('waits briefly for a holder that has created but not yet written the lock', async () => {
    const directory = home();
    const path = `${directory}/data/.lock`;
    writeFileSync(path, '');
    const child = spawn(
      process.execPath,
      [
        '-e',
        `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(path)}, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })), 50); setInterval(() => {}, 1000)`,
      ],
      { stdio: 'ignore' },
    );
    await new Promise<void>((resolve) => child.once('spawn', resolve));
    try {
      expect(() => acquireInstanceLock(directory)).toThrow(String(child.pid));
    } finally {
      child.kill();
    }
  });
});
