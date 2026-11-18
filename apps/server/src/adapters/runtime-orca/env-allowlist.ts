import { resolve } from 'node:path';
export const ORCA_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
] as const;
export function subprocessEnv(
  env: NodeJS.ProcessEnv,
  passthrough: readonly string[] = [],
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [...ORCA_ENV_ALLOWLIST, ...passthrough]) {
    if (env[key] !== undefined) result[key] = env[key];
  }
  return result;
}
/** Composition root can use this without importing CLI execution. */
export function orcaSubprocessPolicy(
  dataDir: string,
  env: NodeJS.ProcessEnv,
): { cwd: string; env: NodeJS.ProcessEnv } {
  return { cwd: resolve(dataDir, 'cli-cwd'), env: subprocessEnv(env) };
}
