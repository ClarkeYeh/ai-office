import type { ReactContext } from '../context.js';
import { commandId, metaFor } from '../context.js';
import { external, internal } from '../effects.js';
import type { Effect } from '../effects.js';
import { cancelTimer, MINUTE_MS, schedule } from '../timers.js';

/** Only persisted acceptance can authorize a merge; application owns synchronous waiting. */
export const reactMergeSubmission = (
  ctx: ReactContext,
  stageId: string,
): Effect[] => {
  const event = ctx.event;
  const config = ctx.state.workflow?.template.stages.find(
    (s) => s.id === stageId,
  );
  if (config?.kind !== 'implement') return [];
  const instance = ctx.state.ondemand[stageId]?.merge;
  const key = instance?.current;
  const item = ctx.state.workItems[key ?? ''];
  if (!instance || !key || !item) return [];
  if (
    event.type === 'submission.accepted' &&
    event.payload.attemptId === instance.attemptId
  ) {
    const { submission, submissionId } = event.payload;
    if (
      submission.kind === 'merge-request' &&
      submission.payload.pr === item.pr
    ) {
      return [
        ...Object.values(ctx.state.timers)
          .filter(
            (t) =>
              t.payload.purpose === 'review-timeout' &&
              t.payload.itemKey === key,
          )
          .map((t) => cancelTimer(t.id, 'merge_pending')),
        external(
          commandId(ctx, 'ondemand', 'merge', submissionId),
          {
            kind: 'scm.mergePR',
            args: {
              pr: { repo: ctx.state.workflow!.repo.github, number: item.pr },
              method: 'merge',
              expectedHeadSha: submission.payload.expectedHeadSha,
            },
          },
          { stageId, attemptId: instance.attemptId },
        ),
      ];
    }
    if (submission.kind === 'rework-request')
      return [
        internal({
          type: 'RequestWorkItemRework',
          meta: metaFor(ctx),
          submissionId,
          gateId: commandId(ctx, 'gate', 'rework', submissionId),
        }),
      ];
    if (
      submission.kind === 'decision-request' &&
      !submission.payload.questionId
    )
      return [
        internal({
          type: 'UpdateWorkItemStatus',
          meta: metaFor(ctx),
          update: {
            itemKey: key,
            status: 'needs_attention',
            reason: submission.payload.reason,
          },
        }),
        internal({
          type: 'OpenGate',
          meta: metaFor(ctx),
          noLiveAttempts: false,
          gate: {
            kind: 'exception',
            gateId: commandId(ctx, 'gate', 'merge', submissionId),
            stageId,
            exceptionKind: 'merge-blocked',
            title: 'Merge needs a decision',
            options: ['retry', 'reassign', 'skip', 'abort'].map((optionId) => ({
              optionId,
              label: optionId,
              ...(optionId === 'reassign' ? { input: 'agent' as const } : {}),
            })),
            content: {
              type: 'exception',
              itemKey: key,
              summary: submission.payload.question,
            },
          },
        }),
      ];
  }
  if (
    event.type === 'command.succeeded' &&
    event.payload.kind === 'scm.mergePR'
  ) {
    const record = ctx.state.commands[event.payload.commandId];
    if (
      record &&
      record.attemptId === instance.attemptId &&
      record.issued.kind === 'scm.mergePR' &&
      record.issued.args.pr.number === item.pr
    )
      return [
        internal({
          type: 'MarkWorkItemMerged',
          meta: metaFor(ctx),
          merged: {
            itemKey: key,
            pr: item.pr,
            mergeCommitSha: event.payload.result.mergeCommitSha,
            commandId: event.payload.commandId,
          },
        }),
      ];
  }
  if (event.type === 'command.failed' && event.payload.kind === 'scm.mergePR') {
    const record = ctx.state.commands[event.payload.commandId];
    const agent = ctx.state.attempts[instance.attemptId ?? '']?.agentRef;
    if (record && record.attemptId === instance.attemptId && agent)
      return [
        schedule(
          ctx,
          {
            purpose: 'review-timeout',
            itemKey: key,
            attemptId: instance.attemptId!,
          },
          config.mergeQueue.reviewTimeoutMin * MINUTE_MS,
          event.id,
        ),
        external(
          commandId(ctx, 'ondemand', 'merge-failed', event.payload.commandId),
          {
            kind: 'runtime.send',
            args: {
              agent,
              subject: `Review ${key}`,
              body: `Merge failed (${event.payload.error.code}). Resolve the worker branch, verify it, and submit merge-request with its new head SHA, or request a decision.`,
            },
          },
          { stageId, attemptId: instance.attemptId },
        ),
      ];
  }
  return [];
};

export const reviewBody = (ctx: ReactContext, key: string): string => {
  const item = ctx.state.workItems[key]!;
  const workflow = ctx.state.workflow!;
  // Commands retain issuance order, and this queue serializes successful merges.
  // Prefer the last confirmed merge/workspace head, never work-item key order.
  const head =
    Object.values(ctx.state.commands)
      .flatMap((record) => {
        const result = record.result;
        if (!result?.result) return [];
        if (result?.kind === 'scm.mergePR' && 'mergeCommitSha' in result.result)
          return [result.result.mergeCommitSha];
        if (
          result?.kind === 'runtime.prepareWorkspace' &&
          'baseSha' in result.result &&
          result.result.baseSha
        )
          return [result.result.baseSha];
        return [];
      })
      .at(-1) ?? item.baseSha;
  return JSON.stringify({
    itemKey: key,
    pr: item.pr,
    headSha: item.headSha,
    title: item.title,
    body: item.body,
    acceptance: item.acceptance,
    deps: item.deps,
    baseSha: item.baseSha,
    integrationBranch: workflow.integrationBranch,
    integrationHead: head,
  });
};
