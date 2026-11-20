import { EXCEPTION_OPTIONS } from '@ai-office/domain';
import type { ReactContext } from '../context.js';
import { commandId, metaFor } from '../context.js';
import { external, internal } from '../effects.js';
import type { Effect } from '../effects.js';
import { cancelTimer, MINUTE_MS, schedule } from '../timers.js';

/** EP1: two `base_moved` in a row on one PR open the merge-review-failed gate. */
export const MAX_BASE_MOVED = 2;

/**
 * The integration head sent in the latest review message for `key` (§7.4):
 * the merge must find the integration branch still there (`expectedBaseSha`).
 */
const sentIntegrationHead = (
  ctx: ReactContext,
  attemptId: string,
  key: string,
): string | undefined =>
  Object.values(ctx.state.commands)
    .flatMap(({ issued, attemptId: by }) => {
      if (
        by !== attemptId ||
        issued.kind !== 'runtime.send' ||
        issued.args.subject !== key
      )
        return [];
      try {
        const body: unknown = JSON.parse(issued.args.body);
        return typeof body === 'object' &&
          body !== null &&
          'integrationHead' in body &&
          typeof body.integrationHead === 'string'
          ? [body.integrationHead]
          : [];
      } catch {
        return []; // nudges and failure notes are plain text
      }
    })
    .at(-1);

/** Trailing `base_moved` failures of this PR's merge commands, oldest first. */
const baseMovedRun = (ctx: ReactContext, pr: number): number => {
  const merges = Object.values(ctx.state.commands).filter(
    ({ issued }) =>
      issued.kind === 'scm.mergePR' && issued.args.pr.number === pr,
  );
  let run = 0;
  for (const record of merges.reverse()) {
    if (record.status !== 'failed' || record.error?.code !== 'base_moved')
      break;
    run++;
  }
  return run;
};

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
      const expectedBaseSha = sentIntegrationHead(
        ctx,
        instance.attemptId!,
        key,
      );
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
              // S20: merge only into our recorded base; a retargeted PR fails.
              expectedBase: ctx.state.workflow!.integrationBranch,
              ...(expectedBaseSha === undefined ? {} : { expectedBaseSha }),
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
    const ours =
      record !== undefined &&
      record.attemptId === instance.attemptId &&
      item.pr !== undefined;
    // The PR base was retargeted mid-merge: an outside actor, so a high anomaly.
    if (ours && event.payload.error.code === 'merge_base_changed')
      return [
        internal({
          type: 'EvaluateAnomaly',
          meta: metaFor(ctx),
          observation: {
            kind: 'merge-base-changed',
            commandId: event.payload.commandId,
            pr: item.pr!,
          },
        }),
      ];
    // The integration branch moved since the review: not the worker's fault,
    // so no rework. Re-read its head and send the same PR for review again.
    if (ours && event.payload.error.code === 'base_moved')
      return baseMovedRun(ctx, item.pr!) >= MAX_BASE_MOVED
        ? reviewFailed(ctx, stageId, key, event.payload.commandId)
        : [
            external(
              commandId(ctx, 'ondemand', 'rebase', event.payload.commandId),
              {
                kind: 'scm.compareBranch',
                args: {
                  repo: ctx.state.workflow!.repo.github,
                  base: ctx.state.workflow!.integrationBranch,
                  head: ctx.state.workflow!.integrationBranch,
                },
              },
              { stageId, attemptId: instance.attemptId },
            ),
          ];
    if (ours && agent)
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
  if (
    event.type === 'command.succeeded' &&
    event.payload.kind === 'scm.compareBranch' &&
    event.payload.commandId.startsWith(
      `${commandId(ctx, 'ondemand', 'rebase')}/`,
    ) &&
    ctx.state.commands[event.payload.commandId]?.attemptId ===
      instance.attemptId
  ) {
    const agent = ctx.state.attempts[instance.attemptId ?? '']?.agentRef;
    if (!event.payload.result)
      return reviewFailed(ctx, stageId, key, event.payload.commandId);
    if (!agent) return [];
    return [
      external(
        commandId(ctx, 'ondemand', 'rebase-send', event.payload.commandId),
        {
          kind: 'runtime.send',
          args: { agent, subject: key, body: reviewBody(ctx, key) },
        },
        { stageId, attemptId: instance.attemptId },
      ),
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
    ];
  }
  return [];
};

/** The merge-review-failed exception gate for the current queue entry. */
const reviewFailed = (
  ctx: ReactContext,
  stageId: string,
  key: string,
  causeId: string,
): Effect[] => [
  internal({
    type: 'UpdateWorkItemStatus',
    meta: metaFor(ctx),
    update: {
      itemKey: key,
      status: 'needs_attention',
      reason: 'merge-review-failed',
    },
  }),
  internal({
    type: 'OpenGate',
    meta: metaFor(ctx),
    noLiveAttempts: false,
    gate: {
      kind: 'exception',
      gateId: commandId(ctx, 'gate', 'base-moved', causeId),
      stageId,
      exceptionKind: 'merge-review-failed',
      title: 'Merge queue review failed',
      options: EXCEPTION_OPTIONS['merge-review-failed'].map((optionId) => ({
        optionId,
        label: optionId,
      })),
      content: {
        type: 'exception',
        itemKey: key,
        commandId: causeId,
        summary: 'The integration branch kept moving during merge review',
      },
    },
  }),
];

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
          result?.kind === 'scm.compareBranch' &&
          record.issued.kind === 'scm.compareBranch' &&
          record.issued.args.base === workflow.integrationBranch &&
          record.issued.args.head === workflow.integrationBranch &&
          'headSha' in result.result
        )
          return [result.result.headSha];
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
