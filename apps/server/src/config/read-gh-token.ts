import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'node:child_process';
import { resolveExecutable, subprocessEnvironments } from './runtime-config.js';
import type { Settings } from './settings.js';
import { GithubLoginSchema } from './settings.js';

export type GhTokenSpawn = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

/** The temporary credential is passed only to the caller's identity request. */
export async function readActiveGhLogin(
  settings: Settings,
  dataDir: string,
  lookup: (token: string) => Promise<string>,
  env: NodeJS.ProcessEnv = process.env,
  spawn: GhTokenSpawn = spawnSync,
): Promise<string> {
  return lookup(readGhToken(settings, dataDir, env, spawn, { active: true }));
}

export function readGhToken(
  settings: Settings,
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  spawn: GhTokenSpawn = spawnSync,
  options: { user?: string; active?: boolean } = {},
): string {
  if (
    options.user !== undefined &&
    !GithubLoginSchema.safeParse(options.user).success
  )
    throw new Error('Invalid GitHub login');
  if (
    !options.active &&
    settings.github.tokenSource !== 'gh' &&
    env.AI_OFFICE_GITHUB_TOKEN?.trim()
  ) {
    return env.AI_OFFICE_GITHUB_TOKEN.trim();
  }
  if (!options.active && settings.github.tokenSource === 'env')
    throw new Error('Set AI_OFFICE_GITHUB_TOKEN to authenticate GitHub');
  try {
    const result = spawn(
      resolveExecutable('gh', settings.github.ghBin, env),
      [
        'auth',
        'token',
        ...(options.user === undefined ? [] : ['--user', options.user]),
        '--hostname',
        'github.com',
      ],
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
    `GitHub authentication failed; run gh auth login${options.user ? ` for ${options.user}` : ''}`,
  );
}
