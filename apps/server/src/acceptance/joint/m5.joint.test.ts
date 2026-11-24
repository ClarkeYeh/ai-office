import { it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { realGithubSuite } from '../../test-support/github/gating.js';
import { realOrcaSkipReason } from '../../test-support/orca/gating.js';
import { runHarnessCli } from '../../test-support/orca/runner.js';

/*
 * M5-T12 joint run (M5_PLAN §5 T12, harness by T7): production `ai-office
 * start` on an isolated home, real Orca and agents, real GitHub on
 * ClarkeYeh/ai-office-spike, exactly one backend `kill -9` (K or K′) with a
 * same-home same-port restart, and the owner's hand merge of the final PR
 * (W2). Run only through `pnpm test:joint` (all three live flags, CI unset)
 * after `pnpm -r build`, with AIO_TEST_REPO_PATH (the spike clone),
 * AIO_ORCA_BIN, and absolute AIO_JOINT_STATUS, AIO_JOINT_REPORT and
 * AIO_JOINT_PRIVATE_DIR (outside the repo). The scenario holds both live
 * locks; the Orca runner cleans its ledger and asserts ledger 0 / scan 0.
 */
realGithubSuite('M5 joint run (production, live spike + Orca + agents)', () => {
  const orcaSkip = realOrcaSkipReason({ agents: true });
  it.skipIf(orcaSkip !== undefined)(
    `runs m5-mainline with one restart up to the owner's merge${orcaSkip ? ` (skipped: ${orcaSkip})` : ''}`,
    async () => {
      process.env.AIO_JOINT_MODE = 'production';
      await runHarnessCli([
        'record',
        'm5-joint',
        '--scenario',
        fileURLToPath(
          new URL('../../test-support/joint/run.ts', import.meta.url),
        ),
      ]);
    },
    // Up to the owner's merge window (AIO_JOINT_OWNER_WAIT_MIN, default 12 h).
    14 * 60 * 60_000,
  );
});
