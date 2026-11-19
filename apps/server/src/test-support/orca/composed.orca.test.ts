import { it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { realOrcaSuite } from './gating.js';
import { runHarnessCli } from './runner.js';

realOrcaSuite('Composed backend harness lifecycle', {}, () => {
  it('starts --dev --runtime orca on the approved folder, shuts down and cleans its ledger', async () => {
    await runHarnessCli([
      'record',
      'composed',
      '--scenario',
      fileURLToPath(new URL('./composed-live.ts', import.meta.url)),
    ]);
  }, 180_000);
});
