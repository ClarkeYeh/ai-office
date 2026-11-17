import { seatIdFor } from '@ai-office/contracts/events';
import type { DomainEvent, EventPayload } from '@ai-office/contracts/events';
import {
  decide,
  dependencyOrder,
  isAttemptPossiblyAlive,
  possiblyLiveAttempts,
  workerBranchName,
} from '@ai-office/domain';
import type { WorkItem, WorkflowState } from '@ai-office/domain';
import { releaseAttempt, stopAttempt } from '../agents.js';
import { commandId, metaFor, sessionRef } from '../context.js';
import type { ReactContext } from '../context.js';
import { external, internal } from '../effects.js';
import type { Effect } from '../effects.js';
import { cancelNudge, escalateNudge, sendNudge } from '../protocols/nudge.js';
import { cancelTimer, MINUTE_MS, schedule } from '../timers.js';
import { stageTimers } from './meeting.js';
import type { StageModule } from './types.js';

const itemId = (
  ctx: ReactContext,
  item: WorkItem,
  phase: string,
  attempt = item.attempt,
): string => commandId(ctx, 'implement', item.key, attempt, phase);
const baseId = (ctx: ReactContext, item: WorkItem): string => {
  const gate = ctx.state.gates[item.statusReason ?? ''];
  return (
    itemId(ctx, item, 'base', item.attempt + 1) +
    (gate?.decision ? '/after/' + gate.gateId : '')
  );
};
const attemptId = (ctx: ReactContext, item: WorkItem): string =>
  itemId(ctx, item, 'attempt', item.attempt + 1);
const update = (
  ctx: ReactContext,
  item: WorkItem,
  status: WorkItem['status'],
  extra: Partial<EventPayload<'workitem.status'>> = {},
): Effect =>
  internal({
    type: 'UpdateWorkItemStatus',
    meta: metaFor(ctx),
    update: {
      itemKey: item.key,
      status,
      ...(item.currentAttemptId ? { attemptId: item.currentAttemptId } : {}),
      ...extra,
    },
  });
const itemTimers = (ctx: ReactContext, item: WorkItem): Effect[] =>
  Object.values(ctx.state.timers)
    .filter(
      (t) =>
        'attemptId' in t.payload &&
        t.payload.attemptId === item.currentAttemptId &&
        ['item-timeout', 'nudge-grace'].includes(t.payload.purpose),
    )
    .map((t) => cancelTimer(t.id, 'worker_finished'));
const openItemGate = (ctx: ReactContext, item: WorkItem): boolean =>
  Object.values(ctx.state.gates).some(
    (g) =>
      g.status === 'open' &&
      g.content.type === 'exception' &&
      g.content.itemKey === item.key,
  );

/** Dispatch readiness is delegated to domain, including transitive dependency waivers. */
const dispatchCommand = (
  ctx: ReactContext,
  item: WorkItem,
  baseSha?: string,
) => {
  const decision = Object.values(ctx.state.gates)
    .filter(
      (g) =>
        g.content.type === 'exception' &&
        g.content.itemKey === item.key &&
        (g.content.attemptId === item.currentAttemptId ||
          g.gateId === item.statusReason),
    )
    .at(-1)?.decision;
  return {
    type: 'DispatchWorkItem' as const,
    meta: metaFor(ctx),
    itemKey: item.key,
    attemptId: attemptId(ctx, item),
    ...(baseSha ? { baseSha } : {}),
    ...(decision?.agent ? { agent: decision.agent } : {}),
  };
};

const failItem = (
  ctx: ReactContext,
  item: WorkItem,
  summary: string,
): Effect[] => {
  const attempt =
    item.currentAttemptId && ctx.state.attempts[item.currentAttemptId];
  if (openItemGate(ctx, item)) return [];
  if (!attempt) {
    const gateId = itemId(ctx, item, 'setup-failed-' + ctx.event.seq);
    return [
      update(
        ctx,
        item,
        item.status === 'approved' ? 'failed' : 'needs_attention',
        { reason: gateId },
      ),
      internal({
        type: 'OpenGate',
        meta: metaFor(ctx),
        noLiveAttempts: false,
        gate: {
          kind: 'exception',
          gateId,
          stageId: ctx.state.workflow!.template.stages.find(
            (s) => s.kind === 'implement',
          )!.id,
          exceptionKind: 'workitem-failed',
          title: 'Worker setup failed',
          options: [
            { optionId: 'retry', label: 'Retry' },
            { optionId: 'reassign', label: 'Reassign', input: 'agent' },
            { optionId: 'skip', label: 'Skip' },
            { optionId: 'abort', label: 'Abort' },
          ],
          content: { type: 'exception', itemKey: item.key, summary },
        },
      }),
    ];
  }
  return [
    ...itemTimers(ctx, item),
    update(ctx, item, 'needs_attention', { reason: summary }),
    ...escalateNudge(ctx, attempt.attemptId, 'item-timeout', {
      exceptionKind: 'workitem-failed',
      title: 'Worker needs attention',
      summary,
      itemKey: item.key,
      options: [
        { optionId: 'retry', label: 'Retry' },
        { optionId: 'reassign', label: 'Reassign', input: 'agent' },
        { optionId: 'skip', label: 'Skip' },
        { optionId: 'abort', label: 'Abort' },
      ],
    }),
  ];
};
const nudge = (ctx: ReactContext, item: WorkItem): Effect[] => {
  const a = item.currentAttemptId && ctx.state.attempts[item.currentAttemptId];
  if (!a) return [];
  if (!isAttemptPossiblyAlive(a) || a.state === 'lost')
    return failItem(
      ctx,
      item,
      'Worker exited before completing a pushed branch',
    );
  return sendNudge(ctx, {
    attemptId: a.attemptId,
    reason: 'item-timeout',
    subject: 'Finish and push the worker branch',
    body: 'Push at least one commit to your worker branch and report successful completion within five minutes.',
  });
};

/** Only compare commands reserve slots before workitem.dispatched is persisted. */
const scheduleReady = (
  ctx: ReactContext,
  stageId: string,
  maxParallel: number,
): Effect[] => {
  const workflow = ctx.state.workflow!;
  if (!sessionRef(ctx.state)) return [];
  const items = dependencyOrder(
    ctx.state.workItemOrder.map((k) => ctx.state.workItems[k]!),
  );
  const pending = items.filter(
    (i) => ctx.state.commands[baseId(ctx, i)] !== undefined,
  );
  const active = items.filter((i) =>
    ['dispatched', 'in_progress'].includes(i.status),
  );
  const preparing = active.filter(
    (i) => !i.currentAttemptId || !ctx.state.attempts[i.currentAttemptId],
  );
  let slots = Math.min(
    maxParallel - active.length - pending.length,
    workflow.limits.globalAgents -
      possiblyLiveAttempts(ctx.state).length -
      preparing.length -
      pending.length,
  );
  const effects: Effect[] = [];
  for (const item of items) {
    if (
      ['approved', 'failed', 'needs_attention', 'rework'].includes(
        item.status,
      ) &&
      !openItemGate(ctx, item)
    ) {
      const check = {
        type: 'EvaluateWorkItemDependencies' as const,
        meta: metaFor(ctx),
        itemKey: item.key,
        gateId: itemId(ctx, item, `dependency-${ctx.event.seq}`),
      };
      const result = decide(ctx.state, check);
      if (result.ok && result.events.length) {
        effects.push(internal(check));
        continue;
      }
    }
    const config = workflow.template.stages.find((s) => s.id === stageId);
    if (
      item.status === 'rework' &&
      config?.kind === 'implement' &&
      (item.rework ?? 0) >
        (config.mergeQueue.maxRework ?? workflow.template.defaults.maxReruns) &&
      ctx.state.gates[item.statusReason ?? '']?.decision?.optionId !== 'rework'
    )
      continue;
    const retry = Object.values(ctx.state.gates).some(
      (g) =>
        g.content.type === 'exception' &&
        g.content.itemKey === item.key &&
        (g.content.attemptId === item.currentAttemptId ||
          g.gateId === item.statusReason) &&
        ['retry', 'reassign', 'top-up-rerun'].includes(
          g.decision?.optionId ?? '',
        ),
    );
    if (
      slots <= 0 ||
      pending.includes(item) ||
      (!['approved', 'rework'].includes(item.status) &&
        !(retry && ['failed', 'needs_attention'].includes(item.status))) ||
      !decide(ctx.state, dispatchCommand(ctx, item)).ok
    )
      continue;
    // The request and its response are recorded; never read a moving remote in a pure reducer.
    const head =
      item.status === 'rework' ? item.branch! : workflow.integrationBranch;
    effects.push(
      external(
        baseId(ctx, item),
        {
          kind: 'scm.compareBranch',
          args: { repo: workflow.repo.github, base: head, head },
        },
        { stageId, attemptId: attemptId(ctx, item) },
      ),
    );
    slots--;
  }
  return effects;
};

const reactImplement: StageModule['react'] = (ctx) => {
  const workflow = ctx.state.workflow;
  const config = workflow?.template.stages.find((s) => s.kind === 'implement');
  if (!workflow || config?.kind !== 'implement') return [];
  const stage = ctx.state.stages[config.id]!;
  if (
    stage.status !== 'running' ||
    workflow.cancelRequested ||
    workflow.pausedReasons.length
  )
    return [];
  const event = ctx.event;
  const items = Object.values(ctx.state.workItems);

  if (event.type === 'workflow.resumed') {
    const recovered: Effect[] = [];
    for (const item of items) {
      if (openItemGate(ctx, item)) continue;
      const phase =
        item.status === 'dispatched'
          ? ctx.state.attempts[item.currentAttemptId!]
            ? 'spawn'
            : 'prepare'
          : item.status === 'pushed'
            ? 'pr'
            : undefined;
      const record =
        ctx.state.commands[
          phase ? itemId(ctx, item, phase) : baseId(ctx, item)
        ];
      if (
        record?.result &&
        (phase ||
          ['approved', 'rework', 'failed', 'needs_attention'].includes(
            item.status,
          ))
      ) {
        recovered.push(
          ...reactImplement({
            ...ctx,
            event: {
              ...event,
              type: 'command.succeeded',
              payload: { ...record.result, commandId: record.id },
            } as DomainEvent,
          }),
        );
      } else if (
        record?.error &&
        (phase ||
          ['approved', 'rework', 'failed', 'needs_attention'].includes(
            item.status,
          ))
      ) {
        recovered.push(
          ...reactImplement({
            ...ctx,
            event: {
              ...event,
              type: 'command.failed',
              payload: {
                commandId: record.id,
                kind: record.issued.kind,
                error: record.error,
                attempts: record.failedAttempts ?? 1,
              },
            },
          }),
        );
      } else if (['pushed', 'pr_open'].includes(item.status)) {
        recovered.push(
          ...reactImplement({
            ...ctx,
            event: {
              ...event,
              type: 'workitem.status',
              payload: { itemKey: item.key, status: item.status },
            },
          }),
        );
      } else if (item.status === 'in_progress') {
        const a = ctx.state.attempts[item.currentAttemptId!]!;
        if (['done', 'error', 'lost', 'exited'].includes(a.state))
          recovered.push(
            ...reactImplement({
              ...ctx,
              event: {
                ...event,
                type: 'seat.status',
                payload: { attemptId: a.attemptId, state: a.state },
              },
            }),
          );
        else if (
          !Object.values(ctx.state.timers).some(
            (t) =>
              'attemptId' in t.payload && t.payload.attemptId === a.attemptId,
          )
        )
          recovered.push(
            schedule(
              ctx,
              {
                purpose: 'item-timeout',
                itemKey: item.key,
                attemptId: a.attemptId,
              },
              0,
              event.seq,
            ),
          );
      }
    }
    if (recovered.length) return recovered;
  }

  if (event.type === 'workitem.dispatched') {
    const item = ctx.state.workItems[event.payload.itemKey]!;
    const rework = item.reworkOf !== undefined;
    return [
      external(
        itemId(ctx, item, 'prepare'),
        {
          kind: 'runtime.prepareWorkspace',
          args: {
            session: sessionRef(ctx.state)!,
            repo: {
              orcaRepoId: workflow.repo.orcaRepoId,
              localPath: workflow.repo.localPath,
            },
            baseBranch: item.baseSha!,
            fetchBranch: rework ? item.branch! : workflow.integrationBranch,
            name: rework
              ? `${item.workspaceName!}-r${item.rework!}`
              : item.workspaceName!,
            branch: rework
              ? item.branch!
              : workerBranchName(workflow.shortId, item.key, item.attempt),
            ...(rework ? { checkoutExisting: true } : {}),
          },
        },
        { stageId: config.id, attemptId: item.currentAttemptId! },
      ),
    ];
  }
  if (event.type === 'command.failed') {
    const item = items.find(
      (i) =>
        event.payload.commandId === baseId(ctx, i) ||
        (i.currentAttemptId &&
          ctx.state.commands[event.payload.commandId]?.attemptId ===
            i.currentAttemptId),
    );
    if (
      item &&
      ['approved', 'rework', 'dispatched', 'in_progress', 'pushed'].includes(
        item.status,
      )
    )
      return failItem(ctx, item, event.payload.error.message);
  }
  if (event.type === 'command.succeeded') {
    const p = event.payload;
    const item = items.find(
      (i) =>
        p.commandId === baseId(ctx, i) ||
        (i.currentAttemptId &&
          ctx.state.commands[p.commandId]?.attemptId === i.currentAttemptId),
    );
    if (
      item &&
      p.kind === 'scm.compareBranch' &&
      p.commandId === baseId(ctx, item)
    ) {
      if (!p.result)
        return failItem(ctx, item, 'Remote dispatch base is missing');
      return [internal(dispatchCommand(ctx, item, p.result.headSha))];
    }
    if (
      item &&
      p.kind === 'runtime.prepareWorkspace' &&
      p.commandId === itemId(ctx, item, 'prepare')
    ) {
      const id = item.currentAttemptId!;
      const spawnId = itemId(ctx, item, 'spawn');
      return [
        internal({
          type: 'SpawnAttempt',
          meta: metaFor(ctx),
          stageId: config.id,
          role: item.role,
          itemKey: item.key,
          attemptId: id,
          purpose: 'worker',
          keepOpen: true,
          spawnCommandId: spawnId,
          agent: item.agent,
        }),
        {
          kind: 'spawn',
          commandId: spawnId,
          stageId: config.id,
          seatId: seatIdFor({
            workflowId: ctx.workflowId,
            role: item.role,
            itemKey: item.key,
          }),
          attemptId: id,
          agent: item.agent,
          keepOpen: true,
          spec: {
            purpose: 'worker',
            stageId: config.id,
            itemKey: item.key,
            attempt: item.attempt,
            baseSha: item.baseSha!,
            ...(item.reworkOf ? { reworkOf: item.reworkOf } : {}),
          },
          workspace: {
            kind: 'existing-worktree',
            workspace: p.result.workspace,
            readOnly: false,
          },
        },
      ];
    }
    if (item && p.kind === 'runtime.spawnAgent' && item.status === 'dispatched')
      return [
        update(ctx, item, 'in_progress'),
        schedule(
          ctx,
          {
            purpose: 'item-timeout',
            itemKey: item.key,
            attemptId: item.currentAttemptId!,
          },
          config.timeouts.itemMin * MINUTE_MS,
        ),
      ];
    if (
      item &&
      p.kind === 'scm.compareBranch' &&
      p.commandId.startsWith(itemId(ctx, item, 'push'))
    ) {
      if (!p.result || p.result.ahead < 1) return nudge(ctx, item);
      return [
        ...itemTimers(ctx, item),
        ...cancelNudge(ctx, item.currentAttemptId!, 'item-timeout'),
        update(ctx, item, 'pushed', { headSha: p.result.headSha }),
      ];
    }
    if (
      item &&
      p.kind === 'scm.openPR' &&
      p.commandId === itemId(ctx, item, 'pr')
    ) {
      const effects: Effect[] = [
        update(ctx, item, 'pr_open', { pr: p.result.pr }),
      ];
      // Failed retries supersede old PRs; rework never opens or closes a PR.
      const previous = Object.values(ctx.state.commands).filter(
        (c) =>
          c.attemptId &&
          item.attemptIds.includes(c.attemptId) &&
          c.attemptId !== item.currentAttemptId &&
          c.result?.kind === 'scm.openPR',
      );
      for (const old of previous)
        if (
          old.result?.kind === 'scm.openPR' &&
          old.result.result &&
          'pr' in old.result.result
        ) {
          const pr = {
            repo: workflow.repo.github,
            number: old.result.result.pr,
          };
          const id = itemId(ctx, item, `supersede-${pr.number}`);
          effects.push(
            external(`${id}/close`, {
              kind: 'scm.updatePR',
              args: { pr, patch: { state: 'closed' } },
            }),
            external(`${id}/comment`, {
              kind: 'scm.comment',
              args: {
                target: { ...pr, type: 'pr' },
                body: `Superseded by ${p.result.url}\n\n<!-- ai-office:cmd=${id}/comment -->`,
              },
            }),
          );
        }
      return effects;
    }
  }
  if (event.type === 'workitem.status') {
    const item = ctx.state.workItems[event.payload.itemKey]!;
    if (item.status === 'pushed') {
      const a = ctx.state.attempts[item.currentAttemptId!]!;
      return [
        ...stopAttempt(ctx, a, 'pushed'),
        ...(item.reworkOf && item.pr
          ? [update(ctx, item, 'pr_open')]
          : [
              external(
                itemId(ctx, item, 'pr'),
                {
                  kind: 'scm.openPR',
                  args: {
                    repo: workflow.repo.github,
                    head: item.branch!,
                    base: workflow.integrationBranch,
                    title: item.title,
                    body: `${item.body}\n\n${item.issue ? `Refs #${item.issue}\n\n` : ''}<!-- ai-office:cmd=${itemId(ctx, item, 'pr')} -->`,
                  },
                },
                { stageId: config.id, attemptId: item.currentAttemptId! },
              ),
            ]),
      ];
    }
    if (item.status === 'pr_open')
      return [
        internal({
          type: 'QueueWorkItemForMerge',
          meta: metaFor(ctx),
          item: {
            itemKey: item.key,
            attemptId: item.currentAttemptId!,
            pr: item.pr!,
            headSha: item.headSha!,
          },
        }),
      ];
  }
  if (event.type === 'seat.status' || event.type === 'seat.exited') {
    const item = items.find(
      (i) => i.currentAttemptId === event.payload.attemptId,
    );
    const a = item && ctx.state.attempts[item.currentAttemptId!];
    if (item && a && ['dispatched', 'in_progress'].includes(item.status)) {
      if (a.state === 'done')
        return [
          external(
            itemId(ctx, item, `push-${event.seq}`),
            {
              kind: 'scm.compareBranch',
              args: {
                repo: workflow.repo.github,
                base: item.baseSha!,
                head: item.branch!,
              },
            },
            { stageId: config.id, attemptId: a.attemptId },
          ),
        ];
      if (['error', 'lost', 'exited'].includes(a.state))
        return nudge(ctx, item);
    }
  }
  if (
    ctx.timer?.payload.purpose === 'item-timeout' ||
    ctx.timer?.payload.purpose === 'nudge-grace'
  ) {
    const timedAttempt = ctx.timer.payload.attemptId;
    const item = items.find((i) => i.currentAttemptId === timedAttempt);
    if (item && ['dispatched', 'in_progress'].includes(item.status)) {
      if (ctx.timer.payload.purpose === 'nudge-grace')
        return failItem(
          ctx,
          item,
          'Worker did not finish and push after the reminder',
        );
      // Domain owns question-wait suspension; report raw elapsed time only.
      const timeoutCommand = {
        type: 'RecordWallclockLimit' as const,
        meta: metaFor(ctx),
        stageId: config.id,
        itemKey: item.key,
        attemptId: item.currentAttemptId!,
        usedMinutes:
          (Date.parse(event.occurredAt) -
            Date.parse(ctx.state.attempts[item.currentAttemptId!]!.spawnedAt)) /
          MINUTE_MS,
      };
      const result = decide(ctx.state, timeoutCommand);
      return [
        internal(timeoutCommand),
        ...(result.ok && !result.events.length
          ? [
              schedule(
                ctx,
                {
                  purpose: 'item-timeout',
                  itemKey: item.key,
                  attemptId: item.currentAttemptId!,
                },
                MINUTE_MS,
                event.seq,
              ),
            ]
          : []),
      ];
    }
  }
  if (
    event.type === 'budget.exceeded' &&
    event.payload.metric === 'wallclock' &&
    event.payload.scope === 'item'
  ) {
    const item = ctx.state.workItems[event.payload.itemKey];
    if (item) return nudge(ctx, item);
  }
  const effects: Effect[] = [];
  if (['workitem.merged', 'workitem.status'].includes(event.type)) {
    for (const item of items.filter((i) =>
      ['merged', 'skipped'].includes(i.status),
    ))
      for (const id of item.attemptIds) {
        const a = ctx.state.attempts[id];
        if (a && !a.released)
          effects.push(
            ...stopAttempt(ctx, a, 'resolved'),
            ...releaseAttempt(ctx, a, true, 'resolved'),
          );
      }
  }
  if (
    ![
      'stage.started',
      'workitem.approved',
      'workitem.merged',
      'workitem.status',
      'workitem.rework_requested',
      'seat.exited',
      'seat.released',
      'ondemand.stopped',
      'gate.decided',
      'workflow.resumed',
      'command.succeeded',
    ].includes(event.type)
  )
    return effects;
  const complete = (state: WorkflowState) =>
    state.stages[config.id]?.status === 'running' &&
    state.workflow?.pausedReasons.length === 0 &&
    state.workItemOrder.length > 0 &&
    Object.values(state.workItems).every((i) =>
      ['merged', 'skipped'].includes(i.status),
    ) &&
    !Object.values(state.gates).some(
      (g) => g.stageId === config.id && g.status === 'open',
    ) &&
    possiblyLiveAttempts(state).length === 0 &&
    Object.values(state.ondemand[config.id] ?? {}).every(
      (instance) => !instance.attemptId || instance.stopped !== undefined,
    );
  if (complete(ctx.state) && !complete(ctx.before))
    return [
      ...effects,
      ...stageTimers(ctx, config.id),
      internal({
        type: 'CompleteStage',
        meta: metaFor(ctx),
        stageId: config.id,
        attempt: stage.attempt,
      }),
    ];
  return [...effects, ...scheduleReady(ctx, config.id, config.maxParallel)];
};

export const implementStage: StageModule = {
  react: (ctx) =>
    reactImplement(ctx).filter(
      (effect) =>
        (effect.kind !== 'external' && effect.kind !== 'spawn') ||
        !ctx.state.commands[effect.commandId],
    ),
};
