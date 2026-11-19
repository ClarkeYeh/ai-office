export type { FixtureEvent } from './normalize.d.mts';
export type { TextScanner } from './scan-events.d.mts';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const mode = process.argv.slice(2).filter((arg) => arg !== '--');
if (mode.length !== 1 || !['--record', '--check'].includes(mode[0]!))
  throw new Error('Use pnpm fixtures:web --record or --check');
const root = resolve(import.meta.dirname, '../..');
const result = spawnSync(
  process.execPath,
  [
    resolve(root, 'node_modules/vitest/vitest.mjs'),
    'run',
    'apps/server/src/adapters/runtime-fake/scenarios/record.test.ts',
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, AIO_WEB_FIXTURES: mode[0] },
  },
);
process.exitCode = result.status ?? 1;
