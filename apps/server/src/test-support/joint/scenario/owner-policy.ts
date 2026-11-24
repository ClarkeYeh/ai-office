/**
 * M5-T8 scripted owner policy (M5_PLAN §2.2.4): the only decisions the joint
 * harness takes on the owner's behalf. T7 executes it; anything this table
 * does not cover goes to the private status file for the coordinator or the
 * owner. The final-PR gate is never decided here.
 */
import { CODE_NAME, ESCALATION_KEY } from './m5-mainline.js';

/** Escalated code-name question: held until restart-ready or 10 minutes. */
export const ESCALATION_HOLD_MAX_MS = 10 * 60_000;

/**
 * Exception gates the harness may decide, by `exceptionKind` (option ids from
 * domain `EXCEPTION_OPTIONS` and the merge queue). Each fires at most `limit`
 * times per run; a second occurrence is handed off.
 * - `merge-blocked`: the merge queue's `decision-request` (for example
 *   `unresolvable-conflict`); `retry` re-dispatches the item from the latest
 *   integration branch.
 * - `rework-limit`: one more rework round.
 * - `spawn-stall`: a new attempt.
 */
export const AUTO_EXCEPTIONS = {
  'merge-blocked': { optionId: 'retry', limit: 1 },
  'rework-limit': { optionId: 'rework', limit: 1 },
  'spawn-stall': { optionId: 'retry', limit: 1 },
} as const;

export type OwnerAction =
  | { type: 'approve-conclusion'; ownerApproveComment: true }
  | { type: 'approve-split' }
  | { type: 'revise-split' }
  | {
      type: 'hold-answer';
      answer: string;
      until: 'restart-ready';
      maxMs: number;
    }
  | { type: 'option'; optionId: string }
  | { type: 'await-owner-merge' }
  | { type: 'hand-off'; reason: string };

/** The facts about one open gate that the policy reads. */
export interface PolicyGate {
  kind: 'stage' | 'exception';
  stageKind?: string;
  exceptionKind?: string;
  itemKey?: string;
}

/**
 * The §2.2.4 table as a pure lookup. `seen` counts earlier auto decisions of
 * the same exception kind in this run; `splitMatches` is the result of
 * `splitMatches(proposal, tag)`.
 */
export function ownerAction(
  gate: PolicyGate,
  context: { seen: number; splitMatches?: boolean },
): OwnerAction {
  if (gate.kind === 'stage') {
    switch (gate.stageKind) {
      case 'meeting':
        // Approve with the shown githubBodyHash; also post an owner `/approve`
        // comment and assert it changes nothing (§24 safety).
        return { type: 'approve-conclusion', ownerApproveComment: true };
      case 'planning':
        return context.splitMatches
          ? { type: 'approve-split' }
          : { type: 'revise-split' };
      case 'final-pr':
        return { type: 'await-owner-merge' };
      default:
        return { type: 'hand-off', reason: `stage gate ${gate.stageKind}` };
    }
  }
  if (gate.exceptionKind === 'question-escalation') {
    return gate.itemKey === ESCALATION_KEY && context.seen === 0
      ? {
          type: 'hold-answer',
          answer: CODE_NAME,
          until: 'restart-ready',
          maxMs: ESCALATION_HOLD_MAX_MS,
        }
      : { type: 'hand-off', reason: 'unexpected escalated question' };
  }
  const auto =
    AUTO_EXCEPTIONS[gate.exceptionKind as keyof typeof AUTO_EXCEPTIONS];
  if (auto && context.seen < auto.limit)
    return { type: 'option', optionId: auto.optionId };
  return {
    type: 'hand-off',
    reason: auto
      ? `${gate.exceptionKind} repeated`
      : `exception ${gate.exceptionKind ?? 'unknown'}`,
  };
}

/**
 * When a held answer is released: the restarted backend is ready (new pid in
 * `runtime.json` and the startup reconcile finished) or the hold timed out,
 * whichever comes first. A hold that opens after the restart releases at once.
 */
export function releaseHeldAnswer(input: {
  gateOpenedAt: number;
  now: number;
  restartReadyAt?: number;
}): boolean {
  if (input.restartReadyAt !== undefined && input.restartReadyAt <= input.now)
    return true;
  return input.now - input.gateOpenedAt >= ESCALATION_HOLD_MAX_MS;
}
