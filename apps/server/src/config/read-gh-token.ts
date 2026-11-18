import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'node:child_process';
import { resolveExecutable, subprocessEnvironments } from './runtime-config.js';
import type { Settings } from './settings.js';

export type GhTokenSpawn = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

export function readGhToken(
  settings: Settings,
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  spawn: GhTokenSpawn = spawnSync,
): string {
  if (
    settings.github.tokenSource !== 'gh' &&
    env.AI_OFFICE_GITHUB_TOKEN?.trim()
  ) {
    return env.AI_OFFICE_GITHUB_TOKEN.trim();
  }
  if (settings.github.tokenSource === 'env')
    throw new Error('Set AI_OFFICE_GITHUB_TOKEN to authenticate GitHub');
  try {
    const result = spawn(
      resolveExecutable('gh', settings.github.ghBin, env),
      ['auth', 'token'],
      {
        shell: false,
        cwd: `${dataDir}/cli-cwd`,
        env: subprocessEnvironments(settings, env).gitFetchEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      },
    );
    if (!result.error && result.status === 0 && result.stdout?.trim())
      return result.stdout.trim();
  } catch {
    /* Subprocess exceptions can contain tokens; do not propagate them. */
  }
  throw new Error(
    'GitHub authentication failed; set AI_OFFICE_GITHUB_TOKEN or run gh auth login',
  );
}
