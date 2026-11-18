import { it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { realOrcaSuite } from '../../test-support/orca/gating.js';
import { runHarnessCli } from '../../test-support/orca/runner.js';
const scenario = (name: string) =>
  fileURLToPath(new URL(`../../test-support/orca/${name}.ts`, import.meta.url));
realOrcaSuite('RuntimePort CLI contract probes', {}, () => {
  it('replays run creation, rejects mismatch, times out check and restores an owned shim', async () => {
    await runHarnessCli([
      'record',
      'contract',
      '--scenario',
      scenario('contract-live-cli'),
    ]);
  }, 180_000);
});
realOrcaSuite('RuntimePort agent contract probes', { agents: true }, () => {
  it('checks spawn replay / kept-open follow-up and records spawn-in-flight', async () => {
    await runHarnessCli([
      'record',
      'contract-agents',
      '--scenario',
      scenario('contract-live-agents'),
    ]);
  }, 2_100_000);
});
