/**
 * Starts `backend-child.js` (built dist) with a minimal GUI-like environment
 * (`PATH=/usr/bin:/bin`, HOME, AI_OFFICE_HOME), relays shim reports into the
 * harness ledger, and supports `kill -9` plus the orphan-process inventory.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ComposedEffects } from '../harness.js';

const run = promisify(execFile);

/** Built child entry: the minimal environment cannot run TypeScript sources. */
export const CHILD_ENTRY = resolve(
  import.meta.dirname,
  '../../../../dist/test-support/orca/t17/backend-child.js',
);

export interface BackendProcess {
  readonly pid: number;
  readonly url: string;
  readonly bootstrapUrl: string;
  kill9(): Promise<void>;
  stop(): Promise<void>;
}

export async function startBackendProcess(options: {
  home: string;
  orcaHome: string;
  /** First start only: ledgers the shim the backend creates. */
  effects?: ComposedEffects;
  logName: string;
}): Promise<BackendProcess> {
  await access(CHILD_ENTRY).catch(() => {
    throw new Error('Run `pnpm -r build` first: T17 child backend not built');
  });
  const home = process.env.HOME;
  if (!home) throw new Error('HOME required');
  const log = createWriteStream(join(options.home, options.logName), {
    mode: 0o600,
  });
  const child: ChildProcess = spawn(process.execPath, [CHILD_ENTRY], {
    // §27 "gh/git usable when launched from the GUI": no shell PATH, no tokens.
    env: {
      PATH: '/usr/bin:/bin',
      HOME: home,
      AI_OFFICE_HOME: options.home,
      AIO_T17_ORCA_HOME: options.orcaHome,
    },
    cwd: options.home,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout!.pipe(log);
  child.stderr!.pipe(log);
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  const ready = await new Promise<{ url: string; bootstrapUrl: string }>(
    (resolveReady, reject) => {
      child.once('exit', (code, signal) =>
        reject(new Error(`T17 backend exited early (${code ?? signal})`)),
      );
      child.on('message', (m: { type: string; [k: string]: unknown }) => {
        if (m.type === 'shim') {
          const ledgered = options.effects
            ? options.effects.shim(String(m.handle))
            : Promise.reject(new Error('Restarted backend created a new shim'));
          ledgered.then(
            () => child.send({ type: 'shim-ack' }),
            (error: unknown) => {
              child.kill('SIGTERM');
              reject(error as Error);
            },
          );
        }
        if (m.type === 'ready')
          resolveReady({
            url: String(m.url),
            bootstrapUrl: String(m.bootstrapUrl),
          });
        if (m.type === 'failed') reject(new Error(String(m.message)));
      });
    },
  );
  return {
    pid: child.pid!,
    ...ready,
    async kill9() {
      child.kill('SIGKILL');
      await exited;
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      await Promise.race([
        exited,
        new Promise((r) => setTimeout(r, 30_000)).then(() =>
          child.kill('SIGKILL'),
        ),
      ]);
      await exited;
    },
  };
}

/** PIDs of `orca orchestration check` long polls issued for `shim`. */
export async function checkProcesses(shim: string): Promise<number[]> {
  const { stdout } = await run('/bin/ps', ['-axww', '-o', 'pid=,command='], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout
    .split('\n')
    .filter(
      (line) => line.includes('orchestration check') && line.includes(shim),
    )
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter(Number.isSafeInteger);
}

export async function alive(pids: number[]): Promise<number[]> {
  return pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
}
