import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

/** @param {string} command @param {NodeJS.ProcessEnv} flags @param {string[]} args */
function run(command, flags = {}, args = []) {
  const env = { ...process.env, ...flags };
  if (flags.CI === undefined) delete env.CI;
  const result = spawnSync(
    process.execPath,
    [new URL('./run.mjs', import.meta.url).pathname, command, ...args],
    { env, encoding: 'utf8', timeout: 10_000 },
  );
  assert.ifError(result.error);
  return result;
}

test('record and janitor fail closed until T7, regardless of opt-in', () => {
  for (const command of ['record', 'janitor']) {
    const result = run(command, { AIO_REAL_GITHUB: '1' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not available until M3-T7/);
  }
});

test('live commands skip without opt-in or whenever CI is set', () => {
  for (const command of ['test', 'e2e']) {
    for (const flags of [
      { AIO_REAL_GITHUB: '' },
      { AIO_REAL_GITHUB: 'true' },
      { AIO_REAL_GITHUB: '1', CI: 'true' },
      { AIO_REAL_GITHUB: '1', CI: 'false' },
      { AIO_REAL_GITHUB: '1', CI: '' },
    ]) {
      const result = run(command, flags);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /skipped/);
    }
  }
});

test('unknown commands and project overrides are refused', () => {
  assert.equal(run('unknown').status, 1);
  for (const command of ['test', 'e2e']) {
    const result = run(command, { AIO_REAL_GITHUB: '1' }, ['--project', '*']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /do not accept additional arguments/);
  }
});

test('opted-in commands route only to the serialized GitHub project', async () => {
  const { mkdtemp, mkdir, copyFile, writeFile, rm } =
    await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'github-routing-'));
  try {
    await mkdir(join(root, 'scripts/github'), { recursive: true });
    await mkdir(join(root, 'node_modules/vitest'), { recursive: true });
    await copyFile(
      new URL('./run.mjs', import.meta.url),
      join(root, 'scripts/github/run.mjs'),
    );
    // Replace Vitest with an argument reporter: this test cannot collect live files.
    await writeFile(
      join(root, 'node_modules/vitest/vitest.mjs'),
      'console.log(JSON.stringify(process.argv.slice(2)));\n',
    );
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, AIO_REAL_GITHUB: '1' };
    delete env.CI;
    for (const command of ['test', 'e2e']) {
      const result = spawnSync(
        process.execPath,
        [join(root, 'scripts/github/run.mjs'), command],
        { env, encoding: 'utf8', timeout: 10_000 },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0);
      assert.deepEqual(JSON.parse(result.stdout), [
        'run',
        '--project',
        '@ai-office/server-github',
        '--maxWorkers=2',
        '--passWithNoTests',
        ...(command === 'e2e'
          ? ['apps/server/src/acceptance/github/']
          : ['--exclude', '**/acceptance/github/**']),
      ]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
