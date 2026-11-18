import { it } from 'vitest';
import { realOrcaSuite } from './gating.js';
import { runHarnessCli } from './runner.js';

realOrcaSuite('CLI-only harness lifecycle', {}, () => {
  it('creates a shim, run and worktree, then cleans its resource ledger', async () => {
    await runHarnessCli(['record', 'smoke']);
  }, 180_000);
});
