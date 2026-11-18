import { canRetryOnDemand } from './ondemand.js';
import type { QuestionCommand } from '../commands.js';
import { accept, reject } from '../errors.js';
import type { DecideResult } from '../errors.js';
import { isAttemptAlive } from '../state/index.js';
import type { WorkflowState } from '../state/index.js';
import {
  defined,
  draft,
  failed,
  isDomainError,
  runningWorkflow,
} from './support.js';

/** Union waiting intervals: overlapping questions pause an attempt's clock only once. */
export const questionWaitMilliseconds = (
  state: WorkflowState,
  attemptId: string,
  now: string,
): number => suspendedMilliseconds(state, attemptId, now, false);

/**
 * Wallclock an attempt spent suspended: waiting for answers and, with
 * `pauses` (FX8b), in a workflow pause since it spawned. Overlaps count once.
 */
export const suspendedMilliseconds = (
  state: WorkflowState,
  attemptId: string,
  now: string,
  pauses = true,
): number => {
  const end = Date.parse(now);
  const spawned = Date.parse(state.attempts[attemptId]?.spawnedAt ?? '');
  const windows = [
    ...Object.values(state.questions)
      .filter((q) => q.attemptId === attemptId)
      .map((q) => ({ from: q.askedAt, to: q.answeredAt })),
    ...(pauses && Number.isFinite(spawned)
      ? (state.workflow?.pauseWindows ?? []).map((w) => ({
          from: new Date(Math.max(spawned, Date.parse(w.from))).toISOString(),
          to: w.to,
        }))
      : []),
  ];
  const intervals = windows
    .map(
      (w) =>
        [Date.parse(w.from), Math.min(end, Date.parse(w.to ?? now))] as const,
    )
    .filter(
      ([start, stop]) =>
        Number.isFinite(start) && Number.isFinite(stop) && stop > start,
    )
    .sort(([a], [b]) => a - b);
  let total = 0;
  let until = -Infinity;
  for (const [start, stop] of intervals) {
    total += Math.max(0, stop - Math.max(start, until));
    until = Math.max(until, stop);
  }
  return total;
};

export const decideQuestion = (
  state: WorkflowState,
  command: QuestionCommand,
): DecideResult => {
  const workflow = runningWorkflow(state);
  if (isDomainError(workflow)) return failed(workflow);
  const scope = { workflowId: workflow.id };
  const question = state.questions[command.questionId];
  if (command.type === 'AskQuestion') {
    if (question !== undefined)
      return reject(
        'conflict',
        'duplicate_question',
        'Question id already exists',
      );
    const attempt = state.attempts[command.attemptId];
    if (attempt === undefined || !isAttemptAlive(attempt))
      return reject(
        'validation',
        'unknown_live_attempt',
        'Question requires a live attempt',
      );
    if (command.itemKey !== undefined && command.itemKey !== attempt.itemKey)
      return reject(
        'validation',
        'item_key_mismatch',
        'Question must belong to the asking worker',
      );
    return accept(
      draft(
        command.meta,
        {
          ...scope,
          stageId: attempt.stageId,
          attemptId: attempt.attemptId,
          seatId: attempt.seatId,
        },
        'message.question',
        {
          questionId: command.questionId,
          attemptId: command.attemptId,
          body: command.body,
          ...defined({ itemKey: attempt.itemKey }),
        },
      ),
    );
  }
  if (question === undefined)
    return reject('validation', 'unknown_question', 'Question does not exist');
  if (question.status === 'answered')
    return reject('conflict', 'question_answered', 'Question already answered');
  switch (command.type) {
    case 'ForwardQuestion': {
      if (question.status === 'escalated')
        return reject(
          'conflict',
          'question_escalated',
          'Question is awaiting a human answer',
        );
      const responder = state.attempts[command.toAttemptId];
      const asker = state.attempts[question.attemptId];
      if (
        responder === undefined ||
        !isAttemptAlive(responder) ||
        responder.stageId !== asker?.stageId ||
        responder.stageAttempt !== asker?.stageAttempt ||
        responder.purpose !==
          (command.to === 'on-call' ? 'oncall' : 'facilitator')
      )
        return reject(
          'validation',
          'invalid_responder',
          'Responder must be the live on-call or facilitator for this stage attempt',
        );
      if (
        Object.values(state.questions).some(
          (q) =>
            q.id !== question.id &&
            q.status === 'forwarded' &&
            q.forwarded?.toAttemptId === command.toAttemptId,
        )
      )
        return reject(
          'conflict',
          'current_unresolved',
          'Responder must finish the previous question',
        );
      const previous = question.forwarded;
      if (
        command.retry !== (previous === undefined ? 0 : previous.retry + 1) ||
        command.retry > 1
      )
        return reject(
          'conflict',
          'question_retry_limit',
          'Each question can be requeued once',
        );
      if (previous !== undefined) {
        const old = state.attempts[previous.toAttemptId];
        if (!canRetryOnDemand(old, command.retry))
          return reject(
            'conflict',
            'responder_not_failed',
            'Requeue only after the previous responder exits or is lost',
          );
      }
      return accept(
        draft(command.meta, scope, 'message.forwarded', {
          questionId: question.id,
          to: command.to,
          toAttemptId: command.toAttemptId,
          retry: command.retry,
        }),
      );
    }
    case 'AnswerQuestion':
      if (
        command.by === 'agent' &&
        (question.status !== 'forwarded' ||
          command.attemptId !== question.forwarded?.toAttemptId ||
          command.attemptId === undefined ||
          state.attempts[command.attemptId] === undefined ||
          !isAttemptAlive(state.attempts[command.attemptId]!))
      )
        return reject(
          'conflict',
          'invalid_answerer',
          'Only the assigned live responder can answer',
        );
      if (command.by === 'user' && question.status !== 'escalated')
        return reject(
          'conflict',
          'question_not_escalated',
          'Human answers require escalation',
        );
      if (
        command.by === 'user' &&
        command.gateId !== question.escalation?.gateId
      )
        return reject(
          'conflict',
          'wrong_question_gate',
          'Answer must reference the escalation gate',
        );
      return accept(
        draft(command.meta, scope, 'message.answered', {
          questionId: question.id,
          by: command.by,
          body: command.body,
          ...defined({
            attemptId: command.attemptId,
            gateId: command.gateId,
            optionId: command.optionId,
          }),
        }),
      );
    case 'EscalateQuestion':
      if (question.status === 'escalated') return accept();
      if (
        command.reason === 'oncall-failed' &&
        (question.forwarded?.retry !== 1 ||
          (state.attempts[question.forwarded.toAttemptId]?.state !== 'exited' &&
            state.attempts[question.forwarded.toAttemptId]?.state !== 'lost'))
      )
        return reject(
          'conflict',
          'question_retry_available',
          'Retry the question once before escalating a failed on-call',
        );
      return accept(
        draft(command.meta, scope, 'message.escalated', {
          questionId: question.id,
          reason: command.reason,
          gateId: command.gateId,
        }),
      );
  }
};
