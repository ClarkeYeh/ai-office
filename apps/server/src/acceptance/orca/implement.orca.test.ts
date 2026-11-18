import { it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { realOrcaSuite } from '../../test-support/orca/gating.js';
import { runHarnessCli } from '../../test-support/orca/runner.js';

/*
 * M2-T17 (integrator only, serial: --maxWorkers=1, under caffeinate -i).
 * Real agents: AIO_REAL_AGENTS=1. The runner cleans the ledger (including
 * the claimed workflow namespace) and asserts ledger 0 and scan 0.
 */
realOrcaSuite('M2-T17 implement', { agents: true }, () => {
  it(
    'runs the implement acceptance scenario and cleans to ledger 0 / scan 0',
    async () => {
      await runHarnessCli([
        'record',
        't17-implement',
        '--scenario',
        fileURLToPath(
          new URL(
            '../../test-support/orca/t17/implement-scenario.ts',
            import.meta.url,
          ),
        ),
      ]);
    },
    4 * 60 * 60_000,
  );
});
