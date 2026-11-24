/**
 * M5-T8 (§2.2.3, §28 item 4): the PR-number nonce and the reviewer-scope
 * fallback shared by the M2 implement scenario and the joint `m5-mainline`
 * scenario. The nonce helpers live with the `m5-mainline` data (M5-T9); this
 * module keeps test-support/joint importing orca, never the reverse.
 */
export {
  PENDING_LINE,
  reviewedLine,
  lastLine,
  nonceState,
} from '../../../adapters/runtime-fake/scenarios/m5-mainline-data.js';

/** Reviewer-only rule appended to `roles.integrator.scope`; workers never see it. */
export const INTEGRATOR_SCOPE_FALLBACK =
  "When an acceptance criterion requires content that only the work item's worker may write, send the pull request back with rework-request stating what must change; never edit that content yourself.";
