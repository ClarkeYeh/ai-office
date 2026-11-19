import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [command, ...args] = process.argv.slice(2);
if (command === 'record' || command === 'janitor') {
  console.error('not available until M3-T7');
  process.exitCode = 1;
} else if (command !== 'test' && command !== 'e2e') {
  console.error('Expected test, e2e, record, or janitor');
  process.exitCode = 1;
} else if (
  process.env.CI !== undefined ||
  process.env.AIO_REAL_GITHUB !== '1'
) {
  console.info(
    '[real GitHub] skipped (requires AIO_REAL_GITHUB=1 and CI unset)',
  );
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
      '--passWithNoTests',
      ...(command === 'e2e'
        ? ['apps/server/src/acceptance/github/']
        : ['--exclude', '**/acceptance/github/**']),
    ],
    { cwd: root, stdio: 'inherit' },
  );
  process.exitCode = result.status ?? 1;
}
