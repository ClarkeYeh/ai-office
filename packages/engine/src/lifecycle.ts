import type { WorkflowState } from '@ai-office/domain';
import { commandId, metaFor } from './context.js';
import type { ReactContext } from './context.js';
import { external, internal } from './effects.js';
import type { Effect } from './effects.js';

/**
 * The next stage engine may start: the first not-done stage, if it never ran
 * or has a pending rerun, while the workflow is running, unpaused and not
 * cancelling, and no stage is running.
 */
export const startableStage = (state: WorkflowState): string | undefined => {
  const workflow = state.workflow;
  if (
    workflow?.status !== 'running' ||
    workflow.pausedReasons.length > 0 ||
    workflow.cancelRequested
  )
    return undefined;
  const stages = state.stageOrder.map((id) => state.stages[id]);
  if (stages.some((stage) => stage?.status === 'running')) return undefined;
  const next = stages.find((stage) => stage?.status !== 'done');
  if (next === undefined) return undefined;
  return next.attempt === 0 || next.pendingRerun !== undefined
    ? next.id
    : undefined;
};

/**
 * Cross-stage reactions: workflow start (Orca session, integration branch),
 * stage sequencing, and recording successful releases. Stages start on the
 * edge where one becomes startable (start, gate approval, completion, rerun,
 * resume), so an event that changes nothing never re-issues `StartStage`.
 */
export const reactLifecycle = (ctx: ReactContext): Effect[] => {
  const effects: Effect[] = [];
  const workflow = ctx.state.workflow;
  if (ctx.event.type === 'workflow.started' && workflow !== null)
    effects.push(
      external(commandId(ctx, 'open-session'), {
        kind: 'runtime.openSession',
        args: {
          repo: {
            orcaRepoId: workflow.repo.orcaRepoId,
            localPath: workflow.repo.localPath,
          },
          objective: `aio:${workflow.shortId} ${workflow.template.name}`,
        },
      }),
      external(commandId(ctx, 'ensure-branch'), {
        kind: 'scm.ensureBranch',
        args: {
          repo: workflow.repo.github,
          name: workflow.integrationBranch,
          from: workflow.repo.defaultBranch,
        },
      }),
    );
  if (
    ctx.event.type === 'command.succeeded' &&
    ctx.event.payload.kind === 'runtime.release'
  ) {
    const record = ctx.state.commands[ctx.event.payload.commandId];
    const issued = record?.issued;
    if (record?.attemptId !== undefined && issued?.kind === 'runtime.release')
      effects.push(
        internal({
          type: 'ReleaseAttempt',
          meta: { ...metaFor(ctx), source: 'runtime' },
          attemptId: record.attemptId,
          removeWorkspace: issued.args.removeWorkspace,
        }),
      );
  }
  const next = startableStage(ctx.state);
  if (next !== undefined && next !== startableStage(ctx.before))
    effects.push(
      internal({ type: 'StartStage', meta: metaFor(ctx), stageId: next }),
    );
  return effects;
};
