import {
  budgetAlertKey,
  EXCEPTION_OPTIONS,
  isAttemptPossiblyAlive,
} from '@ai-office/domain';
import type { BudgetAlert, WorkflowState } from '@ai-office/domain';
import { stopAttempt } from '../agents.js';
import { commandId, metaFor } from '../context.js';
import type { ReactContext } from '../context.js';
import { external, internal } from '../effects.js';
import type { Effect } from '../effects.js';
import type { Policy } from '../stages/types.js';

export const alertGateId = (
  ctx: Pick<ReactContext, 'workflowId'>,
  alert: BudgetAlert,
): string =>
  alert.gateId ??
  `budget-${ctx.workflowId}-${budgetAlertKey(alert, alert.level)}`;

/** A resolved top-up unblocks only its scope. Finish/use-output never permits new work. */
export const budgetBlocked = (
  state: WorkflowState,
  stageId?: string,
  itemKey?: string,
  useOutput = false,
): boolean =>
  Object.values(state.budgetAlerts).some((alert) => {
    if (
      alert.level === 'exceeded' &&
      state.budgetAlerts[budgetAlertKey(alert, 'hard_limit')]
    )
      return false;
    if (
      alert.scope === 'stage' &&
      (alert.stageId !== stageId ||
        state.stages[stageId]?.attempt !== alert.stageAttempt)
    )
      return false;
    if (
      alert.scope === 'item' &&
      (alert.itemKey !== itemKey ||
        state.workItems[itemKey]?.currentAttemptId !== alert.attemptId)
    )
      return false;
    const gate =
      state.gates[alertGateId({ workflowId: state.workflowId! }, alert)];
    const option = gate?.decision?.optionId;
    if (useOutput && ['finish', 'use-output'].includes(option ?? ''))
      return false;
    return (
      gate?.status !== 'closed' &&
      !['top-up', 'top-up-rerun', 'retry', 'reassign', 'skip'].includes(
        option ?? '',
      )
    );
  });

export const budgetPolicy: Policy = (ctx) => {
  const event = ctx.event;
  if (
    !ctx.state.workflow ||
    ctx.state.workflow.status !== 'running' ||
    ctx.state.workflow.cancelRequested
  )
    return [];
  if (event.type === 'gate.opened') {
    const soft = Object.values(ctx.state.budgetAlerts).find(
      (a) =>
        a.level === 'exceeded' && alertGateId(ctx, a) === event.payload.gateId,
    );
    return soft && ctx.state.budgetAlerts[budgetAlertKey(soft, 'hard_limit')]
      ? [
          internal({
            type: 'CloseGate',
            meta: metaFor(ctx),
            gateId: event.payload.gateId,
            reason: 'superseded',
          }),
        ]
      : [];
  }
  if (
    event.type === 'gate.decided' &&
    ['top-up', 'top-up-rerun'].includes(event.payload.optionId ?? '')
  ) {
    const stages = ctx.state.stageOrder.map((id) => ctx.state.stages[id]!);
    const pending = stages.find((s) => s.pendingRerun);
    const wake: Effect[] = Object.entries(ctx.state.ondemand).flatMap(
      ([stageId, instances]) =>
        Object.entries(instances).flatMap(([purpose, instance]) =>
          instance && !instance.current && instance.queue.length
            ? [
                internal({
                  type: 'UpdateOnDemandQueue',
                  meta: metaFor(ctx),
                  update: {
                    stageId,
                    purpose: purpose as 'merge' | 'oncall',
                    queue: instance.queue,
                  },
                }),
              ]
            : [],
        ),
    );
    return pending && !stages.some((s) => s.status === 'running')
      ? [
          internal({
            type: 'StartStage',
            meta: metaFor(ctx),
            stageId: pending.id,
          }),
        ]
      : wake;
  }
  if (event.type !== 'budget.exceeded' && event.type !== 'budget.hard_limit') {
    // A spawn already in flight at the fuse can report its ref afterwards.
    if (event.type !== 'command.succeeded' && event.type !== 'seat.spawned')
      return [];
    return Object.values(ctx.state.budgetAlerts).flatMap((alert) => {
      if (alert.level !== 'hard_limit') return [];
      const gateId = alertGateId(ctx, alert);
      return Object.values(ctx.state.attempts).flatMap((a) => {
        if (
          !isAttemptPossiblyAlive(a) ||
          !a.agentRef ||
          (alert.scope === 'stage' &&
            (a.stageId !== alert.stageId ||
              a.stageAttempt !== alert.stageAttempt)) ||
          (alert.scope === 'item' && a.attemptId !== alert.attemptId) ||
          ctx.state.commands[commandId(ctx, 'stop', a.attemptId, gateId)]
        )
          return [];
        if (
          alert.scope === 'workflow' &&
          ctx.state.gates[gateId]?.status !== 'open'
        )
          return [];
        return stopAttempt(ctx, a, gateId);
      });
    });
  }
  const alert: BudgetAlert = {
    ...event.payload,
    level: event.type === 'budget.exceeded' ? 'exceeded' : 'hard_limit',
  };
  const stageId =
    alert.scope === 'workflow'
      ? ctx.state.stageOrder.find(
          (id) => ctx.state.stages[id]?.status === 'running',
        )
      : alert.stageId;
  if (!stageId) return [];
  const gateId = alertGateId(ctx, alert);
  const hard = alert.level === 'hard_limit';
  const kind =
    alert.scope === 'item'
      ? hard
        ? 'item-budget-hard-limit'
        : 'item-budget-exceeded'
      : hard
        ? 'budget-hard-limit'
        : 'budget-exceeded';
  const attempts = Object.values(ctx.state.attempts).filter(
    (a) =>
      isAttemptPossiblyAlive(a) &&
      (alert.scope === 'workflow' ||
        (a.stageId === stageId &&
          (alert.scope !== 'item' || a.attemptId === alert.attemptId))),
  );
  const leads = attempts.filter((a) =>
    ['facilitator', 'planner', 'integrator', 'oncall'].includes(a.purpose),
  );
  const effects: Effect[] = hard
    ? attempts.flatMap((a) => stopAttempt(ctx, a, gateId))
    : (leads.length ? leads : attempts).flatMap((a) =>
        a.agentRef
          ? [
              external(
                commandId(ctx, 'budget-reminder', gateId, a.attemptId),
                {
                  kind: 'runtime.send',
                  args: {
                    agent: a.agentRef,
                    subject: 'Budget exceeded',
                    body: 'Budget exceeded. Finish promptly using the current output; do not start additional work.',
                  },
                },
                { stageId: a.stageId, attemptId: a.attemptId },
              ),
            ]
          : [],
      );
  const soft = ctx.state.budgetAlerts[budgetAlertKey(alert, 'exceeded')];
  if (
    hard &&
    soft &&
    ctx.state.gates[alertGateId(ctx, soft)]?.status === 'open'
  )
    effects.push(
      internal({
        type: 'CloseGate',
        meta: metaFor(ctx),
        gateId: alertGateId(ctx, soft),
        reason: 'superseded',
      }),
    );
  if (
    hard &&
    alert.scope === 'item' &&
    !['merged', 'skipped', 'failed'].includes(
      ctx.state.workItems[alert.itemKey]?.status ?? 'failed',
    )
  )
    effects.push(
      internal({
        type: 'UpdateWorkItemStatus',
        meta: metaFor(ctx),
        update: {
          itemKey: alert.itemKey,
          status: 'needs_attention',
          reason: gateId,
        },
      }),
    );
  if (!ctx.state.gates[gateId])
    effects.push(
      internal({
        type: 'OpenGate',
        noLiveAttempts: false,
        meta: metaFor(ctx),
        gate: {
          kind: 'exception',
          gateId,
          stageId,
          exceptionKind: kind,
          title: hard ? 'Budget hard limit' : 'Budget exceeded',
          options: EXCEPTION_OPTIONS[kind].map((optionId) => ({
            optionId,
            label: optionId,
            ...(['top-up', 'top-up-rerun'].includes(optionId)
              ? { input: 'tokens' as const }
              : {}),
            ...(optionId === 'reassign' ? { input: 'agent' as const } : {}),
          })),
          content: {
            type: 'exception',
            summary: `${alert.scope} ${alert.metric}: ${alert.used} / ${alert.threshold}`,
            ...(alert.scope === 'item'
              ? { itemKey: alert.itemKey, attemptId: alert.attemptId }
              : {}),
          },
        },
      }),
    );
  return effects;
};

/** Central guard includes the triggering edge, before PauseWorkflow is persisted. */
export const filterPolicyEffects = (
  ctx: ReactContext,
  effects: Effect[],
): Effect[] => {
  const workflow = ctx.state.workflow;
  const hijacked = Object.values(ctx.state.gates)
    .filter(
      (g) =>
        g.kind === 'exception' &&
        g.exceptionKind === 'hijacked' &&
        g.status !== 'closed',
    )
    .slice(-1)
    .some(
      (g) =>
        !(
          g.decision?.optionId === 'reclaim' &&
          Object.values(ctx.state.commands).some(
            (c) =>
              c.id === commandId(ctx, 'reclaim', g.gateId) &&
              c.result?.kind === 'runtime.reclaimSession' &&
              c.result.result &&
              'reclaimed' in c.result.result &&
              c.result.result.reclaimed,
          )
        ),
    );
  const paused =
    !workflow ||
    workflow.status !== 'running' ||
    workflow.cancelRequested ||
    workflow.pausedReasons.length > 0 ||
    hijacked ||
    ctx.event.type === 'runtime.identity_hijacked' ||
    ctx.event.type === 'anomaly.detected' ||
    (ctx.event.type === 'seat.exited' &&
      !ctx.event.payload.expected &&
      ctx.event.payload.reason === 'stopped') ||
    (ctx.event.type === 'health.changed' &&
      ctx.event.payload.component !== 'usage' &&
      ctx.event.payload.status !== 'healthy');
  return effects
    .map((effect): Effect =>
      workflow?.cancelRequested &&
      effect.kind === 'external' &&
      effect.command.kind === 'runtime.release'
        ? {
            ...effect,
            command: {
              ...effect.command,
              args: { ...effect.command.args, removeWorkspace: false },
            },
          }
        : effect,
    )
    .filter((effect) => {
      if (
        workflow?.cancelRequested &&
        effect.kind === 'external' &&
        effect.command.kind === 'runtime.disposeWorkspace'
      )
        return false;
      if (
        effect.kind === 'external' &&
        ['runtime.send', 'runtime.answer'].includes(effect.command.kind) &&
        (hijacked || ctx.event.type === 'runtime.identity_hijacked')
      )
        return false;
      let stageId: string | undefined;
      let itemKey: string | undefined;
      let dispatch = false;
      if (effect.kind === 'spawn') {
        dispatch = true;
        stageId = effect.stageId;
        itemKey = ctx.state.attempts[effect.attemptId]?.itemKey;
        // Spawn intents can precede the SpawnAttempt event in the same batch.
        const spawn = effects.find(
          (e) =>
            e.kind === 'internal' &&
            e.command.type === 'SpawnAttempt' &&
            e.command.attemptId === effect.attemptId,
        );
        if (spawn?.kind === 'internal' && spawn.command.type === 'SpawnAttempt')
          itemKey = spawn.command.itemKey;
      } else if (effect.kind === 'internal') {
        const c = effect.command;
        if (
          c.type === 'StartOnDemand' &&
          (!workflow ||
            workflow.cancelRequested ||
            workflow.status !== 'running')
        )
          return false;
        if (
          c.type === 'SpawnAttempt' ||
          c.type === 'StartStage' ||
          c.type === 'DispatchWorkItem'
        ) {
          dispatch = true;
          stageId =
            'stageId' in c
              ? c.stageId
              : ctx.state.stageOrder.find(
                  (id) => ctx.state.stages[id]?.kind === 'implement',
                );
          itemKey = 'itemKey' in c ? c.itemKey : undefined;
        }
        if (
          c.type === 'UpdateOnDemandQueue' &&
          c.update.current !== undefined &&
          c.update.current !==
            ctx.state.ondemand[c.update.stageId]?.[c.update.purpose]?.current
        ) {
          dispatch = true;
          stageId = c.update.stageId;
          itemKey = c.update.purpose === 'merge' ? c.update.current : undefined;
        }
      } else if (effect.kind === 'external') {
        dispatch = [
          'runtime.spawnAgent',
          'runtime.prepareWorkspace',
          'scm.mergePR',
        ].includes(effect.command.kind);
        stageId = effect.stageId;
        itemKey = effect.attemptId
          ? ctx.state.attempts[effect.attemptId]?.itemKey
          : undefined;
        if (
          effect.command.kind === 'runtime.send' &&
          !effect.commandId.startsWith(commandId(ctx, 'finish') + '/') &&
          !effect.commandId.startsWith(commandId(ctx, 'budget-reminder') + '/')
        ) {
          const agent = effect.command.args.agent;
          dispatch = Object.values(ctx.state.attempts).some(
            (a) => a.agentRef === agent && a.ondemand?.purpose === 'merge',
          );
        }
        if (effect.command.kind === 'scm.mergePR')
          itemKey = Object.values(ctx.state.workItems).find(
            (i) =>
              i.pr ===
              (
                effect.command as Extract<
                  typeof effect.command,
                  { kind: 'scm.mergePR' }
                >
              ).args.pr.number,
          )?.key;
      }
      return (
        !dispatch ||
        (!paused &&
          !budgetBlocked(
            ctx.state,
            stageId,
            itemKey,
            effect.kind === 'external' && effect.command.kind === 'scm.mergePR',
          ))
      );
    });
};
