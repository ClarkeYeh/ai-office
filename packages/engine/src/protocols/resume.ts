import type {
  DomainEvent,
  EventPayload,
  EventType,
} from '@ai-office/contracts/events';
import type { ReactContext } from '../context.js';
import type { Effect } from '../effects.js';
import type { StageModule } from '../stages/types.js';

/**
 * Re-evaluation on resume (§16). Stages ignore events while the workflow is
 * paused, yet those events still change state: an agent's submission is
 * accepted, a command succeeds, the final PR is observed merged. A stage's
 * `resume` hook rebuilds from state alone the events it would have acted on;
 * on the `workflow.resumed` that leaves the workflow unpaused, `reactStage`
 * runs the stage on each of them as if just delivered. Checks that only read
 * state need no hook: they treat `workflow.resumed` itself as a wake-up.
 *
 * Replay is idempotent: hooks rebuild only what state shows unhandled,
 * replayed commands or timers already issued are dropped here, and the domain
 * accepts a repeated RecordStageArtifact or CloseGate as a no-op.
 */
export const isResume = (ctx: ReactContext): boolean => {
  const workflow = ctx.state.workflow;
  return (
    ctx.event.type === 'workflow.resumed' &&
    workflow?.status === 'running' &&
    !workflow.cancelRequested &&
    workflow.pausedReasons.length === 0
  );
};

/** An event the stage missed while paused, timed and caused as the resume. */
export const missed = <T extends EventType>(
  ctx: ReactContext,
  type: T,
  payload: EventPayload<T>,
  scope: { stageId?: string | undefined; attemptId?: string | undefined } = {},
): DomainEvent => {
  // The resume is workflow-scoped; the missed event takes the given scope.
  const envelope: Partial<DomainEvent> = { ...ctx.event };
  delete envelope.stageId;
  delete envelope.attemptId;
  delete envelope.seatId;
  return {
    ...envelope,
    ...(scope.stageId === undefined ? {} : { stageId: scope.stageId }),
    ...(scope.attemptId === undefined ? {} : { attemptId: scope.attemptId }),
    type,
    payload,
  } as DomainEvent;
};

/** The result a command reported while paused, as its `command.succeeded` / `command.failed`. */
export const missedResult = (
  ctx: ReactContext,
  commandId: string,
  stageId?: string,
): DomainEvent | undefined => {
  const record = ctx.state.commands[commandId];
  const scope = { stageId, attemptId: record?.attemptId };
  if (record?.result)
    return missed(
      ctx,
      'command.succeeded',
      { ...record.result, commandId } as EventPayload<'command.succeeded'>,
      scope,
    );
  if (record?.error)
    return missed(
      ctx,
      'command.failed',
      {
        commandId,
        kind: record.issued.kind,
        error: record.error,
        attempts: record.failedAttempts ?? 1,
      },
      scope,
    );
  return undefined;
};

const key = (effect: Effect): string => {
  switch (effect.kind) {
    case 'external':
    case 'spawn':
      return `command:${effect.commandId}`;
    case 'timer':
      return `timer:${effect.timer.id}`;
    case 'cancelTimer':
      return `cancel:${effect.id}`;
    case 'internal':
      return `internal:${JSON.stringify(effect.command)}`;
  }
};

/** Runs one stage module, replaying what it missed while paused on resume. */
export const reactStage = (stage: StageModule, ctx: ReactContext): Effect[] => {
  const effects = stage.react(ctx);
  if (stage.resume === undefined || !isResume(ctx)) return effects;
  const seen = new Set(effects.map(key));
  for (const event of stage.resume(ctx))
    for (const effect of stage.react({ ...ctx, event })) {
      const id = key(effect);
      const issued =
        (effect.kind === 'external' || effect.kind === 'spawn') &&
        ctx.state.commands[effect.commandId] !== undefined;
      const pending =
        effect.kind === 'timer' && ctx.state.timers[effect.timer.id];
      if (seen.has(id) || issued || pending) continue;
      seen.add(id);
      effects.push(effect);
    }
  return effects;
};
