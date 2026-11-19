import type { EventPayload } from '@ai-office/contracts/events';
import { possiblyLiveAttempts } from '@ai-office/domain';
import type { EXCEPTION_OPTIONS } from '@ai-office/domain';
import type { CommandRecord, OpenGate, WorkflowState } from '@ai-office/domain';
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
 * The stage gate opens as soon as the close is complete (`stageCloseComplete`),
 * never earlier: no attempt is possibly alive, no stop/release is in flight,
 * and every stop/release this close issued has succeeded. `seat.exited` alone
 * is not enough (M2-FX12: on real Orca it precedes the release by ~2 s, and an
 * exited but unreleased terminal is still a live Orca worker). A close command
 * that fails for good keeps the gate closed, so the timers lead to the anomaly
 * gate.
 * The close is "in progress" exactly while a `gate-precheck` timer is pending.
 * "Alive" here is `possiblyLiveAttempts`: a `lost` attempt is not proven
 * stopped (N9), so it is stopped/released too and keeps the gate closed until
 * it is confirmed `exited` or released.
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

const isEnd = (record: CommandRecord): boolean =>
  record.issued.kind === 'runtime.stop' ||
  record.issued.kind === 'runtime.release';

/** This stage's close commands, with their phase and round (event seq). */
const closeRounds = (state: WorkflowState, stageId: string) => {
  const prefix = `${stageId}#${state.stages[stageId]?.attempt ?? 0}@`;
  return Object.values(state.commands).flatMap((record) => {
    const [tag, phase, close] = record.id.split('/').reverse();
    return isEnd(record) && close === 'close' && tag!.startsWith(prefix)
      ? [{ record, phase, seq: Number(tag!.slice(prefix.length)) }]
      : [];
  });
};

/**
 * Close stop/release commands of the current round of this stage's close: the
 * latest `wait` (a re-begun close after an anomaly decision supersedes the
 * earlier round) and the `restop` after it.
 */
const closeCommands = (state: WorkflowState, stageId: string) => {
  const ours = closeRounds(state, stageId);
  const round = Math.max(
    -1,
    ...ours.filter((c) => c.phase === 'wait').map((c) => c.seq),
  );
  return ours.filter((c) => c.seq >= round).map((c) => c.record);
};

/** Attempts this close released (or tried to) that are still not released. */
const unreleased = (state: WorkflowState, stageId: string) =>
  closeCommands(state, stageId).flatMap((record) => {
    const attempt =
      record.issued.kind === 'runtime.release' && record.attemptId
        ? state.attempts[record.attemptId]
        : undefined;
    return attempt && !attempt.released ? [attempt] : [];
  });

/** A stop still pending or failed is moot once its attempt is released. */
const moot = (state: WorkflowState, record: CommandRecord): boolean =>
  record.issued.kind === 'runtime.stop' &&
  record.attemptId !== undefined &&
  state.attempts[record.attemptId]?.released === true;

/**
 * §8.1 complete: nothing possibly alive; no stop/release in flight anywhere
 * (a stage may release its own seats, e.g. the integrator before final-pr);
 * every stop/release of the current close round succeeded. Superseded close
 * rounds of this stage do not count.
 */
export const stageCloseComplete = (
  state: WorkflowState,
  stageId: string,
): boolean => {
  if (possiblyLiveAttempts(state).length > 0) return false;
  const current = closeCommands(state, stageId);
  const superseded = new Set(
    closeRounds(state, stageId)
      .map((c) => c.record)
      .filter((record) => !current.includes(record))
      .map((record) => record.id),
  );
  const inFlight = Object.values(state.commands).some(
    (record) =>
      isEnd(record) &&
      record.status === 'issued' &&
      !superseded.has(record.id) &&
      !moot(state, record),
  );
  return (
    !inFlight &&
    current.every(
      (record) => record.status === 'succeeded' || moot(state, record),
    ) &&
    unreleased(state, stageId).length === 0
  );
};

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
  stageId: string,
  phase: 'wait' | 'restop',
  tag: string,
): Effect[] => {
  const live = possiblyLiveAttempts(ctx.state);
  // A re-begun close (anomaly "stop again") also retries a failed release.
  const retry =
    phase === 'wait'
      ? unreleased(ctx.state, stageId).filter(
          (a, i, all) =>
            !live.includes(a) &&
            all.findIndex((b) => b.attemptId === a.attemptId) === i,
        )
      : [];
  return [
    ...live.flatMap((attempt) => [
      ...stopAttempt(ctx, attempt, 'close', phase, tag),
      ...(phase === 'wait'
        ? releaseAttempt(ctx, attempt, false, 'close', phase, tag)
        : []),
    ]),
    ...retry.flatMap((attempt) =>
      releaseAttempt(ctx, attempt, false, 'close', phase, tag),
    ),
  ];
};

/**
 * Step 1: called by a stage module once its stage is complete (`stage.completed`
 * → `awaiting_gate`; DecideGate's OpenGate requires that status).
 */
export const beginStageClose = (
  ctx: ReactContext,
  stageId: string,
  stageGate: StageGateBuilder,
): Effect[] => {
  const tag = closeTag(ctx, stageId);
  const close = stopAll(ctx, stageId, 'wait', tag);
  if (close.length === 0 && stageCloseComplete(ctx.state, stageId))
    return openStageGate(ctx, stageId, stageGate);
  return [
    ...close,
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
  const alive = [
    ...new Set(
      [
        ...possiblyLiveAttempts(ctx.state),
        ...unreleased(ctx.state, stageId),
      ].map((attempt) => attempt.attemptId),
    ),
  ];
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

/** Events that can complete the close: an attempt ending or a close command settling. */
const CLOSE_PROGRESS_EVENTS: ReadonlySet<string> = new Set([
  'seat.status',
  'seat.exited',
  'seat.released',
  'command.succeeded',
  'command.failed',
]);

/** Steps 2–3 and early completion; the dispatcher runs this for every event. */
export const reactStageClose = (
  ctx: ReactContext,
  stageGate: StageGateBuilder,
): Effect[] => {
  const fired = firedTimer(ctx, 'gate-precheck');
  if (fired !== undefined) {
    const { stageId, phase } = fired.payload;
    if (stageCloseComplete(ctx.state, stageId))
      return openStageGate(ctx, stageId, stageGate);
    if (phase === 'restop') return openAnomaly(ctx, stageId);
    const tag = closeTag(ctx, stageId);
    const alive = [
      ...new Set(
        [
          ...possiblyLiveAttempts(ctx.state),
          ...unreleased(ctx.state, stageId),
        ].map((attempt) => attempt.attemptId),
      ),
    ];
    return [
      ...stopAll(ctx, stageId, 'restop', tag),
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
  if (!CLOSE_PROGRESS_EVENTS.has(ctx.event.type)) return [];
  return pendingTimers(ctx.state, 'gate-precheck').flatMap((timer) =>
    stageCloseComplete(ctx.state, timer.payload.stageId)
      ? [
          cancelTimer(timer.id, 'agents_ended'),
          ...openStageGate(ctx, timer.payload.stageId, stageGate),
        ]
      : [],
  );
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
