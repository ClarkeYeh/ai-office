import type { EventPayload } from '@ai-office/contracts/events';
import { isAttemptAlive, liveAttempts } from '@ai-office/domain';
import type { OpenGate, WorkflowState } from '@ai-office/domain';
import { stopAttempt } from '../agents.js';
import { commandId, metaFor } from '../context.js';
import type { ReactContext } from '../context.js';
import { external, internal } from '../effects.js';
import type { Effect } from '../effects.js';
import { cancelTimer, MINUTE_MS, schedule, timerId } from '../timers.js';

/**
 * §7.1 violation protocol: on a timeout or a missing submission engine sends
 * one nudge, waits a 5-minute grace, and if the stage module still finds the
 * submission missing it stops the attempt and opens an exception gate (§8.3).
 * The stage module owns the "is it still missing?" judgement: it calls
 * `sendNudge` on the trigger, `cancelNudge` when the submission arrives, and
 * `escalateNudge` when `firedTimer(ctx, 'nudge-grace')` matches its attempt.
 */
export const NUDGE_GRACE_MS = 5 * MINUTE_MS;

export type NudgeReason = EventPayload<'message.nudge'>['reason'];

export interface NudgeRequest {
  attemptId: string;
  reason: NudgeReason;
  subject: string;
  body: string;
}

export const nudgeCommandId = (
  workflowId: string,
  attemptId: string,
  reason: NudgeReason,
): string => commandId({ workflowId }, 'nudge', attemptId, reason);

/** One nudge per attempt and reason, whether recorded as a command or a `message.nudge`. */
export const hasNudged = (
  state: WorkflowState,
  workflowId: string,
  attemptId: string,
  reason: NudgeReason,
): boolean =>
  Object.hasOwn(
    state.commands,
    nudgeCommandId(workflowId, attemptId, reason),
  ) ||
  (state.attempts[attemptId]?.nudges.some((n) => n.reason === reason) ?? false);

const gracePayload = (attemptId: string, reason: NudgeReason) => ({
  purpose: 'nudge-grace' as const,
  attemptId,
  reason,
});

/** `runtime.send` once and start the grace timer; `[]` if already nudged or not reachable. */
export const sendNudge = (
  ctx: ReactContext,
  request: NudgeRequest,
): Effect[] => {
  const attempt = ctx.state.attempts[request.attemptId];
  if (
    attempt?.agentRef === undefined ||
    !isAttemptAlive(attempt) ||
    hasNudged(ctx.state, ctx.workflowId, request.attemptId, request.reason)
  )
    return [];
  return [
    external(
      nudgeCommandId(ctx.workflowId, request.attemptId, request.reason),
      {
        kind: 'runtime.send',
        args: {
          agent: attempt.agentRef,
          subject: request.subject,
          body: request.body,
        },
      },
      { stageId: attempt.stageId, attemptId: attempt.attemptId },
    ),
    schedule(
      ctx,
      gracePayload(request.attemptId, request.reason),
      NUDGE_GRACE_MS,
    ),
  ];
};

/** The submission arrived in time: drop the pending grace timer, if any. */
export const cancelNudge = (
  ctx: ReactContext,
  attemptId: string,
  reason: NudgeReason,
): Effect[] => {
  const id = timerId(ctx.workflowId, gracePayload(attemptId, reason));
  return Object.hasOwn(ctx.state.timers, id)
    ? [cancelTimer(id, 'satisfied')]
    : [];
};

export type ExceptionGateSpec = Pick<
  Extract<OpenGate['gate'], { kind: 'exception' }>,
  'exceptionKind' | 'title' | 'options'
> & { summary: string; itemKey?: string };

/** §8.3 stage violation: rerun the stage / reassign to another agent kind / abort. */
export const STAGE_VIOLATION_OPTIONS: ExceptionGateSpec['options'] = [
  { optionId: 'rerun', label: '重跑階段' },
  { optionId: 'reassign', label: '改派', input: 'agent' },
  { optionId: 'abort', label: '中止流程' },
];

export const nudgeGateId = (
  workflowId: string,
  attemptId: string,
  reason: NudgeReason,
): string => commandId({ workflowId }, 'gate', 'nudge', attemptId, reason);

/** Grace expired without the submission: stop the attempt and open the exception gate. */
export const escalateNudge = (
  ctx: ReactContext,
  attemptId: string,
  reason: NudgeReason,
  gate: ExceptionGateSpec,
): Effect[] => {
  const attempt = ctx.state.attempts[attemptId];
  if (attempt === undefined) return [];
  return [
    ...stopAttempt(ctx, attempt, 'nudge', reason),
    internal({
      type: 'OpenGate',
      meta: metaFor(ctx),
      noLiveAttempts: liveAttempts(ctx.state).length === 0,
      gate: {
        kind: 'exception',
        gateId: nudgeGateId(ctx.workflowId, attemptId, reason),
        stageId: attempt.stageId,
        exceptionKind: gate.exceptionKind,
        title: gate.title,
        options: gate.options,
        content: {
          type: 'exception',
          summary: gate.summary,
          attemptId,
          ...(gate.itemKey === undefined ? {} : { itemKey: gate.itemKey }),
        },
      },
    }),
  ];
};
