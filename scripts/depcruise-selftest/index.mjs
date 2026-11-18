import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import config from '../../.dependency-cruiser.cjs';

const root = resolve(import.meta.dirname, '../..');
const temporary = await mkdtemp(join(tmpdir(), 'ai-office-depcruise-'));
try {
  await cp(join(import.meta.dirname, 'samples'), temporary, {
    recursive: true,
  });
  for (const file of [
    '.dependency-cruiser.cjs',
    'tsconfig.base.json',
    'tsconfig.depcruise.json',
  ]) {
    await cp(join(root, file), join(temporary, file));
  }
  // Minimal npm packages let the real resolver classify imports without executing
  // hostile samples or depending on which adapter dependencies are installed yet.
  const packages = [
    'zod',
    'smol-toml',
    'fastify-type-provider-zod',
    'fastify',
    '@fastify/cors',
    'octokit',
    '@octokit/core',
    'better-sqlite3',
    'execa',
    'pino',
    'yaml',
    'react',
    'react-dom',
    'zustand',
    '@playwright/test',
    '@axe-core/playwright',
  ];
  for (const name of packages) {
    const dir = join(temporary, 'node_modules', name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name,
        type: 'module',
        exports: {
          '.': './index.js',
          './jsx-runtime': './index.js',
          './vanilla': './index.js',
        },
      }),
    );
    await writeFile(join(dir, 'index.js'), 'export const value = 1;\n');
  }
  await writeFile(
    join(temporary, 'package.json'),
    JSON.stringify({
      type: 'module',
      dependencies: Object.fromEntries(packages.map((name) => [name, '*'])),
    }),
  );
  const executable = new URL(
    '../../bin/dependency-cruiser.mjs',
    import.meta.resolve('dependency-cruiser'),
  ).pathname;
  const result = spawnSync(
    process.execPath,
    [
      executable,
      '--config',
      '.dependency-cruiser.cjs',
      '--output-type',
      'json',
      'apps',
      'packages',
    ],
    { cwd: temporary, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `JSON cruise failed: ${result.stderr}`);
  assert(result.stdout.trim(), `No JSON report: ${result.stderr}`);
  // JSON is a reporting format and exits zero even with violations. The root
  // command uses the error reporter; prove that it returns a failing exit code.
  const validation = spawnSync(
    process.execPath,
    [
      executable,
      '--config',
      '.dependency-cruiser.cjs',
      '--output-type',
      'err',
      'apps',
      'packages',
    ],
    { cwd: temporary, encoding: 'utf8' },
  );
  assert(
    validation.status !== null && validation.status > 0,
    'Error reporter must fail on violations',
  );
  /** @type {import('dependency-cruiser').ICruiseResult} */
  const report = JSON.parse(result.stdout);
  /** @type {{ file: string, rules: string[] }[]} */
  const cases = JSON.parse(
    await readFile(join(import.meta.dirname, 'cases.json'), 'utf8'),
  );
  const covered = new Set();
  for (const { file, rules } of cases) {
    const actual = report.summary.violations
      .filter((violation) => violation.from === file)
      .map((violation) => violation.rule.name);
    if (rules.length === 0)
      assert.deepEqual(actual, [], `Allowed sample rejected: ${file}`);
    for (const name of rules) {
      assert(
        actual.includes(name),
        `${file}: missing ${name}; got ${actual.join(', ')}`,
      );
      covered.add(name);
    }
    if (!rules.includes('not-to-unresolvable'))
      assert(
        !actual.includes('not-to-unresolvable'),
        `Resolution failed for ${file}`,
      );
  }
  for (const rule of config.forbidden)
    assert(covered.has(rule.name), `Rule has no negative sample: ${rule.name}`);
  console.log(
    `Dependency self-test OK (${cases.length} cases; all ${covered.size} rules detected).`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
