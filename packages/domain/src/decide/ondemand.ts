import type { OndemandPurpose } from '@ai-office/contracts/events';
import type { OnDemandCommand } from '../commands.js';
import { accept, reject } from '../errors.js';
import type { DecideResult } from '../errors.js';
import { isAttemptAlive, isAttemptPossiblyAlive } from '../state/index.js';
import type { Attempt, WorkflowState } from '../state/index.js';
import { draft, failed, isDomainError, runningWorkflow } from './support.js';
import { workItemException } from './workitem.js';

/** Shared by question forwarding and both on-demand queues. */
export const canRetryOnDemand = (
  previous: Attempt | undefined,
  retry: number,
): boolean =>
  retry <= 1 &&
  (previous === undefined ||
    previous.state === 'exited' ||
    previous.state === 'lost');

const resolved = (
  state: WorkflowState,
  purpose: OndemandPurpose,
  key: string,
): boolean =>
  purpose === 'oncall'
    ? ['answered', 'escalated'].includes(state.questions[key]?.status ?? '')
    : ['merged', 'rework', 'needs_attention', 'failed', 'skipped'].includes(
        state.workItems[key]?.status ?? '',
      );

export const decideOnDemand = (
  state: WorkflowState,
  command: OnDemandCommand,
): DecideResult => {
  const workflow = runningWorkflow(state, {
    dispatch: command.type === 'StartOnDemand',
  });
  if (isDomainError(workflow)) return failed(workflow);
  const p =
    command.type === 'StartOnDemand'
      ? command.instance
      : command.type === 'StopOnDemand'
        ? command.stop
        : command.type === 'UpdateOnDemandQueue'
          ? command.update
          : command;
  const stage = state.stages[p.stageId];
  if (!stage)
    return reject('validation', 'unknown_stage', 'Unknown on-demand stage');
  const instance = state.ondemand[p.stageId]?.[p.purpose];
  const scope = { workflowId: workflow.id, stageId: stage.id };
  if (command.type === 'StopOnDemand') {
    const stop = command.stop;
    if (!instance || instance.attemptId !== stop.attemptId)
      return reject('conflict', 'stale_ondemand', 'Instance is not current');
    if (instance.stopped) return accept();
    const attempt = state.attempts[stop.attemptId];
    if (
      attempt &&
      (stop.reason === 'failed'
        ? isAttemptAlive(attempt)
        : isAttemptPossiblyAlive(attempt))
    )
      return reject(
        'conflict',
        'attempt_alive',
        'Confirm the instance stopped before recording shutdown',
      );
    if (
      stop.reason === 'queue_empty' &&
      (instance.queue.length || instance.current)
    )
      return reject(
        'conflict',
        'queue_not_empty',
        'The on-demand queue still has work',
      );
    return accept(draft(command.meta, scope, 'ondemand.stopped', stop));
  }
  if (stage.kind !== 'implement' || stage.status !== 'running')
    return reject(
      'conflict',
      'stage_not_running',
      'On-demand work requires a running implementation stage',
    );
  if (command.type === 'StartOnDemand') {
    const attempt = state.attempts[command.instance.attemptId];
    if (
      !attempt ||
      !isAttemptAlive(attempt) ||
      attempt.stageId !== stage.id ||
      attempt.stageAttempt !== stage.attempt ||
      attempt.ondemand?.purpose !== p.purpose ||
      !attempt.keepOpen
    )
      return reject(
        'conflict',
        'not_allowed',
        'Start requires the live keep-open attempt for this purpose',
      );
    if (instance?.attemptId === attempt.attemptId && !instance.stopped)
      return accept();
    if (
      Object.values(state.attempts).some(
        (a) =>
          a.attemptId !== attempt.attemptId &&
          a.stageId === stage.id &&
          a.ondemand?.purpose === p.purpose &&
          isAttemptAlive(a),
      )
    )
      return reject(
        'conflict',
        'ondemand_alive',
        'Only one live instance per stage and purpose',
      );
    if (!instance?.queue.length && !instance?.current)
      return reject('conflict', 'queue_empty', 'Start only for queued work');
    return accept(
      draft(command.meta, scope, 'ondemand.started', command.instance),
    );
  }
  if (command.type === 'UpdateOnDemandQueue') {
    const update = command.update;
    if (
      new Set(update.queue).size !== update.queue.length ||
      (update.current !== undefined && update.queue.includes(update.current))
    )
      return reject(
        'validation',
        'invalid_queue',
        'Queue entries and current must be unique',
      );
    for (const key of [
      ...update.queue,
      ...(update.current === undefined ? [] : [update.current]),
    ]) {
      const question = state.questions[key];
      const item = state.workItems[key];
      if (
        p.purpose === 'oncall'
          ? !question ||
            state.attempts[question.attemptId]?.stageId !== stage.id ||
            resolved(state, p.purpose, key)
          : !item || !['merge_queued', 'in_review'].includes(item.status)
      )
        return reject(
          'validation',
          'invalid_queue_entry',
          'Queue entries must be pending work of this stage and purpose',
        );
    }
    const old = instance?.current;
    const previousAttempt = instance?.deliveries?.[old ?? '']?.attemptId;
    const failedPrevious =
      previousAttempt !== undefined &&
      !isAttemptAlive(state.attempts[previousAttempt]!);
    if (
      old &&
      !resolved(state, p.purpose, old) &&
      update.current !== old &&
      !(failedPrevious && update.queue.includes(old))
    )
      return reject(
        'conflict',
        'current_unresolved',
        'Finish or requeue the current entry before assigning another',
      );
    if (update.current !== undefined) {
      const attempt = state.attempts[instance?.attemptId ?? ''];
      if (!attempt || !isAttemptAlive(attempt) || instance?.stopped)
        return reject(
          'conflict',
          'ondemand_not_running',
          'A live instance is required to take work',
        );
      const delivery = instance?.deliveries?.[update.current];
      if (
        delivery?.attemptId === attempt.attemptId &&
        instance?.current !== update.current
      )
        return reject(
          'conflict',
          'replacement_required',
          'A failed entry must be retried by a replacement instance',
        );
      if (
        delivery &&
        delivery.attemptId !== attempt.attemptId &&
        !canRetryOnDemand(
          state.attempts[delivery.attemptId],
          delivery.retries + 1,
        )
      )
        return reject(
          'conflict',
          'ondemand_retry_limit',
          'An entry can be retried once after its instance exits or is lost',
        );
      if (old && old !== update.current && !resolved(state, p.purpose, old))
        return reject(
          'conflict',
          'current_unresolved',
          'Only one entry may be processed at a time',
        );
      if (old !== update.current && instance?.queue[0] !== update.current)
        return reject(
          'conflict',
          'queue_order',
          'Process the first queued entry',
        );
    }
    const events = [
      draft(command.meta, scope, 'ondemand.queue_changed', update),
    ];
    if (
      p.purpose === 'merge' &&
      update.current &&
      state.workItems[update.current]?.status === 'merge_queued'
    )
      events.push(
        draft(command.meta, scope, 'workitem.status', {
          itemKey: update.current,
          status: 'in_review',
        }),
      );
    return accept(...events);
  }
  const attempt = state.attempts[command.attemptId];
  if (
    !instance ||
    instance.stopped ||
    instance.attemptId !== command.attemptId ||
    instance.current !== command.current ||
    !attempt ||
    resolved(state, p.purpose, command.current)
  )
    return reject(
      'conflict',
      'stale_ondemand',
      'Timeout does not belong to the current entry',
    );
  const reason = p.purpose === 'oncall' ? 'question-timeout' : 'review-timeout';
  const delivery = instance.deliveries?.[command.current];
  const alive = isAttemptAlive(attempt);
  if (
    alive &&
    !attempt.nudges.some(
      (n) => n.reason === reason && n.subject === command.current,
    )
  )
    return accept(
      draft(
        command.meta,
        { ...scope, attemptId: attempt.attemptId },
        'message.nudge',
        {
          attemptId: attempt.attemptId,
          reason,
          subject: command.current,
          body: 'Please finish the current queue entry',
        },
      ),
    );
  // Merge review failure gets one replacement, including a timed-out live instance.
  // Engine must stop that instance before it can assign the requeued entry.
  if (p.purpose === 'merge' && (delivery?.retries ?? 0) === 0)
    return accept(
      draft(command.meta, scope, 'ondemand.queue_changed', {
        stageId: stage.id,
        purpose: p.purpose,
        queue: [command.current, ...instance.queue],
      }),
    );
  if (!alive && p.purpose === 'oncall' && (delivery?.retries ?? 0) === 0)
    return accept(
      draft(command.meta, scope, 'ondemand.queue_changed', {
        stageId: stage.id,
        purpose: p.purpose,
        queue: [command.current, ...instance.queue],
      }),
    );
  const cleared = draft(command.meta, scope, 'ondemand.queue_changed', {
    stageId: stage.id,
    purpose: p.purpose,
    queue: instance.queue,
  });
  if (p.purpose === 'oncall') {
    if (state.gates[command.gateId])
      return reject('conflict', 'duplicate_gate', 'Gate id already exists');
    return accept(
      draft(command.meta, scope, 'message.escalated', {
        questionId: command.current,
        reason: alive ? 'timeout' : 'oncall-failed',
        gateId: command.gateId,
      }),
      draft(command.meta, scope, 'gate.opened', {
        gateId: command.gateId,
        stageId: stage.id,
        kind: 'exception',
        exceptionKind: 'question-escalation',
        title: 'Question needs an answer',
        options: [],
        version: 1,
        content: {
          type: 'exception',
          summary: 'On-demand question failed',
          questionId: command.current,
        },
      }),
      cleared,
    );
  }
  const gate = workItemException(
    state,
    command.meta,
    command.gateId,
    'merge-review-failed',
    command.current,
    'Merge review failed',
  );
  if (!gate.ok) return gate;
  return accept(
    draft(command.meta, scope, 'workitem.status', {
      itemKey: command.current,
      status: 'needs_attention',
      reason: 'merge-review-failed',
    }),
    ...gate.events,
    cleared,
  );
};
