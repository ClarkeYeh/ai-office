import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('joint command requires all three flags and rejects CI', () => {
  const gate = pkg.scripts['test:joint'].split(' && ')[0];
  for (let mask = 0; mask < 8; mask++) {
    const env = { ...process.env };
    delete env.CI;
    ['AIO_REAL_GITHUB', 'AIO_REAL_ORCA', 'AIO_REAL_AGENTS'].forEach(
      (key, i) => {
        env[key] = mask & (1 << i) ? '1' : '0';
      },
    );
    assert.equal(
      spawnSync(gate, { shell: true, env }).status,
      mask === 7 ? 0 : 1,
    );
    env.CI = '';
    assert.equal(spawnSync(gate, { shell: true, env }).status, 1);
  }
});

test('joint tests are excluded by the default command and selected by GitHub project', () => {
  const file = join(
    root,
    'apps/server/src/test-support/joint/export/selection.joint.test.ts',
  );
  try {
    writeFileSync(
      file,
      "import {test} from 'vitest'; test('selection sentinel', () => {});\n",
      { flag: 'wx' },
    );
    const run = (/** @type {string} */ project) =>
      spawnSync(
        process.execPath,
        [
          join(root, 'node_modules/vitest/vitest.mjs'),
          'list',
          'selection.joint.test.ts',
          '--project',
          project,
          '--json',
        ],
        { cwd: root, encoding: 'utf8' },
      );
    const ordinary = run('!@ai-office/server-*');
    assert.equal(ordinary.status, 0, ordinary.stderr);
    assert.equal(ordinary.stdout.includes('selection sentinel'), false);
    const github = run('@ai-office/server-github');
    assert.equal(github.status, 0, github.stderr);
    assert.equal(github.stdout.includes('selection sentinel'), true);
  } finally {
    rmSync(file, { force: true });
  }
});

for (const [name, value, accepted] of [
  ['short', 'A short sentence.', true],
  [
    'event',
    {
      type: 'message.question',
      payload: { body: '‹text len=1000 sha=012345abcdef›', inputTokens: 42 },
    },
    true,
  ],
  ['control', 'aio_ctl_synthetic_secret', false],
  ['placeholder', '‹text len=1000 sha=012345abcdef›', true],
  ['sha', 'a'.repeat(100), true],
  ['prose', 'Private natural language. '.repeat(5), false],
  ['unicode', '文'.repeat(81), false],
  ['nested', { data: [{ body: 'Natural language '.repeat(10) }] }, false],
]) {
  test(`M5 scan: ${name}`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'aio-m5-scan-'));
    try {
      mkdirSync(join(directory, 'fixtures/m5'), { recursive: true });
      writeFileSync(
        join(directory, 'fixtures/m5/sample.json'),
        JSON.stringify({ value }),
      );
      const result = spawnSync(
        process.execPath,
        [join(root, 'scripts/fixtures/scan.ts')],
        { cwd: directory, encoding: 'utf8' },
      );
      assert.equal(result.status, accepted ? 0 : 1, result.stderr);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
