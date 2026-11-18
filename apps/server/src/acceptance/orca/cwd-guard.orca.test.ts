import { it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { realOrcaSuite } from '../../test-support/orca/gating.js';
import { runHarnessCli } from '../../test-support/orca/runner.js';

/*
 * M2-T17 (integrator only, serial: --maxWorkers=1, under caffeinate -i).
 * CLI-only (no agents). The runner cleans the ledger (including
 * the claimed workflow namespace) and asserts ledger 0 and scan 0.
 */
realOrcaSuite('M2-T17 cwd guard', {}, () => {
  it('refuses a backend whose CLI cwd is inside an Orca worktree and cleans to ledger 0 / scan 0', async () => {
    await runHarnessCli([
      'record',
      't17-cwd-guard',
      '--scenario',
      fileURLToPath(
        new URL(
          '../../test-support/orca/t17/cwd-guard-scenario.ts',
          import.meta.url,
        ),
      ),
    ]);
  }, 180_000);
});
