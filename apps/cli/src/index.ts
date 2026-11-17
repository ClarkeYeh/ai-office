import { submit, type CliResult, type SubmitOptions } from './submit.js';

export async function runCli(
  args: readonly string[],
  options?: SubmitOptions,
): Promise<CliResult> {
  const command = args[0];
  if (command === 'submit') return submit(args.slice(1), options);
  if (command === 'start') {
    return { exitCode: 1, message: 'start is not implemented yet.' };
  }
  const help =
    command === undefined || command === '--help' || command === '-h';
  return { exitCode: help ? 0 : 1, message: 'Usage: ai-office <submit|start>' };
}
