import { spawn as spawnProcess } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RuntimeInfoSchema } from '@ai-office/contracts/agent-submission';
import type { CliResult } from '../submit.js';

export interface StartOptions {
  env?: NodeJS.ProcessEnv;
  /** `<installDir>/apps/server/dist/main.js`. */
  serverPath?: string;
  /** This CLI's own entry, handed to SpecBuilder through the server (Q8). */
  cliPath?: string;
  spawn?: typeof spawnProcess;
  /** Opens the bootstrap URL; defaults to the platform browser opener. */
  openBrowser?: (url: string) => void;
  /** Receives the server's output lines; defaults to stdout. */
  print?: (line: string) => void;
  readyTimeoutMs?: number;
}

const usage =
  'Usage: ai-office start [--port <n>] [--break-lock] [--no-open] (production); development: --dev (--fake <scenario> | --runtime orca [--orca-home <path>])';

const SERVER_FLAGS = new Set(['--dev', '--break-lock']);
const SERVER_VALUES = new Set([
  '--fake',
  '--runtime',
  '--orca-home',
  '--port',
  '--dev-origin',
]);

export function defaultOpen(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  const child = spawnProcess(command, args, {
    shell: false,
    stdio: 'ignore',
    detached: true,
  });
  child.on('error', () => undefined);
  child.unref();
}

function readRuntime(home: string) {
  try {
    return RuntimeInfoSchema.parse(
      JSON.parse(readFileSync(join(home, 'runtime.json'), 'utf8')),
    );
  } catch {
    return null;
  }
}

/**
 * Starts the backend as a child process, waits until it owns runtime.json and
 * prints its bootstrap URL, opens the browser there, then stays attached
 * until the backend exits (Ctrl-C stops it).
 */
export async function start(
  args: readonly string[],
  options: StartOptions = {},
): Promise<CliResult> {
  const forwarded: string[] = [];
  let open = true;
  let dev = false;
  let fake: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--no-open') open = false;
    else if (SERVER_FLAGS.has(arg)) {
      if (arg === '--dev') dev = true;
      forwarded.push(arg);
    } else if (SERVER_VALUES.has(arg)) {
      const value = args[++index];
      if (value === undefined || value.startsWith('--'))
        return { exitCode: 1, message: `${arg} requires a value. ${usage}` };
      if (arg === '--fake') fake = value;
      forwarded.push(arg, value);
    } else return { exitCode: 1, message: `Unknown option ${arg}. ${usage}` };
  }
  // Fake mode must never reach production (Q7); refuse before starting anything.
  if (fake !== undefined && !dev)
    return {
      exitCode: 1,
      message: `--fake ${fake} requires --dev: fake runtime, SCM and usage must never serve production.`,
    };
  if (
    !dev &&
    forwarded.some((arg) => arg === '--runtime' || arg === '--orca-home')
  )
    return {
      exitCode: 1,
      message: `--runtime and --orca-home require --dev. ${usage}`,
    };

  const env = options.env ?? process.env;
  const home =
    env.AI_OFFICE_HOME || (env.HOME ? join(env.HOME, '.ai-office') : '');
  if (!home) return { exitCode: 1, message: 'Set AI_OFFICE_HOME or HOME.' };
  const serverPath =
    options.serverPath ??
    resolve(import.meta.dirname, '../../../server/dist/main.js');
  const cliPath = options.cliPath ?? resolve(import.meta.dirname, '../main.js');
  const print = options.print ?? ((line: string) => console.log(line));
  const child: ChildProcess = (options.spawn ?? spawnProcess)(
    process.execPath,
    [serverPath, ...forwarded, '--cli-path', cliPath],
    { env, stdio: ['ignore', 'pipe', 'pipe'], shell: false },
  );
  const exited = new Promise<number>((done) => {
    child.once('error', () => done(1));
    child.once('exit', (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
  let bootstrapUrl: string | undefined;
  let buffered = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop()!;
    for (const line of lines) {
      const match =
        /^Open (http:\/\/127\.0\.0\.1:\d+\/auth\/bootstrap\?code=\S+)$/.exec(
          line,
        );
      if (match) bootstrapUrl = match[1];
      print(line);
    }
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) if (line) print(line);
  });
  // Stay attached until the backend has shut down, however often Ctrl-C arrives.
  let stopping = false;
  const stop = () => {
    stopping = true;
    child.kill('SIGTERM');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    // Ready = runtime.json written by this child (only the lock holder writes it).
    const deadline = Date.now() + (options.readyTimeoutMs ?? 60_000);
    let ready = false;
    const outcome = await Promise.race([
      exited.then((code) => ({ code })),
      (async () => {
        while (
          Date.now() < deadline &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          const runtime = readRuntime(home);
          if (runtime?.pid === child.pid && bootstrapUrl !== undefined) {
            ready = true;
            return null;
          }
          await new Promise((done) => setTimeout(done, 100));
        }
        return null;
      })(),
    ]);
    if (outcome !== null)
      return stopping
        ? { exitCode: outcome.code, message: 'AI Office stopped.' }
        : {
            exitCode: 1,
            message: 'AI Office backend exited during startup.',
          };
    if (!ready) {
      stop();
      await exited;
      return {
        exitCode: 1,
        message: 'AI Office backend did not become ready.',
      };
    }
    if (open) (options.openBrowser ?? defaultOpen)(bootstrapUrl!);
    const code = await exited;
    return { exitCode: code, message: 'AI Office stopped.' };
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
