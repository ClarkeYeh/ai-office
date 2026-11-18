import { resolve } from 'node:path';
import { it } from 'vitest';
import { realOrcaSuite } from '../gating.js';
import { runHarnessCli } from '../runner.js';

realOrcaSuite('git-only SCM live smoke', {}, () => {
  it('merges a test branch and cleans the harness ledger', async () => {
    await runHarnessCli([
      'record',
      'scm-gitremote',
      '--scenario',
      resolve(import.meta.dirname, 'live-scenario.ts'),
    ]);
  }, 180_000);
});
