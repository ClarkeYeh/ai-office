import type { EventPayload } from '@ai-office/contracts/events';
import { liveAttempts } from '@ai-office/domain';
import type { EXCEPTION_OPTIONS } from '@ai-office/domain';
import type { OpenGate, WorkflowState } from '@ai-office/domain';
import { releaseAttempt, stopAttempt } from '../agents.js';
import { commandId, metaFor } from '../context.js';
import type { ReactContext } from '../context.js';
import { internal } from '../effects.js';
import type { Effect } from '../effects.js';
import { cancelTimer, firedTimer, pendingTimers, schedule } from '../timers.js';

/**
 * §8.1 pre-gate clearing. A stage gate never opens while an agent of the
 * workflow is alive:
 *   1. stop + release every live attempt, wait up to 60 s for them to end;
 *   2. still alive → stop again, wait 30 s more;
 *   3. still alive → open an `anomaly` exception gate and pause the workflow.
 * Whenever the last attempt ends during a wait, the stage gate opens at once.
 * The close is "in progress" exactly while a `gate-precheck` timer is pending.
 */
export const PRECHECK_WAIT_MS = 60_000;
export const PRECHECK_RESTOP_MS = 30_000;

/**
 * Anomaly gate options (§8.1), from domain's `EXCEPTION_OPTIONS.anomaly`.
 * `stop-again` is handled here; `abort` becomes `workflow.cancel_requested` in
 * DecideGate and its follow-through (stop, close gates, labels) is T16's cancel
 * policy.
 */
export const CLOSE_ANOMALY_OPTIONS = {
  restop: 'stop-again',
  abort: 'abort',
} as const satisfies Record<string, (typeof EXCEPTION_OPTIONS.anomaly)[number]>;

/** Builds the stage gate once the stage has no live agents; supplied per stage kind. */
export type StageGateBuilder = (
  state: WorkflowState,
  stageId: string,
) => OpenGate['gate'] | undefined;

const closeTag = (ctx: ReactContext, stageId: string): string =>
  `${stageId}#${ctx.state.stages[stageId]?.attempt ?? 0}@${ctx.event.seq}`;

const openStageGate = (
  ctx: ReactContext,
  stageId: string,
  stageGate: StageGateBuilder,
): Effect[] => {
  const gate = stageGate(ctx.state, stageId);
  return gate === undefined
    ? []
    : [
        internal({
          type: 'OpenGate',
          meta: metaFor(ctx),
          gate,
          noLiveAttempts: true,
        }),
      ];
};

const stopAll = (
  ctx: ReactContext,
  phase: 'wait' | 'restop',
  tag: string,
): Effect[] =>
  liveAttempts(ctx.state).flatMap((attempt) => [
    ...stopAttempt(ctx, attempt, 'close', phase, tag),
    ...(phase === 'wait'
      ? releaseAttempt(ctx, attempt, false, 'close', phase, tag)
      : []),
  ]);

/**
 * Step 1: called by a stage module once its stage is complete (`stage.completed`
 * → `awaiting_gate`; DecideGate's OpenGate requires that status).
 */
export const beginStageClose = (
  ctx: ReactContext,
  stageId: string,
  stageGate: StageGateBuilder,
): Effect[] => {
  if (liveAttempts(ctx.state).length === 0)
    return openStageGate(ctx, stageId, stageGate);
  const tag = closeTag(ctx, stageId);
  return [
    ...stopAll(ctx, 'wait', tag),
    schedule(
      ctx,
      { purpose: 'gate-precheck', stageId, phase: 'wait' },
      PRECHECK_WAIT_MS,
      tag,
    ),
  ];
};

export const closeAnomalyGateId = (
  ctx: ReactContext,
  stageId: string,
): string => commandId(ctx, 'gate', 'close-anomaly', closeTag(ctx, stageId));

const isCloseAnomalyGate = (workflowId: string, gateId: string): boolean =>
  gateId.startsWith(`${workflowId}/gate/close-anomaly/`);

const openAnomaly = (ctx: ReactContext, stageId: string): Effect[] => {
  const gateId = closeAnomalyGateId(ctx, stageId);
  const alive = liveAttempts(ctx.state).map((attempt) => attempt.attemptId);
  const summary = `Agents still alive before the stage gate: ${alive.join(', ')}`;
  return [
    internal({
      type: 'OpenGate',
      meta: metaFor(ctx),
      noLiveAttempts: false,
      gate: {
        kind: 'exception',
        gateId,
        stageId,
        exceptionKind: 'anomaly',
        title: '關卡前仍有活著的 agent',
        options: [
          {
            optionId: CLOSE_ANOMALY_OPTIONS.restop,
            label: '再次停止並開啟關卡',
          },
          { optionId: CLOSE_ANOMALY_OPTIONS.abort, label: '中止流程' },
        ],
        content: { type: 'exception', summary },
      },
    }),
    internal({
      type: 'PauseWorkflow',
      meta: metaFor(ctx),
      reason: 'anomaly',
      gateId,
      detail: summary,
    }),
  ];
};

const ATTEMPT_END_EVENTS: ReadonlySet<string> = new Set([
  'seat.status',
  'seat.exited',
  'seat.released',
]);

/** Steps 2–3 and early completion; the dispatcher runs this for every event. */
export const reactStageClose = (
  ctx: ReactContext,
  stageGate: StageGateBuilder,
): Effect[] => {
  const fired = firedTimer(ctx, 'gate-precheck');
  if (fired !== undefined) {
    const { stageId, phase } = fired.payload;
    if (liveAttempts(ctx.state).length === 0)
      return openStageGate(ctx, stageId, stageGate);
    if (phase === 'restop') return openAnomaly(ctx, stageId);
    const tag = closeTag(ctx, stageId);
    const alive = liveAttempts(ctx.state).map((attempt) => attempt.attemptId);
    return [
      ...stopAll(ctx, 'restop', tag),
      internal({
        type: 'RecordError',
        meta: metaFor(ctx),
        category: 'transient',
        code: 'stage_close_restop',
        message: `Agents still alive ${PRECHECK_WAIT_MS / 1000} s after stop; stopping again`,
        stageId,
        detail: alive.join(', '),
      }),
      schedule(
        ctx,
        { purpose: 'gate-precheck', stageId, phase: 'restop' },
        PRECHECK_RESTOP_MS,
        tag,
      ),
    ];
  }
  if (ctx.event.type === 'gate.decided')
    return reactAnomalyDecision(ctx, ctx.event.payload, stageGate);
  if (!ATTEMPT_END_EVENTS.has(ctx.event.type)) return [];
  if (liveAttempts(ctx.state).length > 0) return [];
  return pendingTimers(ctx.state, 'gate-precheck').flatMap((timer) => [
    cancelTimer(timer.id, 'agents_ended'),
    ...openStageGate(ctx, timer.payload.stageId, stageGate),
  ]);
};

/** "再次停止並開啟關卡": resume and run the clearing protocol again. */
const reactAnomalyDecision = (
  ctx: ReactContext,
  { gateId, optionId }: EventPayload<'gate.decided'>,
  stageGate: StageGateBuilder,
): Effect[] => {
  const gate = ctx.state.gates[gateId];
  if (
    gate === undefined ||
    !isCloseAnomalyGate(ctx.workflowId, gateId) ||
    optionId !== CLOSE_ANOMALY_OPTIONS.restop
  )
    return [];
  return [
    internal({ type: 'ResumeWorkflow', meta: metaFor(ctx), reason: 'anomaly' }),
    ...beginStageClose(ctx, gate.stageId, stageGate),
  ];
};
