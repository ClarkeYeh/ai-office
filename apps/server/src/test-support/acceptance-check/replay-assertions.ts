import { expect } from 'vitest';
import type { Json } from '../../acceptance/test-support/harness.js';
import { exportJointEvents } from '../joint/export/index.js';
import { checkAcceptance, type AcceptanceReport } from './index.js';

export const verdicts = (report: AcceptanceReport) =>
  Object.fromEntries(report.rows.map((r) => [r.id, r.verdict]));
export function expectMaskedParity(events: Json[]) {
  const masked = exportJointEvents(events, {
    exportedAt: '2026-11-24T00:00:00.000Z',
    aiOfficeCommit: 'a'.repeat(40),
    orcaVersion: '1.4.272',
  }).events;
  expect(checkAcceptance(masked as Json[])).toEqual(checkAcceptance(events));
}
export const COMMON = {
  'nf.latency': 'pass',
  // The fake mainline emits no transcript output.
  'nf.activity-latency': 'na',
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

export function expectM3Replay(events: Json[]) {
  expect(verdicts(checkAcceptance(events))).toEqual({
    ...COMMON,
    // Step 11 closes and reopens the final PR; nothing merges into main.
    'v01.gates': 'fail',
    'v01.oncall': 'pass',
    'v01.rework': 'pass',
    'v01.waiting-input': 'pass',
  });
  expectMaskedParity(events);
}
