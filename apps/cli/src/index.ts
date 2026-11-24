import { open, type OpenOptions } from './open/index.js';
import { start, type StartOptions } from './start/index.js';
import { submit, type CliResult, type SubmitOptions } from './submit.js';

export async function runCli(
  args: readonly string[],
  options?: SubmitOptions & StartOptions & OpenOptions,
): Promise<CliResult> {
  const command = args[0];
  if (command === 'submit') return submit(args.slice(1), options);
  if (command === 'open') return open(args.slice(1), options);
  if (command === 'start') return start(args.slice(1), options);
  const help =
    command === undefined || command === '--help' || command === '-h';
  return {
    exitCode: help ? 0 : 1,
    message: 'Usage: ai-office <submit|start|open>',
  };
}
