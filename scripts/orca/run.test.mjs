import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHarnessCli } from './run.mjs';

test('all live harness entrypoints refuse CI before running Orca', async () => {
  for (const args of [
    ['record', 'smoke'],
    ['p2', 'prepare'],
    ['janitor', '--apply'],
    ['recheck'],
  ]) {
    await assert.rejects(
      runHarnessCli(args, { CI: '1', AIO_REAL_ORCA: '1' }),
      /outside CI/,
    );
  }
});
