import { it, expect } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assembleContractScm } from './test-support/assembly.js';
import { realGithubSuite } from '../../test-support/github/gating.js';
import { openGate } from '../../test-support/github/gate.js';
import { RecordingFetch } from '../../test-support/github/recording.js';
import {
  expectedObservation,
  externalMergeScenario,
  externalMergeTape,
  externalMergeTransport,
} from '../../test-support/github/external-merge.js';

// GA level: GET only, no ledger and no cleanup because nothing is created.
realGithubSuite('live external merge observation', () => {
  it('observes the owner hand-merge of spike PR #144 (read-only)', async () => {
    const gate = await openGate();
    try {
      const recorder = new RecordingFetch(externalMergeTransport(gate.fetch));
      const observed = await externalMergeScenario(
        recorder.fetch,
        assembleContractScm,
      );
      expect(gate.calls.every((call) => call.startsWith('GET '))).toBe(true);
      expect(observed).toMatchObject(expectedObservation());
      if (process.env.AIO_GITHUB_RECORD === '1') {
        await mkdir(dirname(externalMergeTape), { recursive: true });
        await recorder.save(externalMergeTape);
      }
    } finally {
      await gate.close();
    }
  }, 60_000);
});
