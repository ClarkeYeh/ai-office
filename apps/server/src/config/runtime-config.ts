import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { parse } from 'smol-toml';
import type { Settings } from './settings.js';

const baseKeys = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
];

/** Only gh authentication and git fetch may receive the configured additions. */
export function subprocessEnvironments(
  settings: Settings,
  env: NodeJS.ProcessEnv = process.env,
): { orcaEnv: NodeJS.ProcessEnv; gitFetchEnv: NodeJS.ProcessEnv } {
  const orcaEnv: NodeJS.ProcessEnv = {};
  for (const key of baseKeys)
    if (env[key] !== undefined) orcaEnv[key] = env[key];
  const gitFetchEnv = { ...orcaEnv };
  for (const key of settings.env.passthrough) {
    if (
      /^(ORCA_|CLAUDE|CODEX_|AI_OFFICE_|GITHUB_)/.test(key) ||
      (key.startsWith('GH_') && key !== 'GH_CONFIG_DIR')
    )
      continue;
    if (env[key] !== undefined) gitFetchEnv[key] = env[key];
  }
  return { orcaEnv, gitFetchEnv };
}

const knownPaths = {
  orca: ['/Applications/Orca.app/Contents/Resources/bin/orca'],
  gh: ['/opt/homebrew/bin/gh', '/usr/local/bin/gh'],
};

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolve without a shell/which subprocess; ignore relative PATH entries. */
export function resolveExecutable(
  name: 'orca' | 'gh',
  configured: string,
  env: NodeJS.ProcessEnv = process.env,
  executable: (path: string) => boolean = isExecutable,
): string {
  if (configured && configured !== name) {
    if (!configured.startsWith('/') || configured.includes('\0'))
      throw new Error(`Invalid ${name} binary path: expected an absolute path`);
    return configured;
  }
  const candidates = [
    ...(env.PATH ?? '')
      .split(':')
      .filter((dir) => dir.startsWith('/'))
      .map((dir) => `${dir.replace(/\/+$/, '')}/${name}`),
    ...knownPaths[name],
  ];
  const found = candidates.find(executable);
  if (!found)
    throw new Error(
      `Cannot resolve ${name} binary; configure an absolute path`,
    );
  return found;
}

/** M2-T16 P5a matrix (codex-cli 0.167.1): `inherit` other than "all", any
 * `exclude`, or `include_only` drops ORCA_*; `ignore_default_excludes = false`
 * drops ORCA_PANE_KEY (default *KEY* exclusion); `set` only adds variables.
 * Never return config contents or parser diagnostics. */
export function codexEnvironmentWarnings(
  env: NodeJS.ProcessEnv = process.env,
): 'codex_env_filtered'[] {
  const home = env.CODEX_HOME || (env.HOME ? `${env.HOME}/.codex` : undefined);
  if (!home || !home.startsWith('/')) return ['codex_env_filtered'];
  try {
    const config = parse(readFileSync(`${home}/config.toml`, 'utf8'));
    const policy = config.shell_environment_policy;
    if (policy === undefined) return [];
    if (!policy || typeof policy !== 'object' || Array.isArray(policy))
      return ['codex_env_filtered'];
    const p = policy as Record<string, unknown>;
    if (
      (p.inherit !== undefined && p.inherit !== 'all') ||
      (p.exclude !== undefined &&
        (!Array.isArray(p.exclude) || p.exclude.length > 0)) ||
      p.include_only !== undefined ||
      p.ignore_default_excludes === false
    )
      return ['codex_env_filtered'];
    return [];
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return [];
    return ['codex_env_filtered'];
  }
}

/** Composition input for T10: paths/warnings feed health; environments are private
 * subprocess inputs and must never be included in health or logs. */
export function resolveRuntimeConfig(
  settings: Settings,
  env: NodeJS.ProcessEnv = process.env,
) {
  const environments = subprocessEnvironments(settings, env);
  return {
    orcaBinPath: resolveExecutable(
      'orca',
      settings.orca.bin,
      environments.orcaEnv,
    ),
    ghBinPath: resolveExecutable(
      'gh',
      settings.github.ghBin,
      environments.gitFetchEnv,
    ),
    ...environments,
    warnings: codexEnvironmentWarnings(env),
  };
}
