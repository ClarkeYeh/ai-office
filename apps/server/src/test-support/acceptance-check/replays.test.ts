import { afterEach, describe, expect, it } from 'vitest';
import { fakeBinding } from '../../acceptance/github/test-support/fake-binding.js';
import {
  mixedOffice,
  type MixedOffice,
} from '../../acceptance/github/test-support/mixed-office.js';
import { runMixedMainline } from '../../acceptance/github/test-support/scenario.js';
import {
  closeAll,
  isEnded,
  office,
} from '../../acceptance/test-support/harness.js';
import type { Json } from '../../acceptance/test-support/harness.js';
import { exportJointEvents } from '../joint/export/index.js';
import { checkAcceptance, type AcceptanceReport } from './index.js';

/*
 * M5_PLAN §5 T10: run the checker on the M1 mainline golden and the M3 mixed
 * acceptance replay (both composed, fake world), raw and B4-masked. Neither
 * scenario was built for the full §24 list, so the expected ❌ rows document
 * what each one does not exercise; T9's m5-mainline must be all ✅.
 */

let mixed: MixedOffice | undefined;
afterEach(async () => {
  await closeAll();
  await mixed?.close();
  mixed = undefined;
});

const verdicts = (report: AcceptanceReport) =>
  Object.fromEntries(report.rows.map((r) => [r.id, r.verdict]));
function expectMaskedParity(events: Json[]) {
  const masked = exportJointEvents(events, {
    exportedAt: '2026-11-24T00:00:00.000Z',
    aiOfficeCommit: 'a'.repeat(40),
    orcaVersion: '1.4.272',
  }).events;
  expect(checkAcceptance(masked as Json[])).toEqual(checkAcceptance(events));
}
const COMMON = {
  'nf.latency': 'pass',
  'nf.cpu': 'na',
  'nf.fps': 'na',
  'nf.reliability': 'pass',
  'nf.masking': 'pass',
  'nf.auth': 'na',
  'nf.merge-default-branch': 'pass',
  'nf.approve-comment': 'na',
  'nf.stage-gate-agents': 'pass',
  'nf.boundaries': 'na',
  'nf.coverage': 'na',
  'v01.base-sha': 'pass',
  'v01.integration-branch': 'pass',
  'v01.worker-list': 'na',
  'v01.replay': 'pass',
  // Fake usage is not wired into either scenario; neither forces a conflict.
  'v01.usage': 'fail',
  'v01.conflict': 'fail',
  'x.no-duplicates': 'pass',
  'x.engine-replay': 'na',
};

describe(
  '§24 checker on recorded acceptance flows',
  { timeout: 300_000 },
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

    it('M3 mixed acceptance replay: on-call, rework and waiting_input; the final PR stays unmerged', async () => {
      mixed = await mixedOffice(fakeBinding());
      const { events } = await runMixedMainline(mixed);
      expect(verdicts(checkAcceptance(events))).toEqual({
        ...COMMON,
        // Step 11 closes and reopens the final PR; nothing merges into main.
        'v01.gates': 'fail',
        'v01.oncall': 'pass',
        'v01.rework': 'pass',
        'v01.waiting-input': 'pass',
      });
      expectMaskedParity(events);
    });
  },
);
