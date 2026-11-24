import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  CONTROL_TOKEN_PREFIX,
  LocalBootstrapCodeResponseSchema,
  RuntimeInfoSchema,
} from '@ai-office/contracts/agent-submission';
import type { CliResult } from '../submit.js';
import { defaultOpen } from '../start/index.js';

export interface OpenOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  openBrowser?: (url: string) => void;
}

/** A live PID is only a hint: the Bearer endpoint must verify this instance. */
export async function open(
  args: readonly string[],
  options: OpenOptions = {},
): Promise<CliResult> {
  const env = options.env ?? process.env;
  let home =
    env.AI_OFFICE_HOME || (env.HOME ? join(env.HOME, '.ai-office') : '');
  let browser = true;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--home') home = args[++i] ?? '';
    else if (args[i] === '--no-open' || args[i] === '--print') browser = false;
    else
      return {
        exitCode: 1,
        message: 'Usage: ai-office open [--home <abs>] [--no-open] [--print]',
      };
  }
  if (!home || !isAbsolute(home))
    return {
      exitCode: 1,
      message:
        'Use an absolute --home or AI_OFFICE_HOME path; run ai-office start first.',
    };
  try {
    const runtime = RuntimeInfoSchema.parse(
      JSON.parse(readFileSync(join(home, 'runtime.json'), 'utf8')),
    );
    process.kill(runtime.pid, 0);
    const token = readFileSync(join(home, 'data/control.token'), 'utf8').trim();
    if (!new RegExp(`^${CONTROL_TOKEN_PREFIX}[a-f0-9]{64}$`).test(token))
      throw new Error();
    const origin = `http://127.0.0.1:${runtime.port}`;
    const response = await (options.fetch ?? fetch)(
      `${origin}/local/v1/bootstrap-codes`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) throw new Error();
    const result = LocalBootstrapCodeResponseSchema.parse(
      await response.json(),
    );
    const url = `${origin}/auth/bootstrap?code=${encodeURIComponent(result.code)}`;
    if (browser) (options.openBrowser ?? defaultOpen)(url);
    return { exitCode: 0, message: url };
  } catch {
    return {
      exitCode: 1,
      message:
        'Cannot verify a running AI Office instance. Run ai-office start, then try ai-office open again.',
    };
  }
}
