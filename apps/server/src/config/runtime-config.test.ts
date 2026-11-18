import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  codexEnvironmentWarnings,
  resolveExecutable,
  resolveRuntimeConfig,
  readSettings,
  SettingsSchema,
  subprocessEnvironments,
} from './index.js';

const dirs: string[] = [];
function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'aio-runtime-config-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('M2 settings', () => {
  it('loads the new keys from TOML', () => {
    const dir = temp();
    writeFileSync(
      dir + '/config.toml',
      '[orca]\npreventSleep = false\n[engine]\nspawnStallMs = 42\n[budget]\nenforcement = "off"\n[usage]\nclaudeConfigDirs = ["/extra/claude"]\ncodexHomes = ["/extra/codex"]',
    );
    const settings = readSettings(dir);
    expect(settings.orca.preventSleep).toBe(false);
    expect(settings.engine.spawnStallMs).toBe(42);
    expect(settings.budget.enforcement).toBe('off');
    expect(settings.usage.claudeConfigDirs).toEqual(['/extra/claude']);
    expect(settings.usage.codexHomes).toEqual(['/extra/codex']);
  });
  it('accepts explicit values and rejects invalid fields', () => {
    const settings = SettingsSchema.parse({
      orca: { bin: '/custom/orca', preventSleep: false },
      github: { ghBin: '/custom/gh' },
      engine: { spawnStallMs: 1234 },
      budget: { enforcement: 'off' },
      usage: {
        claudeConfigDirs: ['/custom/claude'],
        codexHomes: ['/custom/codex'],
      },
    });
    expect(settings.engine.spawnStallMs).toBe(1234);
    expect(settings.budget.enforcement).toBe('off');
    expect(settings.orca.preventSleep).toBe(false);
    expect(settings.usage.codexHomes).toEqual(['/custom/codex']);
    for (const value of [0, -1, 1.5, '600000'])
      expect(
        SettingsSchema.safeParse({ engine: { spawnStallMs: value } }).success,
      ).toBe(false);
    expect(
      SettingsSchema.safeParse({ budget: { enforcement: 'disabled' } }).success,
    ).toBe(false);
    for (const bin of ['./orca', 'bin/orca', '/bad\0path'])
      expect(SettingsSchema.safeParse({ orca: { bin } }).success).toBe(false);
    expect(
      SettingsSchema.safeParse({ github: { ghBin: '../gh' } }).success,
    ).toBe(false);
  });
});

describe('binary resolution', () => {
  it('finds known paths with a GUI PATH without spawning commands', () => {
    const env = { PATH: '/usr/bin:/bin' };
    for (const [name, path] of [
      ['orca', '/Applications/Orca.app/Contents/Resources/bin/orca'],
      ['gh', '/opt/homebrew/bin/gh'],
      ['gh', '/usr/local/bin/gh'],
    ] as const)
      expect(resolveExecutable(name, '', env, (p) => p === path)).toBe(path);
  });
  it('prefers explicit paths, then absolute PATH entries, then fallbacks', () => {
    expect(resolveExecutable('gh', '/custom/gh', {}, () => false)).toBe(
      '/custom/gh',
    );
    const tried: string[] = [];
    expect(
      resolveExecutable('gh', '', { PATH: ':relative:/custom:/bin' }, (p) => {
        tried.push(p);
        return p === '/custom/gh';
      }),
    ).toBe('/custom/gh');
    expect(tried).toEqual(['/custom/gh']);
    expect(() => resolveExecutable('gh', 'relative/gh', {})).toThrow(
      'absolute',
    );
    expect(() => resolveExecutable('gh', '', {}, () => false)).toThrow(
      'Cannot resolve gh',
    );
  });
  it('uses executable files, not directories or non-executable files', () => {
    const dir = temp();
    mkdirSync(`${dir}/first`);
    mkdirSync(`${dir}/first/gh`);
    mkdirSync(`${dir}/second`);
    writeFileSync(`${dir}/second/gh`, '', { mode: 0o600 });
    mkdirSync(`${dir}/third`);
    writeFileSync(`${dir}/third/gh`, '', { mode: 0o700 });
    chmodSync(`${dir}/third/gh`, 0o700);
    expect(
      resolveExecutable('gh', '', {
        PATH: `${dir}/first:${dir}/second:${dir}/third`,
      }),
    ).toBe(`${dir}/third/gh`);
  });
});

it('keeps passthrough exclusive to gh/git fetch, filtering identity and token overrides', () => {
  const settings = SettingsSchema.parse({
    env: {
      passthrough: [
        'CUSTOM_CONFIG',
        'GH_CONFIG_DIR',
        'ORCA_TERMINAL_HANDLE',
        'GH_TOKEN',
        'GITHUB_TOKEN',
        'CODEX_HOME',
        'CLAUDE_CONFIG_DIR',
        'AI_OFFICE_HOME',
      ],
    },
  });
  const env = {
    PATH: '/bin',
    HOME: '/example',
    CUSTOM_CONFIG: 'config',
    GH_CONFIG_DIR: '/gh',
    ORCA_TERMINAL_HANDLE: 'excluded',
    GH_TOKEN: 'excluded',
    GITHUB_TOKEN: 'excluded',
    CODEX_HOME: '/codex',
    CLAUDE_CONFIG_DIR: '/claude',
    AI_OFFICE_HOME: '/aio',
    UNLISTED: 'excluded',
  };
  const { orcaEnv, gitFetchEnv } = subprocessEnvironments(settings, env);
  expect(orcaEnv).toEqual({ PATH: '/bin', HOME: '/example' });
  expect(gitFetchEnv).toEqual({
    ...orcaEnv,
    CUSTOM_CONFIG: 'config',
    GH_CONFIG_DIR: '/gh',
  });
  gitFetchEnv.HOME = 'different';
  expect(orcaEnv.HOME).toBe('/example');
});

describe('read-only Codex policy prediction', () => {
  it.each([
    ['', false],
    ['[shell_environment_policy]\ninherit = "all"', false],
    ['[shell_environment_policy]\ninherit = "core"', true],
    ['[shell_environment_policy]\ninherit = "none"', true],
    ['[shell_environment_policy]\nexclude = ["ORCA_*"]', true],
    ['[shell_environment_policy]\ninclude_only = ["PATH", "HOME"]', true],
    ['[shell_environment_policy]\nignore_default_excludes = true', false],
    ['[shell_environment_policy]\nignore_default_excludes = false', true],
    ['[shell_environment_policy.set]\nEXTRA = "1"', false],
    ['[broken', true],
    ['shell_environment_policy = "invalid"', true],
  ])(
    'predicts policy without rewriting the source (%s)',
    (source, filtered) => {
      const dir = temp();
      writeFileSync(`${dir}/config.toml`, source);
      expect(codexEnvironmentWarnings({ CODEX_HOME: dir })).toEqual(
        filtered ? ['codex_env_filtered'] : [],
      );
      expect(readFileSync(`${dir}/config.toml`, 'utf8')).toBe(source);
    },
  );
  it('uses HOME fallback, tolerates missing files and warns on unreadable config', () => {
    const dir = temp();
    expect(codexEnvironmentWarnings({ HOME: dir })).toEqual([]);
    mkdirSync(`${dir}/.codex`);
    writeFileSync(
      `${dir}/.codex/config.toml`,
      '[shell_environment_policy]\ninherit = "core"',
    );
    expect(codexEnvironmentWarnings({ HOME: dir })).toEqual([
      'codex_env_filtered',
    ]);
    expect(codexEnvironmentWarnings({ HOME: dir, CODEX_HOME: temp() })).toEqual(
      [],
    );
    expect(codexEnvironmentWarnings({})).toEqual(['codex_env_filtered']);
    rmSync(`${dir}/.codex/config.toml`);
    mkdirSync(`${dir}/.codex/config.toml`);
    expect(codexEnvironmentWarnings({ HOME: dir })).toEqual([
      'codex_env_filtered',
    ]);
  });
});

it('exports composition inputs for health and subprocess wiring', () => {
  const settings = SettingsSchema.parse({
    orca: { bin: '/custom/orca' },
    github: { ghBin: '/custom/gh' },
  });
  const env = { HOME: temp(), GH_CONFIG_DIR: '/gh' };
  expect(resolveRuntimeConfig(settings, env)).toEqual({
    orcaBinPath: '/custom/orca',
    ghBinPath: '/custom/gh',
    warnings: [],
    orcaEnv: { HOME: env.HOME },
    gitFetchEnv: { HOME: env.HOME, GH_CONFIG_DIR: '/gh' },
  });
});
