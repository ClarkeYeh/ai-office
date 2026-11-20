import { execFile } from 'node:child_process';
import { assertOptIn } from './safety.js';

/** Deliberately no shell, arbitrary executable, or error/output logging. */
export function git(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, env, shell: false, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(new Error('Git harness command failed'));
        else resolve(stdout.trim());
      },
    );
  });
}
export function ghToken(active = false): Promise<string> {
  // Fail closed: offline tests must never read the machine's real credential.
  try {
    assertOptIn(process.env);
  } catch (error) {
    return Promise.reject(error as Error);
  }
  // Ignore ambient tokens: --user must select the stored ClarkeYeh credential.
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_ENTERPRISE_TOKEN;
  delete env.GITHUB_ENTERPRISE_TOKEN;
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      [
        'auth',
        'token',
        ...(active ? [] : ['--user', 'ClarkeYeh']),
        '--hostname',
        'github.com',
      ],
      { env, shell: false, timeout: 10_000 },
      (error, stdout) => {
        if (error || !stdout.trim())
          reject(new Error('Cannot obtain GitHub credential'));
        else resolve(stdout.trim());
      },
    );
  });
}
