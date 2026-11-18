import { EXCEPTION_OPTIONS, isAttemptAlive } from '@ai-office/domain';
import type { Attempt } from '@ai-office/domain';
import { stopAttempt } from '../agents.js';
import { commandId, metaFor } from '../context.js';
import type { ReactContext } from '../context.js';
import { external, internal } from '../effects.js';
import type { Effect } from '../effects.js';
import { nudgeCommandId } from '../protocols/nudge.js';
import { cancelTimer, firedTimer, pendingTimers, schedule } from '../timers.js';
import type { Policy } from '../stages/types.js';

/** §17.1 `engine.spawnStallMs` default, used when the workflow.started snapshot has none. */
export const DEFAULT_SPAWN_STALL_MS = 600_000;

export const spawnStallGateId = (
  ctx: Pick<ReactContext, 'workflowId'>,
  attemptId: string,
): string => commandId(ctx, 'gate', 'spawn-stall', attemptId);

/**
 * Evidence the agent got going: any activity or submission (§7.1). A worker
 * that reported done or asked a question without streamed output also counts.
 */
const started = (attempt: Attempt): boolean =>
  attempt.lastActivityAt !== undefined ||
  Object.keys(attempt.submissions).length > 0 ||
  attempt.waitingSince !== undefined ||
  ['waiting_input', 'done'].includes(attempt.state);

const attemptOf = (ctx: ReactContext): Attempt | undefined => {
  const event = ctx.event;
  if (
    event.type === 'command.succeeded' &&
    event.payload.kind === 'runtime.spawnAgent'
  ) {
    const id = ctx.state.commands[event.payload.commandId]?.attemptId;
    return id === undefined ? undefined : ctx.state.attempts[id];
  }
  if (
    [
      'seat.activity',
      'seat.status',
      'seat.exited',
      'seat.released',
      'submission.accepted',
    ].includes(event.type) &&
    'attemptId' in event.payload &&
    typeof event.payload.attemptId === 'string'
  )
    return ctx.state.attempts[event.payload.attemptId];
  return undefined;
};

/** An exception gate is already open for this attempt (M1 dedupe: one gate). */
const gateOpen = (ctx: ReactContext, attempt: Attempt): boolean =>
  Object.values(ctx.state.gates).some(
    (g) =>
      g.status === 'open' &&
      g.kind === 'exception' &&
      g.content.type === 'exception' &&
      (g.content.attemptId === attempt.attemptId ||
        (attempt.itemKey !== undefined &&
          g.content.itemKey === attempt.itemKey) ||
        (g.stageId === attempt.stageId &&
          g.exceptionKind === 'stage-violation')),
  );

const nudge = (ctx: ReactContext, attempt: Attempt): Effect[] =>
  attempt.agentRef === undefined
    ? []
    : [
        external(
          nudgeCommandId(ctx.workflowId, attempt.attemptId, 'spawn-stall'),
          {
            kind: 'runtime.send',
            args: {
              agent: attempt.agentRef,
              subject: 'Start working on your spec',
              body: 'No activity has been seen since you were started. Read the AI Office spec named in your first message and begin the task now.',
            },
          },
          { stageId: attempt.stageId, attemptId: attempt.attemptId },
        ),
        internal({
          type: 'RecordNudge',
          meta: metaFor(ctx),
          attemptId: attempt.attemptId,
          reason: 'spawn-stall',
          subject: 'Start working on your spec',
          body: 'No activity has been seen since you were started.',
        }),
      ];

/**
 * Stop first, then one `spawn-stall` gate; never an `error` or agent failure
 * (§7.1, §8.3). When another exception already covers the attempt, that one
 * expired first and owns it (M1 dedupe), so the stall rule stands down.
 */
const escalate = (ctx: ReactContext, attempt: Attempt): Effect[] =>
  gateOpen(ctx, attempt)
    ? []
    : [
        ...stopAttempt(ctx, attempt, 'spawn-stall'),
        ...Object.values(ctx.state.timers)
          .filter(
            (t) =>
              'attemptId' in t.payload &&
              t.payload.attemptId === attempt.attemptId,
          )
          .map((t) => cancelTimer(t.id, 'spawn_stall')),
        internal({
          type: 'OpenGate',
          meta: metaFor(ctx),
          noLiveAttempts: false,
          gate: {
            kind: 'exception',
            gateId: spawnStallGateId(ctx, attempt.attemptId),
            stageId: attempt.stageId,
            exceptionKind: 'spawn-stall',
            title: 'Agent did not start',
            options: EXCEPTION_OPTIONS['spawn-stall'].map((optionId) => ({
              optionId,
              label: optionId,
              ...(optionId === 'reassign' ? { input: 'agent' as const } : {}),
            })),
            content: {
              type: 'exception',
              summary:
                'No activity or submission in two spawn-stall periods after spawn; the attempt was stopped.',
              attemptId: attempt.attemptId,
              ...(attempt.itemKey === undefined
                ? {}
                : { itemKey: attempt.itemKey }),
            },
          },
        }),
      ];

/**
 * §7.1 spawn stall: one `spawnStallMs` after a successful spawn without any
 * activity or submission, one nudge; another period later, stop and gate.
 * Only spawns arm it, so later `send` turns of keep-open agents never do.
 */
export const spawnStallPolicy: Policy = (ctx) => {
  const workflow = ctx.state.workflow;
  if (!workflow || workflow.status !== 'running' || workflow.cancelRequested)
    return [];
  const period = workflow.limits.spawnStallMs ?? DEFAULT_SPAWN_STALL_MS;
  const fired = firedTimer(ctx, 'spawn-stall');
  if (fired) {
    const attempt = ctx.state.attempts[fired.payload.attemptId];
    if (!attempt || !isAttemptAlive(attempt) || started(attempt)) return [];
    // A paused workflow stops dispatching, not observation: re-check later.
    if (workflow.pausedReasons.length)
      return [schedule(ctx, fired.payload, period, ctx.event.seq)];
    return fired.payload.phase === 'nudge'
      ? [
          ...nudge(ctx, attempt),
          schedule(
            ctx,
            { ...fired.payload, phase: 'gate' },
            period,
            ctx.event.seq,
          ),
        ]
      : escalate(ctx, attempt);
  }
  const attempt = attemptOf(ctx);
  if (!attempt) return [];
  const pending = pendingTimers(ctx.state, 'spawn-stall').filter(
    (t) => t.payload.attemptId === attempt.attemptId,
  );
  if (!isAttemptAlive(attempt) || started(attempt))
    return pending.map((t) =>
      cancelTimer(t.id, isAttemptAlive(attempt) ? 'activity' : 'ended'),
    );
  if (
    ctx.event.type === 'command.succeeded' &&
    pending.length === 0 &&
    !attempt.nudges.some((n) => n.reason === 'spawn-stall')
  )
    return [
      schedule(
        ctx,
        {
          purpose: 'spawn-stall',
          attemptId: attempt.attemptId,
          phase: 'nudge',
        },
        period,
      ),
    ];
  return [];
};
