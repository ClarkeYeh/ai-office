/**
 * M3-T16/T17: the real `ai-office start` entry (built CLI → server child) in
 * production mode, with a minimal GUI-like environment (`PATH=/usr/bin:/bin`,
 * HOME, AI_OFFICE_HOME). No IPC and no testOnly seam exist in production, so
 * the caller ledgers the shim by its marker (`OrcaHarness.scan`). Output stays
 * in memory: the bootstrap line carries a login code and is never returned.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Built CLI entry; the minimal environment cannot run TypeScript sources. */
export const CLI_ENTRY = resolve(
  import.meta.dirname,
  '../../../../cli/dist/main.js',
);

const OPEN = /^Open (http:\/\/127\.0\.0\.1:\d+)\/auth\/bootstrap\?code=\S+$/;

export type ProductionCliResult =
  | {
      kind: 'ready';
      url: string;
      bootstrapUrl: string;
      /** The `AI Office listening on …` banner line. */
      banner: string;
      /** Server pid from runtime.json (the CLI's own child). */
      serverPid: number;
      /** Stops like Ctrl-C; resolves with the CLI exit code. */
      stop(): Promise<number>;
    }
  | { kind: 'exited'; exitCode: number; lines: string[] };

export async function runProductionCli(options: {
  home: string;
  /** Extra variables on top of the minimal environment. */
  env?: Record<string, string>;
  /** Extra `ai-office start` arguments (production adds none). */
  args?: string[];
  readyTimeoutMs?: number;
}): Promise<ProductionCliResult> {
  await access(CLI_ENTRY).catch(() => {
    throw new Error('Run `pnpm -r build` first: the CLI is not built');
  });
  const home = process.env.HOME;
  if (!home) throw new Error('HOME required');
  const child: ChildProcess = spawn(
    process.execPath,
    [CLI_ENTRY, 'start', '--no-open', '--port', '0', ...(options.args ?? [])],
    {
      // §27 "gh/git usable when launched from the GUI": no shell PATH, no tokens.
      env: {
        PATH: '/usr/bin:/bin',
        HOME: home,
        AI_OFFICE_HOME: options.home,
        ...options.env,
      },
      cwd: options.home,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    },
  );
  const lines: string[] = [];
  let buffered = '';
  const collect = (chunk: string) => {
    buffered += chunk;
    const parts = buffered.split('\n');
    buffered = parts.pop()!;
    for (const line of parts) if (line) lines.push(line);
  };
  child.stdout!.setEncoding('utf8').on('data', collect);
  child.stderr!.setEncoding('utf8').on('data', collect);
  const exited = new Promise<number>((done) => {
    child.once('error', () => done(1));
    child.once('exit', (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
  const deadline = Date.now() + (options.readyTimeoutMs ?? 120_000);
  for (;;) {
    const open = lines.map((line) => OPEN.exec(line)).find(Boolean);
    if (open) {
      const runtime = JSON.parse(
        await readFile(join(options.home, 'runtime.json'), 'utf8'),
      ) as { pid: number };
      const serverPid = runtime.pid;
      return {
        kind: 'ready',
        url: open[1]!,
        bootstrapUrl: open[0].slice('Open '.length),
        banner: lines.find((l) => l.startsWith('AI Office listening on')) ?? '',
        serverPid,
        async stop() {
          if (child.exitCode === null && child.signalCode === null)
            child.kill('SIGINT');
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            try {
              process.kill(serverPid, 'SIGKILL');
            } catch {
              /* Already gone. */
            }
          }, 60_000);
          try {
            return await exited;
          } finally {
            clearTimeout(timer);
          }
        },
      };
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      const exitCode = await exited;
      return { kind: 'exited', exitCode, lines: lines.filter(safe) };
    }
    if (Date.now() > deadline) {
      child.kill('SIGINT');
      await exited;
      throw new Error('Production backend did not become ready');
    }
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** Lines safe to keep: never the bootstrap login code. */
const safe = (line: string) => !line.includes('/auth/bootstrap');
