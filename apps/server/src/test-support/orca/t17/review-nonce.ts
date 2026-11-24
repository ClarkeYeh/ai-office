/**
 * M5-T8 (§2.2.3, §28 item 4): the PR-number nonce and the reviewer-scope
 * fallback shared by the M2 implement scenario and the joint `m5-mainline`
 * scenario. Kept here so test-support/joint imports orca, never the reverse.
 */
export const PENDING_LINE = 'Reviewed in PR #pending';
export const reviewedLine = (pr: number): string => `Reviewed in PR #${pr}`;

/** The last non-empty line of a README, or `undefined` for an empty file. */
export const lastLine = (text: string): string | undefined =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);

/** T10/T11b: the nonce verdict for one README head (§2.2.3 judgement). */
export function nonceState(
  readme: string,
  pr: number,
): 'pending' | 'correct' | 'other' {
  const line = lastLine(readme);
  if (line === PENDING_LINE) return 'pending';
  return line === reviewedLine(pr) ? 'correct' : 'other';
}

/** Reviewer-only rule appended to `roles.integrator.scope`; workers never see it. */
export const INTEGRATOR_SCOPE_FALLBACK =
  "When an acceptance criterion requires content that only the work item's worker may write, send the pull request back with rework-request stating what must change; never edit that content yourself.";
