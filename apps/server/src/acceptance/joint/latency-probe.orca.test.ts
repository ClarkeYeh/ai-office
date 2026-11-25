import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { realOrcaSuite } from '../../test-support/orca/gating.js';
import { runHarnessCli } from '../../test-support/orca/runner.js';

/*
 * FX-STATUS-LATENCY live probe (Orca only, no GitHub object, no merge): two
 * real agents (Claude + Codex) take a few tiny turns in a scratch worktree on
 * the approved Orca home; the report holds the SPEC §24 state and message
 * latency, CLI calls/min and the peak orca process count. LIVE ONLY, after
 * the coordinator's GO, under `caffeinate -i -s`, with Node 24 and
 * `pnpm -r build` first:
 *
 *   AIO_REAL_ORCA=1 AIO_REAL_AGENTS=1 AIO_TEST_REPO_PATH=<spike clone>
 *   AIO_ORCA_BIN=<orca> AIO_PROBE_DIR=<private dir>
 *   pnpm test:orca:agents latency-probe.orca.test.ts
 *
 * The scenario holds the Orca live lock; the runner cleans the ledger and
 * asserts janitor 0 / scan 0.
 */
realOrcaSuite('FX-STATUS-LATENCY live probe', { agents: true }, () => {
  it(
    'measures state and message latency with two real agents',
    async () => {
      await runHarnessCli([
        'record',
        'm5-latency-probe',
        '--scenario',
        fileURLToPath(
          new URL(
            '../../test-support/joint/latency-probe/scenario.ts',
            import.meta.url,
          ),
        ),
      ]);
    },
    30 * 60_000,
  );
});
