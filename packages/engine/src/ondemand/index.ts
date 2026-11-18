import { seatIdFor } from '@ai-office/contracts/events';
import type { OndemandPurpose } from '@ai-office/contracts/events';
import { isAttemptAlive, isAttemptPossiblyAlive } from '@ai-office/domain';
import type { Attempt, TimerPayload } from '@ai-office/domain';
import { releaseAttempt, stopAttempt } from '../agents.js';
import { commandId, metaFor, sessionRef } from '../context.js';
import type { ReactContext } from '../context.js';
import { external, internal } from '../effects.js';
import type { Effect } from '../effects.js';
import type { StageModule } from '../stages/types.js';
import { cancelTimer, MINUTE_MS, schedule } from '../timers.js';
import { reactMergeSubmission, reviewBody } from './merge-queue.js';
import { escalateQuestion, reactOncallSubmission } from './oncall.js';

const purposes = ['merge', 'oncall'] as const;
const instanceOf = (
  ctx: ReactContext,
  stageId: string,
  purpose: OndemandPurpose,
) => ctx.state.ondemand[stageId]?.[purpose];
const resolved = (ctx: ReactContext, purpose: OndemandPurpose, key: string) =>
  purpose === 'merge'
    ? !['merge_queued', 'in_review'].includes(
        ctx.state.workItems[key]?.status ?? '',
      )
    : !['open', 'forwarded'].includes(ctx.state.questions[key]?.status ?? '');
const update = (
  ctx: ReactContext,
  stageId: string,
  purpose: OndemandPurpose,
  queue: string[],
  current?: string,
): Effect =>
  internal({
    type: 'UpdateOnDemandQueue',
    meta: metaFor(ctx),
    update: {
      stageId,
      purpose,
      queue,
      ...(current === undefined ? {} : { current }),
    },
  });
const timeout = (
  ctx: ReactContext,
  stageId: string,
  purpose: OndemandPurpose,
  attemptId: string,
  current: string,
): Effect =>
  internal({
    type: 'TimeoutOnDemand',
    meta: metaFor(ctx),
    stageId,
    purpose,
    attemptId,
    current,
    gateId: commandId(
      ctx,
      'gate',
      'ondemand',
      attemptId,
      current,
      ctx.event.id,
    ),
  });
const entryPayload = (
  purpose: OndemandPurpose,
  key: string,
  attemptId: string,
): TimerPayload =>
  purpose === 'merge'
    ? { purpose: 'review-timeout', itemKey: key, attemptId }
    : { purpose: 'question-timeout', questionId: key };
const entryTimers = (
  ctx: ReactContext,
  purpose: OndemandPurpose,
  key: string,
) =>
  Object.values(ctx.state.timers).filter((t) =>
    purpose === 'merge'
      ? t.payload.purpose === 'review-timeout' && t.payload.itemKey === key
      : t.payload.purpose === 'question-timeout' &&
        t.payload.questionId === key,
  );
const idleTimers = (
  ctx: ReactContext,
  stageId: string,
  purpose: OndemandPurpose,
) =>
  Object.values(ctx.state.timers).filter(
    (t) =>
      t.payload.purpose === 'ondemand-idle' &&
      t.payload.stageId === stageId &&
      t.payload.ondemand === purpose,
  );

/** Preserve lost attempts as possibly live until stop/release has been confirmed. */
const shutdown = (
  ctx: ReactContext,
  stageId: string,
  purpose: OndemandPurpose,
  attempt: Attempt,
  reason: 'queue_empty' | 'failed' | 'stage_ended' | 'cancelled',
): Effect[] => {
  const effects: Effect[] = [];
  if (isAttemptPossiblyAlive(attempt)) {
    effects.push(
      ...stopAttempt(ctx, attempt, 'ondemand'),
      ...releaseAttempt(ctx, attempt, true, 'ondemand'),
    );
  } else {
    if (!attempt.released)
      effects.push(...releaseAttempt(ctx, attempt, true, 'ondemand'));
    if (!instanceOf(ctx, stageId, purpose)?.stopped)
      effects.push(
        internal({
          type: 'StopOnDemand',
          meta: metaFor(ctx),
          stop: { stageId, purpose, attemptId: attempt.attemptId, reason },
        }),
      );
  }
  return effects.filter(
    (e) => e.kind !== 'external' || !ctx.state.commands[e.commandId],
  );
};

const spawn = (
  ctx: ReactContext,
  stageId: string,
  purpose: OndemandPurpose,
): Effect[] => {
  const workflow = ctx.state.workflow!;
  const config = workflow.template.stages.find((s) => s.id === stageId);
  const instance = instanceOf(ctx, stageId, purpose);
  if (
    config?.kind !== 'implement' ||
    !instance?.queue.length ||
    workflow.pausedReasons.length ||
    workflow.cancelRequested
  )
    return [];
  const attempts = Object.values(ctx.state.attempts).filter(
    (a) => a.stageId === stageId && a.ondemand?.purpose === purpose,
  );
  if (attempts.some(isAttemptPossiblyAlive)) return [];
  const role =
    purpose === 'merge' ? config.mergeQueue.role : config.onCall.role;
  // A shared role's previous stage must have relinquished the seat too.
  if (
    Object.values(ctx.state.attempts).some(
      (a) => a.role === role && isAttemptPossiblyAlive(a),
    )
  )
    return [];
  const generation = attempts.length + 1;
  const prefix = commandId(
    ctx,
    stageId,
    ctx.state.stages[stageId]!.attempt,
    'ondemand',
    purpose,
    generation,
  );
  const session = sessionRef(ctx.state);
  if (!session) return [];
  const workspaceId = `${prefix}/workspace`;
  if (!ctx.state.commands[workspaceId])
    return [
      external(
        workspaceId,
        {
          kind: 'runtime.prepareWorkspace',
          args: {
            session,
            repo: {
              orcaRepoId: workflow.repo.orcaRepoId,
              localPath: workflow.repo.localPath,
            },
            baseBranch: `origin/${workflow.integrationBranch}`,
            fetchBranch: workflow.integrationBranch,
            name: `aio-${workflow.shortId}-${purpose}-${generation}`,
            branch: `ai-office/${workflow.shortId}/${purpose}-${generation}`,
          },
        },
        { stageId },
      ),
    ];
  const result = ctx.state.commands[workspaceId]?.result;
  if (
    ctx.event.type !== 'command.succeeded' ||
    ctx.event.payload.commandId !== workspaceId ||
    result?.kind !== 'runtime.prepareWorkspace' ||
    result.result === null ||
    !('workspace' in result.result)
  )
    return [];
  const attemptId = `${prefix}/attempt`;
  const spawnCommandId = `${prefix}/spawn`;
  const override = workflow.roleOverrides[role];
  const agent = override?.agent ?? workflow.template.roles[role]!.agent;
  const effort = override?.effort ?? workflow.template.roles[role]!.effort;
  return [
    internal({
      type: 'SpawnAttempt',
      meta: metaFor(ctx),
      stageId,
      role,
      attemptId,
      purpose: purpose === 'merge' ? 'integrator' : 'oncall',
      keepOpen: true,
      spawnCommandId,
      agent,
      ...(effort ? { effort } : {}),
    }),
    {
      kind: 'spawn',
      commandId: spawnCommandId,
      stageId,
      seatId: seatIdFor({ workflowId: ctx.workflowId, role }),
      attemptId,
      spec:
        purpose === 'merge'
          ? { purpose: 'merge-queue', stageId, itemKey: instance.queue[0]! }
          : { purpose: 'oncall', stageId, questionId: instance.queue[0]! },
      agent,
      ...(effort ? { effort } : {}),
      keepOpen: true,
      workspace: {
        kind: 'existing-worktree',
        workspace: result.result.workspace,
        readOnly: purpose === 'oncall',
      },
    },
  ];
};

const reactPurpose = (
  ctx: ReactContext,
  stageId: string,
  purpose: OndemandPurpose,
): Effect[] => {
  const event = ctx.event;
  const instance = instanceOf(ctx, stageId, purpose);
  const attempt = ctx.state.attempts[instance?.attemptId ?? ''];
  const current = instance?.current;
  const config = ctx.state.workflow!.template.stages.find(
    (s) => s.id === stageId,
  );
  if (config?.kind !== 'implement') return [];
  const minutes =
    purpose === 'merge'
      ? config.mergeQueue.reviewTimeoutMin
      : config.onCall.questionTimeoutMin;
  const active = ctx.state.stages[stageId]?.status === 'running';
  const terminal =
    ctx.state.workItemOrder.length > 0 &&
    ctx.state.workItemOrder.every((key) =>
      ['merged', 'skipped', 'failed'].includes(
        ctx.state.workItems[key]!.status,
      ),
    );
  const closing = !active || terminal || !!ctx.state.workflow!.cancelRequested;
  const effects: Effect[] = [];
  if (closing) {
    if (attempt && !instance?.stopped)
      effects.push(
        ...shutdown(
          ctx,
          stageId,
          purpose,
          attempt,
          ctx.state.workflow!.cancelRequested ? 'cancelled' : 'stage_ended',
        ),
      );
    effects.push(
      ...idleTimers(ctx, stageId, purpose).map((t) =>
        cancelTimer(t.id, 'stage_ended'),
      ),
    );
    if (current)
      effects.push(
        ...entryTimers(ctx, purpose, current).map((t) =>
          cancelTimer(t.id, 'stage_ended'),
        ),
      );
    return effects;
  }
  if (
    purpose === 'merge' &&
    (event.type === 'workitem.merge_queued' ||
      (event.type === 'workitem.status' &&
        event.payload.status === 'merge_queued'))
  ) {
    const key = event.payload.itemKey;
    if (key !== current && !instance?.queue.includes(key))
      return [
        update(
          ctx,
          stageId,
          purpose,
          [...(instance?.queue ?? []), key],
          current,
        ),
      ];
  }
  if (event.type === 'message.question' && purpose === 'oncall') {
    const asker = ctx.state.attempts[event.payload.attemptId];
    if (asker?.stageId !== stageId) return [];
    if (asker.purpose !== 'worker')
      return escalateQuestion(
        ctx,
        stageId,
        event.payload.questionId,
        'no-responder',
        event.payload.body,
      );
    return [
      update(
        ctx,
        stageId,
        purpose,
        [...(instance?.queue ?? []), event.payload.questionId],
        current,
      ),
    ];
  }
  if (
    event.type === 'command.succeeded' &&
    event.payload.kind === 'runtime.spawnAgent'
  ) {
    const spawned =
      ctx.state.attempts[
        ctx.state.commands[event.payload.commandId]?.attemptId ?? ''
      ];
    if (spawned?.ondemand?.purpose === purpose && spawned.stageId === stageId)
      return [
        internal({
          type: 'StartOnDemand',
          meta: metaFor(ctx),
          instance: { stageId, purpose, attemptId: spawned.attemptId },
        }),
      ];
  }
  if (!instance) return [];
  if (current && resolved(ctx, purpose, current))
    return [
      ...entryTimers(ctx, purpose, current).map((t) =>
        cancelTimer(t.id, 'resolved'),
      ),
      update(
        ctx,
        stageId,
        purpose,
        instance.queue.filter((key) => !resolved(ctx, purpose, key)),
      ),
    ];
  // An accepted merge is an in-flight side effect even if its reviewer disappears.
  // Keep its queue reservation until the command settles; never merge another PR in parallel.
  const pendingMerge =
    purpose === 'merge' &&
    current &&
    Object.values(ctx.state.commands).some(
      (c) =>
        c.status === 'issued' &&
        c.issued.kind === 'scm.mergePR' &&
        c.issued.args.pr.number === ctx.state.workItems[current]?.pr,
    );
  if (pendingMerge) return [];
  if (
    event.type === 'command.failed' &&
    event.payload.kind === 'scm.mergePR' &&
    purpose === 'merge' &&
    current &&
    attempt &&
    !isAttemptAlive(attempt)
  )
    return [timeout(ctx, stageId, purpose, attempt.attemptId, current)];
  // Failure requeue is decided before shutdown removes the old current assignment.
  if (
    (event.type === 'seat.exited' || event.type === 'seat.status') &&
    attempt &&
    event.payload.attemptId === attempt.attemptId &&
    !isAttemptAlive(attempt) &&
    !instance.stopped
  ) {
    if (current)
      return [timeout(ctx, stageId, purpose, attempt.attemptId, current)];
    return shutdown(
      ctx,
      stageId,
      purpose,
      attempt,
      instance.queue.length ? 'failed' : 'queue_empty',
    );
  }
  if (
    event.type === 'seat.released' &&
    attempt &&
    event.payload.attemptId === attempt.attemptId &&
    !instance.stopped
  )
    return shutdown(
      ctx,
      stageId,
      purpose,
      attempt,
      instance.queue.length ? 'failed' : 'queue_empty',
    );
  const queueEvent =
    event.type === 'ondemand.queue_changed' &&
    event.payload.stageId === stageId &&
    event.payload.purpose === purpose;
  const started =
    event.type === 'ondemand.started' &&
    event.payload.stageId === stageId &&
    event.payload.purpose === purpose;
  const stopped =
    event.type === 'ondemand.stopped' &&
    event.payload.stageId === stageId &&
    event.payload.purpose === purpose;
  const previous = ctx.before.ondemand[stageId]?.[purpose];
  if (
    queueEvent &&
    previous?.current &&
    instance.queue.includes(previous.current) &&
    attempt
  ) {
    return [
      ...entryTimers(ctx, purpose, previous.current).map((t) =>
        cancelTimer(t.id, 'requeued'),
      ),
      ...shutdown(ctx, stageId, purpose, attempt, 'failed'),
    ];
  }
  if (queueEvent && attempt && !isAttemptAlive(attempt) && !instance.stopped)
    return shutdown(ctx, stageId, purpose, attempt, 'failed');
  if (
    queueEvent &&
    current &&
    current !== previous?.current &&
    attempt?.agentRef
  ) {
    const retry = instance.deliveries?.[current]?.retries ?? 0;
    const question = ctx.state.questions[current];
    return [
      ...idleTimers(ctx, stageId, purpose).map((t) =>
        cancelTimer(t.id, 'work_arrived'),
      ),
      ...(purpose === 'oncall'
        ? [
            internal({
              type: 'ForwardQuestion',
              meta: metaFor(ctx),
              questionId: current,
              to: 'on-call',
              toAttemptId: attempt.attemptId,
              retry,
            }),
          ]
        : []),
      external(
        commandId(
          ctx,
          'ondemand',
          'send',
          attempt.attemptId,
          current,
          event.id,
        ),
        {
          kind: 'runtime.send',
          args: {
            agent: attempt.agentRef,
            subject: current,
            body:
              purpose === 'merge'
                ? reviewBody(ctx, current)
                : JSON.stringify({
                    questionId: current,
                    itemKey: question?.itemKey,
                    body: question?.body,
                  }),
          },
        },
        { stageId, attemptId: attempt.attemptId },
      ),
      schedule(
        ctx,
        entryPayload(purpose, current, attempt.attemptId),
        minutes * MINUTE_MS,
        attempt.attemptId,
        event.seq,
      ),
    ];
  }
  if (
    event.type === 'message.nudge' &&
    attempt &&
    event.payload.attemptId === attempt.attemptId &&
    event.payload.subject === current &&
    event.payload.reason ===
      (purpose === 'merge' ? 'review-timeout' : 'question-timeout') &&
    attempt.agentRef
  )
    return [
      external(
        commandId(
          ctx,
          'ondemand',
          'nudge',
          attempt.attemptId,
          current!,
          event.id,
        ),
        {
          kind: 'runtime.send',
          args: {
            agent: attempt.agentRef,
            subject: current!,
            body: event.payload.body,
          },
        },
        { stageId, attemptId: attempt.attemptId },
      ),
      schedule(
        ctx,
        entryPayload(purpose, current!, attempt.attemptId),
        minutes * MINUTE_MS,
        attempt.attemptId,
        event.seq,
      ),
    ];
  const timer = ctx.timer;
  if (event.type === 'timer.fired' && timer && attempt && !instance.stopped) {
    if (
      timer.payload.purpose === 'ondemand-idle' &&
      timer.payload.stageId === stageId &&
      timer.payload.ondemand === purpose &&
      !current &&
      !instance.queue.length
    )
      return shutdown(ctx, stageId, purpose, attempt, 'queue_empty');
    if (
      current &&
      ((purpose === 'merge' &&
        timer.payload.purpose === 'review-timeout' &&
        timer.payload.itemKey === current &&
        timer.payload.attemptId === attempt.attemptId) ||
        (purpose === 'oncall' &&
          timer.payload.purpose === 'question-timeout' &&
          timer.payload.questionId === current &&
          timer.id.includes(attempt.attemptId)))
    )
      return [timeout(ctx, stageId, purpose, attempt.attemptId, current)];
  }
  if (
    queueEvent ||
    started ||
    stopped ||
    event.type === 'workflow.resumed' ||
    (event.type === 'command.succeeded' &&
      event.payload.kind === 'runtime.prepareWorkspace')
  ) {
    if (!current && instance.queue.length) {
      effects.push(
        ...idleTimers(ctx, stageId, purpose).map((t) =>
          cancelTimer(t.id, 'work_arrived'),
        ),
      );
      if (ctx.state.workflow!.pausedReasons.length) return effects;
      if (attempt && !instance.stopped && isAttemptAlive(attempt))
        effects.push(
          update(
            ctx,
            stageId,
            purpose,
            instance.queue.slice(1),
            instance.queue[0],
          ),
        );
      else effects.push(...spawn(ctx, stageId, purpose));
    } else if (
      !current &&
      !instance.queue.length &&
      attempt &&
      !instance.stopped &&
      isAttemptAlive(attempt) &&
      !idleTimers(ctx, stageId, purpose).length
    )
      effects.push(
        schedule(
          ctx,
          { purpose: 'ondemand-idle', stageId, ondemand: purpose },
          5 * MINUTE_MS,
          attempt.attemptId,
          event.seq,
        ),
      );
  }
  return effects;
};

const relevant = new Set([
  'workitem.merge_queued',
  'workitem.merged',
  'workitem.rework_requested',
  'workitem.status',
  'message.question',
  'message.answered',
  'message.escalated',
  'message.nudge',
  'submission.accepted',
  'command.succeeded',
  'command.failed',
  'ondemand.queue_changed',
  'ondemand.started',
  'ondemand.stopped',
  'seat.exited',
  'seat.status',
  'seat.released',
  'timer.fired',
  'stage.completed',
  'workflow.resumed',
  'workflow.cancel_requested',
]);

/** T14 interacts with this partition exclusively through persisted domain events. */
export const ondemandStage: StageModule = {
  react: (ctx) => {
    if (!ctx.state.workflow || !relevant.has(ctx.event.type)) return [];
    const stageId = ctx.state.workflow.template.stages.find(
      (s) => s.kind === 'implement',
    )!.id;
    return [
      ...reactMergeSubmission(ctx, stageId),
      ...reactOncallSubmission(ctx, stageId),
      ...purposes.flatMap((purpose) => reactPurpose(ctx, stageId, purpose)),
    ];
  },
};
