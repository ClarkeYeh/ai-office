import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [command, ...args] = process.argv.slice(2);
if (
  !['test', 'e2e', 'record', 'record-contract', 'janitor'].includes(
    command ?? '',
  )
) {
  console.error('Expected test, e2e, record, record-contract, or janitor');
  process.exitCode = 1;
} else if (
  process.env.CI !== undefined ||
  process.env.AIO_REAL_GITHUB !== '1'
) {
  console.info(
    '[real GitHub] skipped (requires AIO_REAL_GITHUB=1 and CI unset)',
  );
} else if (command === 'record' || command === 'janitor') {
  try {
    const { runHarnessCli } =
      await import('../../apps/server/dist/test-support/github/runner.js');
    await runHarnessCli([command, ...args]);
  } catch {
    console.error(
      'GitHub harness refused or failed; build the server and inspect its README and private ledger',
    );
    process.exitCode = 1;
  }
} else if (args.length !== 0) {
  // Do not allow CLI overrides to select other projects or execute arbitrary files.
  console.error('GitHub test commands do not accept additional arguments');
  process.exitCode = 1;
} else {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('../../node_modules/vitest/vitest.mjs', import.meta.url),
      ),
      'run',
      '--project',
      '@ai-office/server-github',
      '--maxWorkers=2',
      '--hookTimeout=120000',
      '--passWithNoTests',
      ...(command === 'record-contract'
        ? ['apps/server/src/adapters/scm-github/live.github.test.ts']
        : command === 'e2e'
          ? ['apps/server/src/acceptance/github/']
          : ['--exclude', '**/acceptance/github/**']),
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        ...(command === 'record-contract' ? { AIO_GITHUB_RECORD: '1' } : {}),
      },
    },
  );
  process.exitCode = result.status ?? 1;
}
