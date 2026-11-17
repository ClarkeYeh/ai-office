export function runCli(args: readonly string[]): {
  exitCode: number;
  message: string;
} {
  const command = args[0];
  if (command === 'submit' || command === 'start') {
    return { exitCode: 1, message: command + ' is not implemented yet.' };
  }
  const help =
    command === undefined || command === '--help' || command === '-h';
  return { exitCode: help ? 0 : 1, message: 'Usage: ai-office <submit|start>' };
}
