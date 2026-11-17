import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'node:child_process';
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
  const childEnv: NodeJS.ProcessEnv = {};
  const keys = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    ...settings.env.passthrough,
  ];
  for (const key of keys) {
    // Passthrough permits gh configuration, never identity or token overrides.
    if (
      /^(ORCA_|CLAUDE|CODEX_|AI_OFFICE_|GITHUB_)/.test(key) ||
      (key.startsWith('GH_') && key !== 'GH_CONFIG_DIR')
    )
      continue;
    if (env[key] !== undefined) childEnv[key] = env[key];
  }
  try {
    const result = spawn(settings.github.ghBin || 'gh', ['auth', 'token'], {
      shell: false,
      cwd: `${dataDir}/cli-cwd`,
      env: childEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    if (!result.error && result.status === 0 && result.stdout?.trim())
      return result.stdout.trim();
  } catch {
    /* Subprocess exceptions can contain tokens; do not propagate them. */
  }
  throw new Error(
    'GitHub authentication failed; set AI_OFFICE_GITHUB_TOKEN or run gh auth login',
  );
}
