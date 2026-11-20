import { it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { realGithubSuite } from '../../test-support/github/gating.js';
import { realOrcaSkipReason } from '../../test-support/orca/gating.js';
import { runHarnessCli } from '../../test-support/orca/runner.js';

/*
 * M3-T17 real-agent smoke (M3_PLAN §6): production start, real Claude and
 * Codex on ClarkeYeh/ai-office-spike up to the final-PR gate, then the owner's
 * hand merge on GitHub (Q1; never merged here). Serial, after `pnpm -r build`,
 * under `caffeinate -i`, with AIO_REAL_GITHUB=1, AIO_REAL_ORCA=1,
 * AIO_REAL_AGENTS=1, AIO_TEST_REPO_PATH (the spike clone with the repo-local
 * noreply identity), AIO_ORCA_BIN, and the private owner hand-off files
 * AIO_T17_STATUS and AIO_T17_REPORT (smoke-scenario.ts). Both janitors run at
 * the end; the Orca runner asserts ledger 0 / scan 0.
 */
realGithubSuite('M3-T17 real-agent smoke (live spike + Orca + agents)', () => {
  const skip =
    realOrcaSkipReason({ agents: true }) ??
    (process.env.AIO_T17_STATUS && process.env.AIO_T17_REPORT
      ? undefined
      : 'requires AIO_T17_STATUS and AIO_T17_REPORT');
  it.skipIf(skip !== undefined)(
    `runs the mainline to the owner's merge and cleans to zero${skip ? ` (skipped: ${skip})` : ''}`,
    async () => {
      await runHarnessCli([
        'record',
        't17-smoke',
        '--scenario',
        fileURLToPath(
          new URL(
            '../../test-support/github/smoke-scenario.ts',
            import.meta.url,
          ),
        ),
      ]);
    },
    26 * 60 * 60_000,
  );
});
