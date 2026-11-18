import { it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { realOrcaSuite } from '../../test-support/orca/gating.js';
import { runHarnessCli } from '../../test-support/orca/runner.js';
const scenario = (name: string) =>
  fileURLToPath(new URL(`../../test-support/orca/${name}.ts`, import.meta.url));
// M2-T16. P2b (Orca restart in the full flow) is skipped by owner decision;
// P2a covered the app-restart case. P3 is the `pnpm orca:recheck` procedure.
realOrcaSuite('M2-T16 live verification', { agents: true }, () => {
  it('P4: a worker run-use is rejected or detected, reported and reclaimed', async () => {
    await runHarnessCli(['record', 'p4', '--scenario', scenario('p4-run-use')]);
  }, 900_000);
  it('P5b: an Orca Codex worker keeps ORCA_* and passes the identity check', async () => {
    await runHarnessCli([
      'record',
      'p5b',
      '--scenario',
      scenario('p5b-codex-env'),
    ]);
  }, 900_000);
});
