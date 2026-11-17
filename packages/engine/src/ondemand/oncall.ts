import { commandId, metaFor } from '../context.js';
import type { ReactContext } from '../context.js';
import { external, internal } from '../effects.js';
import type { Effect } from '../effects.js';

export const escalateQuestion = (
  ctx: ReactContext,
  stageId: string,
  questionId: string,
  reason: 'decision-request' | 'no-responder',
  summary: string,
): Effect[] => {
  const gateId = commandId(ctx, 'gate', 'question', questionId);
  return [
    internal({
      type: 'EscalateQuestion',
      meta: metaFor(ctx),
      questionId,
      reason,
      gateId,
    }),
    internal({
      type: 'OpenGate',
      meta: metaFor(ctx),
      noLiveAttempts: false,
      gate: {
        kind: 'exception',
        gateId,
        stageId,
        exceptionKind: 'question-escalation',
        title: 'Question needs an answer',
        options: [],
        content: { type: 'exception', questionId, summary },
      },
    }),
  ];
};

export const reactOncallSubmission = (
  ctx: ReactContext,
  stageId: string,
): Effect[] => {
  const event = ctx.event;
  if (event.type === 'message.answered') {
    const question = ctx.state.questions[event.payload.questionId];
    if (ctx.state.attempts[question?.attemptId ?? '']?.stageId !== stageId)
      return [];
    return [
      external(
        commandId(ctx, 'answer', event.payload.questionId),
        {
          kind: 'runtime.answer',
          args: {
            question: event.payload.questionId,
            body: event.payload.body,
          },
        },
        { stageId },
      ),
    ];
  }
  if (event.type !== 'submission.accepted') return [];
  const instance = ctx.state.ondemand[stageId]?.oncall;
  const { submission, attemptId } = event.payload;
  if (!instance || instance.attemptId !== attemptId || !instance.current)
    return [];
  if (
    submission.kind === 'answer-question' &&
    submission.payload.questionId === instance.current
  )
    return [
      internal({
        type: 'AnswerQuestion',
        meta: metaFor(ctx),
        questionId: instance.current,
        by: 'agent',
        body: submission.payload.body,
        attemptId,
      }),
    ];
  if (
    submission.kind === 'decision-request' &&
    submission.payload.questionId === instance.current
  )
    return escalateQuestion(
      ctx,
      stageId,
      instance.current,
      'decision-request',
      submission.payload.question,
    );
  return [];
};
