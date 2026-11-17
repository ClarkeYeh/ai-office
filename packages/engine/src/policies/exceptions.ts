import { EXCEPTION_OPTIONS, isAttemptPossiblyAlive } from '@ai-office/domain';
import type { Gate } from '@ai-office/domain';
import { stopAttempt } from '../agents.js';
import { commandId, metaFor, sessionRef } from '../context.js';
import type { ReactContext } from '../context.js';
import { external, internal } from '../effects.js';
import type { Effect } from '../effects.js';
import type { Policy } from '../stages/types.js';

const openException = (
  ctx: ReactContext,
  kind: 'anomaly' | 'hijacked',
  summary: string,
  attemptId?: string,
): Effect[] => {
  if (
    Object.values(ctx.state.gates).some(
      (g) =>
        g.kind === 'exception' &&
        g.exceptionKind === kind &&
        g.status === 'open',
    )
  )
    return [];
  const stageId =
    (attemptId ? ctx.state.attempts[attemptId]?.stageId : undefined) ??
    ctx.state.stageOrder.find(
      (id) => ctx.state.stages[id]?.status === 'running',
    ) ??
    ctx.state.stageOrder.find((id) => ctx.state.stages[id]?.attempt);
  if (!stageId) return [];
  const gateId = commandId(ctx, 'exception', kind, ctx.event.id);
  return [
    internal({
      type: 'OpenGate',
      noLiveAttempts: false,
      meta: metaFor(ctx),
      gate: {
        kind: 'exception',
        gateId,
        stageId,
        exceptionKind: kind,
        title:
          kind === 'hijacked' ? 'Run ownership changed' : 'Anomaly detected',
        options: (kind === 'hijacked'
          ? EXCEPTION_OPTIONS.hijacked
          : ['continue', 'abort']
        ).map((optionId) => ({ optionId, label: optionId })),
        content: {
          type: 'exception',
          summary,
          triggerEventId: ctx.event.id,
          ...(attemptId ? { attemptId } : {}),
        },
      },
    }),
    internal({
      type: 'PauseWorkflow',
      meta: metaFor(ctx),
      reason: 'anomaly',
      gateId,
    }),
  ];
};

/** Stage reruns wait for stopped agents, including implement's on-demand workers. */
const rerun = (ctx: ReactContext, gate: Gate): Effect[] => {
  const stage = ctx.state.stages[gate.stageId];
  if (
    gate.kind !== 'exception' ||
    !stage ||
    stage.pendingRerun ||
    gate.content.type !== 'exception'
  )
    return [];
  // stage.rerun_requested and later stages must not replay a historic gate decision.
  const decision = gate.decision;
  if (
    !decision ||
    (stage.mode === 'rerun' &&
      stage.startedAt &&
      stage.startedAt >= decision.decidedAt)
  )
    return [];
  const attempts = Object.values(ctx.state.attempts).filter(
    (a) => a.stageId === stage.id && isAttemptPossiblyAlive(a),
  );
  if (attempts.length)
    return attempts.flatMap((a) =>
      ctx.state.commands[commandId(ctx, 'stop', a.attemptId, gate.gateId)]
        ? []
        : stopAttempt(ctx, a, gate.gateId),
    );
  if (stage.status === 'running')
    return [
      internal({
        type: 'FailStage',
        meta: metaFor(ctx),
        stageId: stage.id,
        attempt: stage.attempt,
        reason:
          gate.exceptionKind === 'stage-violation'
            ? 'violation'
            : 'budget_hard_limit',
        detail: gate.gateId,
      }),
    ];
  if (
    stage.status !== 'failed' ||
    (stage.failure?.detail && stage.failure.detail !== gate.gateId)
  )
    return [];
  return [
    internal({
      type: 'RequestStageRerun',
      meta: metaFor(ctx),
      stageId: stage.id,
      mode: 'rerun',
      by: 'user',
      gateId: gate.gateId,
      ...(decision.agent ? { agentOverride: decision.agent } : {}),
      ...(decision.comment ? { feedback: decision.comment } : {}),
    }),
  ];
};

const gateDecision = (ctx: ReactContext, gate: Gate): Effect[] => {
  if (gate.kind !== 'exception' || gate.content.type !== 'exception') return [];
  const decision = gate.decision;
  const option = decision?.optionId;
  if (!option || option === 'abort') return []; // DecideGate already emits cancel_requested.
  const meta = metaFor(ctx);
  const key = gate.content.itemKey;
  const item = key ? ctx.state.workItems[key] : undefined;
  const attempts = Object.values(ctx.state.attempts).filter(
    (a) =>
      isAttemptPossiblyAlive(a) &&
      (key ? a.itemKey === key : a.stageId === gate.stageId),
  );
  if (option === 'reclaim') {
    const session = sessionRef(ctx.state);
    return session
      ? [
          external(
            commandId(ctx, 'reclaim', gate.gateId),
            { kind: 'runtime.reclaimSession', args: { session } },
            { stageId: gate.stageId },
          ),
        ]
      : [];
  }
  if (option === 'continue' && gate.exceptionKind === 'anomaly') {
    const other = Object.values(ctx.state.gates).some(
      (g) =>
        g.gateId !== gate.gateId &&
        g.kind === 'exception' &&
        ['anomaly', 'hijacked'].includes(g.exceptionKind) &&
        g.status === 'open',
    );
    return other
      ? []
      : [internal({ type: 'ResumeWorkflow', meta, reason: 'anomaly' })];
  }
  if (gate.exceptionKind === 'decision-request' && gate.content.attemptId) {
    const requester = ctx.state.attempts[gate.content.attemptId];
    return requester?.agentRef
      ? [
          external(
            commandId(ctx, 'decision', gate.gateId),
            {
              kind: 'runtime.send',
              args: {
                agent: requester.agentRef,
                subject: 'Decision',
                body:
                  decision?.comment ??
                  gate.options.find((o) => o.optionId === option)?.label ??
                  option,
              },
            },
            { stageId: gate.stageId, attemptId: requester.attemptId },
          ),
        ]
      : [];
  }
  if (option === 'finish')
    return attempts.flatMap((a) =>
      a.agentRef
        ? [
            external(
              commandId(ctx, 'finish', gate.gateId, a.attemptId),
              {
                kind: 'runtime.send',
                args: {
                  agent: a.agentRef,
                  subject: 'Finish now',
                  body: 'Finish immediately and submit the current output. Do not start new work.',
                },
              },
              { stageId: a.stageId, attemptId: a.attemptId },
            ),
          ]
        : [],
    );
  if (
    key &&
    item &&
    ['skip', 'retry', 'reassign', 'top-up-rerun'].includes(option)
  )
    return attempts.flatMap((a) => stopAttempt(ctx, a, gate.gateId));
  // Domain records the status/reason; the item scheduler dispatches a fresh attempt.
  if (
    option === 'merge' &&
    gate.exceptionKind === 'merge-review-failed' &&
    item?.pr &&
    item.headSha &&
    ctx.state.workflow
  )
    return [
      external(
        commandId(ctx, 'human-merge', gate.gateId),
        {
          kind: 'scm.mergePR',
          args: {
            pr: { repo: ctx.state.workflow.repo.github, number: item.pr },
            expectedHeadSha: item.headSha,
            method: 'merge',
          },
        },
        { stageId: gate.stageId },
      ),
    ];
  if (option === 'use-output') {
    if (
      item?.pr &&
      item.headSha &&
      item.currentAttemptId &&
      (item.status === 'pr_open' ||
        (item.status === 'needs_attention' &&
          ctx.state.prs[item.pr]?.state === 'open'))
    )
      return [
        internal({
          type: 'QueueWorkItemForMerge',
          meta,
          item: {
            itemKey: item.key,
            attemptId: item.currentAttemptId,
            pr: item.pr,
            headSha: item.headSha,
          },
        }),
      ];
    if (
      !key &&
      Object.values(ctx.state.artifacts).some(
        (a) =>
          'attemptId' in a &&
          ctx.state.attempts[a.attemptId]?.stageId === gate.stageId,
      )
    )
      return [
        internal({
          type: 'CompleteStage',
          meta,
          stageId: gate.stageId,
          attempt: ctx.state.stages[gate.stageId]!.attempt,
        }),
      ];
  }
  return [];
};

export const exceptionsPolicy: Policy = (ctx) => {
  const workflow = ctx.state.workflow;
  if (!workflow || workflow.status !== 'running' || workflow.cancelRequested)
    return [];
  const event = ctx.event;
  if (event.type === 'health.changed' && event.payload.component !== 'usage') {
    const reason = `${event.payload.component}_unhealthy` as
      'runtime_unhealthy' | 'scm_unhealthy' | 'store_unhealthy';
    return [
      internal({
        type:
          event.payload.status === 'healthy'
            ? 'ResumeWorkflow'
            : 'PauseWorkflow',
        meta: metaFor(ctx),
        reason,
      }),
    ];
  }
  if (event.type === 'runtime.identity_hijacked')
    return openException(
      ctx,
      'hijacked',
      `Run ${event.payload.run} was taken over; explicit reclamation is required.`,
    );
  if (event.type === 'anomaly.detected')
    return openException(
      ctx,
      'anomaly',
      event.payload.summary,
      event.payload.attemptId,
    );
  if (
    event.type === 'seat.exited' &&
    !event.payload.expected &&
    event.payload.reason === 'stopped'
  )
    return openException(
      ctx,
      'anomaly',
      'Agent exited without a backend stop or release',
      event.payload.attemptId,
    );
  if (event.type === 'seat.policy_violation') {
    const attempt = ctx.state.attempts[event.payload.attemptId];
    if (!attempt) return [];
    if (event.payload.hits.some((h) => h.severity === 'high'))
      return stopAttempt(ctx, attempt, 'policy', event.id);
    return attempt.agentRef
      ? [
          external(
            commandId(ctx, 'policy-reminder', event.id),
            {
              kind: 'runtime.send',
              args: {
                agent: attempt.agentRef,
                subject: 'Policy reminder',
                body: 'A policy violation was recorded. Follow the workflow restrictions and avoid repeating it.',
              },
            },
            { stageId: attempt.stageId, attemptId: attempt.attemptId },
          ),
        ]
      : [];
  }
  if (
    (event.type === 'command.failed' &&
      event.payload.kind === 'runtime.reclaimSession') ||
    (event.type === 'command.succeeded' &&
      event.payload.kind === 'runtime.reclaimSession' &&
      !event.payload.result.reclaimed)
  )
    return openException(
      ctx,
      'hijacked',
      'Run reclamation did not succeed. Choose explicitly whether to try again or abort.',
    );
  if (
    event.type === 'command.succeeded' &&
    event.payload.kind === 'runtime.reclaimSession' &&
    event.payload.result.reclaimed
  ) {
    const matching = Object.values(ctx.state.gates).find(
      (g) =>
        g.kind === 'exception' &&
        g.exceptionKind === 'hijacked' &&
        g.decision?.optionId === 'reclaim' &&
        event.payload.commandId === commandId(ctx, 'reclaim', g.gateId),
    );
    if (
      matching &&
      !Object.values(ctx.state.gates).some(
        (g) =>
          g.kind === 'exception' &&
          ['anomaly', 'hijacked'].includes(g.exceptionKind) &&
          g.status === 'open',
      )
    )
      // Observation paused for `hijacked` too; reclaiming the run ends both.
      return (['anomaly', 'hijacked'] as const)
        .filter((reason) => ctx.state.workflow?.pausedReasons.includes(reason))
        .map((reason) =>
          internal({ type: 'ResumeWorkflow', meta: metaFor(ctx), reason }),
        );
  }
  if (
    event.type === 'command.succeeded' &&
    event.payload.kind === 'scm.mergePR' &&
    event.payload.commandId.startsWith(commandId(ctx, 'human-merge') + '/')
  ) {
    const command = ctx.state.commands[event.payload.commandId]?.issued;
    const item =
      command?.kind === 'scm.mergePR'
        ? Object.values(ctx.state.workItems).find(
            (i) => i.pr === command.args.pr.number,
          )
        : undefined;
    return item?.pr
      ? [
          internal({
            type: 'MarkWorkItemMerged',
            meta: metaFor(ctx),
            merged: {
              itemKey: item.key,
              pr: item.pr,
              commandId: event.payload.commandId,
              mergeCommitSha: event.payload.result.mergeCommitSha,
            },
          }),
        ]
      : [];
  }
  const effects: Effect[] = [];
  // Accepted merge requests survive a pause between acceptance and outbox issue.
  // Reuse the merge-queue command ID, so an already issued request is never replayed.
  if (event.type === 'workflow.resumed' || event.type === 'gate.decided') {
    for (const record of Object.values(ctx.state.submissions)) {
      const submission = record.submission;
      if (submission.kind !== 'merge-request') continue;
      const attempt = ctx.state.attempts[record.attemptId];
      const instance = attempt && ctx.state.ondemand[attempt.stageId]?.merge;
      if (
        !attempt ||
        instance?.attemptId !== record.attemptId ||
        !instance.current ||
        ctx.state.workItems[instance.current]?.pr !== submission.payload.pr
      )
        continue;
      const id = commandId(ctx, 'ondemand', 'merge', record.id);
      if (!ctx.state.commands[id])
        effects.push(
          external(
            id,
            {
              kind: 'scm.mergePR',
              args: {
                pr: {
                  repo: workflow.repo.github,
                  number: submission.payload.pr,
                },
                method: 'merge',
                expectedHeadSha: submission.payload.expectedHeadSha,
              },
            },
            { stageId: attempt.stageId, attemptId: attempt.attemptId },
          ),
        );
    }
    if (event.type === 'workflow.resumed')
      for (const gate of Object.values(ctx.state.gates)) {
        if (
          gate.status === 'approved' &&
          gate.decision?.optionId === 'merge' &&
          !ctx.state.commands[commandId(ctx, 'human-merge', gate.gateId)]
        )
          effects.push(...gateDecision(ctx, gate));
      }
  }
  if (event.type === 'gate.decided') {
    const gate = ctx.state.gates[event.payload.gateId];
    if (gate) effects.push(...gateDecision(ctx, gate));
  }
  if (
    ['gate.decided', 'seat.exited', 'seat.released', 'stage.failed'].includes(
      event.type,
    )
  ) {
    for (const gate of Object.values(ctx.state.gates))
      if (
        gate.kind === 'exception' &&
        gate.status === 'approved' &&
        gate.content.type === 'exception' &&
        !gate.content.itemKey &&
        ((gate.exceptionKind === 'stage-violation' &&
          ['rerun', 'reassign'].includes(gate.decision?.optionId ?? '')) ||
          (gate.exceptionKind === 'budget-hard-limit' &&
            gate.decision?.optionId === 'top-up-rerun'))
      )
        effects.push(...rerun(ctx, gate));
  }
  return effects;
};
