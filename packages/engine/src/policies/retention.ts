import { collectCleanup } from '@ai-office/domain';
import { commandId, metaFor } from '../context.js';
import { external, internal } from '../effects.js';
import type { Effect } from '../effects.js';
import type { Policy } from '../stages/types.js';

/**
 * M5 §4.2 retention. On `workflow.completed` with the start-time snapshot
 * `delete-on-complete`, cleans up what {@link collectCleanup} reads from state
 * under `<workflowId>/cleanup/<kind>/<ref>` ids, so react reruns, replays and
 * restarts issue each command once. `keep` and older events without the
 * snapshot clean up nothing; spawns without a recorded `workspace` are left
 * to `POST /cleanup`. A dispose or branch delete that fails after the workflow
 * ended (these, or `POST /cleanup`'s) becomes a `cleanup-failed` warning.
 */
export const retentionPolicy: Policy = (ctx) => {
  const { event, state } = ctx;
  const workflow = state.workflow;
  if (workflow === null) return [];
  if (event.type === 'workflow.completed') {
    if (workflow.limits.workerBranchRetention !== 'delete-on-complete')
      return [];
    return collectCleanup(state)
      .map(({ resource, command }) => ({
        id: commandId(ctx, 'cleanup', ...resource),
        command,
      }))
      .filter(({ id }) => !Object.hasOwn(state.commands, id))
      .map(({ id, command }): Effect => external(id, command));
  }
  if (
    event.type === 'command.failed' &&
    workflow.status !== 'running' &&
    (event.payload.kind === 'runtime.disposeWorkspace' ||
      event.payload.kind === 'scm.deleteBranch')
  )
    return [
      internal({
        type: 'EvaluateAnomaly',
        meta: metaFor(ctx),
        observation: {
          kind: 'cleanup-failed',
          commandId: event.payload.commandId,
        },
      }),
    ];
  return [];
};
