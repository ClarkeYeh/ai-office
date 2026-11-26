import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { z } from 'zod';

const positive = z.number().int().positive();
export const GithubLoginSchema = z
  .string()
  .max(39)
  .regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/);
const binaryPath = (name: string) =>
  z
    .string()
    .refine(
      (value) =>
        value === '' ||
        value === name ||
        (value.startsWith('/') && !value.includes('\0')),
      'Expected an absolute binary path',
    );
export const SettingsSchema = z.strictObject({
  server: z
    .strictObject({ port: positive.max(65535).default(4319) })
    .prefault({}),
  orca: z
    .strictObject({
      bin: binaryPath('orca').default('orca'),
      homeDir: z
        .string()
        .refine(
          (value) =>
            value === '' || (value.startsWith('/') && !value.includes('\0')),
          'Expected an absolute path',
        )
        .default(''),
      supportedRange: z.string().min(1).default('>=1.4.259 <1.5'),
      shimLocation: z
        .enum(['folder-workspace', 'repo-main-worktree'])
        .default('folder-workspace'),
      shim: z
        .strictObject({ closeOnExit: z.boolean().default(false) })
        .prefault({}),
      cliConcurrency: positive.default(4),
      maxCallsPerMinute: positive.default(120),
      preventSleep: z.boolean().default(true),
    })
    .prefault({}),
  engine: z
    .strictObject({ spawnStallMs: positive.default(600000) })
    .prefault({}),
  budget: z
    .strictObject({ enforcement: z.enum(['on', 'off']).default('on') })
    .prefault({}),
  usage: z
    .strictObject({
      claudeConfigDirs: z.array(z.string().min(1)).default([]),
      codexHomes: z.array(z.string().min(1)).default([]),
      budgetFormula: z
        .string()
        .min(1)
        .default('inputUncached + output + cacheWrite'),
    })
    .prefault({}),
  github: z
    .strictObject({
      tokenSource: z.enum(['auto', 'env', 'gh']).default('auto'),
      ghBin: binaryPath('gh').default(''),
      expectedLogin: z.union([z.literal(''), GithubLoginSchema]).default(''),
    })
    .prefault({}),
  env: z
    .strictObject({
      passthrough: z
        .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
        .default(['GH_CONFIG_DIR', 'XDG_CONFIG_HOME']),
    })
    .prefault({}),
  limits: z.strictObject({ globalAgents: positive.default(10) }).prefault({}),
  retention: z
    .strictObject({
      workerBranches: z
        .enum(['delete-on-complete', 'keep'])
        .default('delete-on-complete'),
    })
    .prefault({}),
});
export type Settings = z.infer<typeof SettingsSchema>;

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const directory =
    env.AI_OFFICE_HOME || (env.HOME ? `${env.HOME}/.ai-office` : undefined);
  if (!directory || !directory.startsWith('/'))
    throw new Error('AI_OFFICE_HOME or HOME must be an absolute path');
  return directory.replace(/\/+$/, '') || '/';
}

export function createDataDirectories(dataDir: string): void {
  for (const subdir of [
    '',
    '/templates',
    '/data',
    '/data/specs',
    '/logs',
    '/cli-cwd',
    ...(readSettings(dataDir).orca.homeDir === '' ? ['/orca-home'] : []),
  ]) {
    mkdirSync(`${dataDir}${subdir}`, { recursive: true, mode: 0o700 });
  }
  chmodSync(`${dataDir}/data/specs`, 0o700);
}

export function readSettings(dataDir: string): Settings {
  let source: string;
  try {
    source = readFileSync(`${dataDir}/config.toml`, 'utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return SettingsSchema.parse({});
    throw new Error('Cannot read config.toml', { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = parse(source);
  } catch {
    throw new Error('Invalid config.toml: TOML syntax error');
  }
  const result = SettingsSchema.safeParse(parsed);
  if (!result.success) {
    // Never echo values or parser errors: configuration may accidentally contain secrets.
    throw new Error(
      `Invalid config.toml fields: ${result.error.issues.map((issue) => issue.path.join('.') || '<root>').join(', ')}`,
    );
  }
  return result.data;
}

export function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
