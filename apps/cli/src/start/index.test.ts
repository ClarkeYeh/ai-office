import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { start } from './index.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
const home = () => {
  const directory = mkdtempSync(join(tmpdir(), 'aio-cli-start-'));
  homes.push(directory);
  return directory;
};
// Built by `pnpm -r build` before tests (DoD order).
const dist = resolve(import.meta.dirname, '../../..');
const serverPath = join(dist, 'server/dist/main.js');
const cliMain = join(dist, 'cli/dist/main.js');

describe('ai-office start', () => {
  it('rejects --fake without --dev and unknown flags before spawning', async () => {
    const spawnSpy = vi.fn();
    const options = { spawn: spawnSpy as never, env: { HOME: home() } };
    expect(await start(['--fake', 'mainline'], options)).toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('--dev'),
    });
    expect((await start(['--bogus'], options)).exitCode).toBe(1);
    expect((await start(['--fake'], options)).exitCode).toBe(1);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('starts the backend, waits for runtime.json and opens the bootstrap URL', async () => {
    const directory = home();
    let child: ChildProcess | undefined;
    let opened: string | undefined;
    const lines: string[] = [];
    const running = start(['--dev', '--fake', 'mainline', '--port', '0'], {
      env: { ...process.env, AI_OFFICE_HOME: directory },
      serverPath,
      spawn: ((...args: Parameters<typeof spawn>) => {
        child = spawn(...args);
        return child;
      }) as typeof spawn,
      print: (line) => lines.push(line),
      openBrowser: (url) => {
        opened = url;
        void fetch(url, { redirect: 'manual' }).then((response) => {
          expect(response.status).toBe(302);
          child!.kill('SIGTERM');
        });
      },
    });
    const result = await running;
    expect(opened).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/auth\/bootstrap\?code=/,
    );
    expect(lines.join('\n')).toContain('runtime: fake');
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(directory, 'runtime.json'))).toBe(false);
  }, 60_000);

  it('works from the built CLI entry and rejects --fake without --dev there too', async () => {
    const directory = home();
    const run = (args: string[]) =>
      spawn(process.execPath, [cliMain, 'start', ...args], {
        env: { ...process.env, AI_OFFICE_HOME: directory },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    const refused = run(['--fake', 'mainline']);
    let refusedOut = '';
    refused.stdout.on('data', (chunk) => (refusedOut += String(chunk)));
    expect(await new Promise((done) => refused.once('exit', done))).toBe(1);
    expect(refusedOut).toContain('requires --dev');

    const cli = run([
      '--dev',
      '--fake',
      'mainline',
      '--port',
      '0',
      '--no-open',
    ]);
    let output = '';
    await new Promise<void>((done) =>
      cli.stdout.on('data', (chunk) => {
        output += String(chunk);
        if (output.includes('/auth/bootstrap?code=')) done();
      }),
    );
    expect(existsSync(join(directory, 'runtime.json'))).toBe(true);
    cli.kill('SIGINT');
    expect(await new Promise((done) => cli.once('exit', done))).toBe(0);
  }, 60_000);

  it('the backend closes cleanly on a stop right after printing its bootstrap URL', async () => {
    // The URL is printed before startServer resolves, and `start` forwards
    // Ctrl-C as soon as it can: the backend must close, not die by signal.
    const directory = home();
    const server = spawn(
      process.execPath,
      [serverPath, '--dev', '--fake', 'mainline', '--port', '0'],
      {
        env: { ...process.env, AI_OFFICE_HOME: directory },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    server.stdout.on('data', (chunk) => {
      output += String(chunk);
      if (output.includes('/auth/bootstrap?code=')) server.kill('SIGTERM');
    });
    const [code, signal] = await new Promise<unknown[]>((done) =>
      server.once('exit', (...result) => done(result)),
    );
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(existsSync(join(directory, 'runtime.json'))).toBe(false);
  }, 30_000);
});
