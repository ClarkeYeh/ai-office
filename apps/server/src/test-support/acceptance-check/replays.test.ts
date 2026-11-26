import { afterEach, describe, expect, it } from 'vitest';
import {
  closeAll,
  isEnded,
  office,
} from '../../acceptance/test-support/harness.js';
import { checkAcceptance } from './index.js';
import { COMMON, verdicts, expectMaskedParity } from './replay-assertions.js';

/*
 * M5_PLAN §5 T10: run the checker on the M1 mainline golden and the M3 mixed
 * acceptance replay (both composed, fake world), raw and B4-masked. The M3
 * checker assertion lives beside its mainline test to share that run's events.
 * Neither scenario was built for the full §24 list, so the expected ❌ rows document
 * what each one does not exercise; T9's m5-mainline must be all ✅.
 */

afterEach(async () => {
  await closeAll();
});

describe(
  '§24 checker on recorded acceptance flows',
  { timeout: 30_000 },
  () => {
    it('M1 mainline golden: completes through both gates, no on-call, rework or waiting_input', async () => {
      const o = await office();
      const workflowId = await o.start();
      await o.drive(workflowId, isEnded);
      await new Promise((resolve) => setTimeout(resolve, 600));
      const events = await o.events(workflowId);
      expect(verdicts(checkAcceptance(events))).toEqual({
        ...COMMON,
        'v01.gates': 'pass',
        'v01.oncall': 'fail',
        'v01.rework': 'fail',
        'v01.waiting-input': 'fail',
      });
      expectMaskedParity(events);
    });
  },
);
