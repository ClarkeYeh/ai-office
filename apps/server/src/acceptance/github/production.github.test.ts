import { it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { realGithubSuite } from '../../test-support/github/gating.js';
import { realOrcaSkipReason } from '../../test-support/orca/gating.js';
import { runHarnessCli } from '../../test-support/orca/runner.js';

/*
 * M3-T16 production startup acceptance and refusal matrix (M3_PLAN §6), live
 * on ClarkeYeh/ai-office-spike (reads only) and the real Orca (shim in the
 * owner-approved ~/.ai-office/orca-home). Serial, after `pnpm -r build`, with
 * AIO_REAL_GITHUB=1, AIO_REAL_ORCA=1, AIO_TEST_REPO_PATH (the spike clone)
 * and AIO_ORCA_BIN. The scenario (production-smoke.ts) holds the GitHub live
 * lock; the Orca runner cleans its ledger and asserts ledger 0 / scan 0.
 */
realGithubSuite('M3-T16 production startup (live spike + Orca)', () => {
  const orcaSkip = realOrcaSkipReason({});
  it.skipIf(orcaSkip !== undefined)(
    `starts production, refuses the matrix and cleans to zero${orcaSkip ? ` (skipped: ${orcaSkip})` : ''}`,
    async () => {
      await runHarnessCli([
        'record',
        't16-production',
        '--scenario',
        fileURLToPath(
          new URL(
            '../../test-support/github/production-smoke.ts',
            import.meta.url,
          ),
        ),
      ]);
    },
    30 * 60_000,
  );
});
