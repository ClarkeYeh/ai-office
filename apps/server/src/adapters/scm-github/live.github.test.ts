import { assembleContractScm } from './test-support/assembly.js';
import { realGithubSuite } from '../../test-support/github/gating.js';
import { githubContract } from '../../test-support/github/contract-binding.js';
realGithubSuite('live ScmPort binding', () =>
  githubContract('live', assembleContractScm),
);

import { it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { openHarness, assertClean } from '../../test-support/github/harness.js';
import { RecordingFetch } from '../../test-support/github/recording.js';
import { encodedRefScenario } from '../../test-support/github/ref-paths.js';
import { tapePath } from '../../test-support/github/contract-binding.js';
realGithubSuite('live recording probes', () => {
  it('verifies percent-encoded git/ref and git/refs paths', async () => {
    const harness = await openHarness();
    try {
      const startedAt = new Date().toISOString();
      const recorder = new RecordingFetch(
        harness.fetch,
        harness.ledger.data.runId,
      );
      try {
        await encodedRefScenario(
          recorder.fetch,
          harness.ledger.data.runId,
          startedAt,
          assembleContractScm,
        );
      } finally {
        // Cleanup and scan must succeed before publishing evidence.
        const result = await harness.cleanup();
        assertClean(result);
        console.info(
          JSON.stringify({
            case: 'encoded refs',
            ...result,
            calls: harness.gate.calls,
          }),
        );
      }
      expect(
        recorder.recordings.some(
          (r) => r.method === 'DELETE' && r.path.includes('ai-office%2F'),
        ),
      ).toBe(true);
      if (process.env.AIO_GITHUB_RECORD === '1') {
        const path = tapePath('encoded refs');
        await mkdir(dirname(path), { recursive: true });
        await recorder.save(path);
        await writeFile(path + '.clock.json', JSON.stringify({ startedAt }), {
          flag: 'wx',
          mode: 0o600,
        });
      }
    } finally {
      await harness.close();
    }
  }, 60_000);
  it.skip('Base branch was modified (405/409): pending safe reproducible POST /merges race; do not revive PUT /pulls/{n}/merge', () => {});
  it.skip('405 rules-blocked wording: pending a permitted unprotected test base with existing blocking rules; never change rulesets', () => {});
});
