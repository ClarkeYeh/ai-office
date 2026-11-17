import type { WorkItemStatus } from '@ai-office/contracts/events';
import type { WorkItemCommand } from '../commands.js';
import { accept, reject } from '../errors.js';
import type { DecideResult } from '../errors.js';
import { isAttemptAlive, stageByKind } from '../state/index.js';
import type { WorkflowState } from '../state/index.js';
import {
  defined,
  draft,
  failed,
  isDomainError,
  runningWorkflow,
} from './support.js';

const transitions: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
  proposed: ['approved'],
  approved: ['skipped', 'failed'],
  dispatched: ['in_progress', 'needs_attention', 'failed', 'skipped'],
  in_progress: ['pushed', 'needs_attention', 'failed', 'skipped'],
  pushed: ['pr_open', 'needs_attention', 'failed', 'skipped'],
  pr_open: ['merged', 'needs_attention', 'failed', 'skipped'],
  // rev2.10 progressive-merge states; their transitions arrive with M1-T10b.
  merge_queued: [],
  in_review: [],
  rework: [],
  needs_attention: ['failed', 'skipped'],
  failed: ['skipped'],
  skipped: [],
  merged: [],
};

export const decideWorkItem = (
  state: WorkflowState,
  command: WorkItemCommand,
): DecideResult => {
  const workflow = runningWorkflow(state, {
    dispatch: command.type === 'DispatchWorkItem',
  });
  if (isDomainError(workflow)) return failed(workflow);
  const key =
    command.type === 'DispatchWorkItem'
      ? command.itemKey
      : command.update.itemKey;
  const item = state.workItems[key];
  if (item === undefined)
    return reject('validation', 'unknown_item', `No work item ${key}`);
  const stage = stageByKind(state, 'implement');
  const scope = { workflowId: workflow.id, stageId: stage?.id };
  if (command.type === 'DispatchWorkItem') {
    if (stage?.status !== 'running')
      return reject(
        'conflict',
        'stage_not_running',
        'Implementation stage is not running',
      );
    if (!['approved', 'needs_attention', 'failed'].includes(item.status))
      return reject(
        'conflict',
        'item_not_dispatchable',
        `Item is ${item.status}`,
      );
    if (
      item.deps.some(
        (dep) =>
          !['pr_open', 'merged', 'skipped'].includes(
            state.workItems[dep]?.status ?? '',
          ),
      )
    )
      return reject(
        'conflict',
        'dependencies_not_ready',
        'Dependencies must have an open PR, be merged, or be skipped',
      );
    if (
      Object.hasOwn(state.attempts, command.attemptId) ||
      Object.values(state.workItems).some((other) =>
        other.attemptIds.includes(command.attemptId),
      )
    )
      return reject('conflict', 'duplicate_attempt', 'Attempt id already used');
    const current =
      item.currentAttemptId === undefined
        ? undefined
        : state.attempts[item.currentAttemptId];
    if (current !== undefined && isAttemptAlive(current))
      return reject(
        'conflict',
        'attempt_alive',
        'Stop the previous attempt before retrying',
      );
    if (
      command.retryOf !== undefined &&
      command.retryOf !== item.currentAttemptId
    )
      return reject(
        'validation',
        'invalid_retry_of',
        'Retry must name the latest item attempt',
      );
    const attempt = item.attempt + 1;
    const suffix = attempt === 1 ? '' : `-a${attempt}`;
    return accept(
      draft(command.meta, scope, 'workitem.dispatched', {
        itemKey: key,
        attemptId: command.attemptId,
        attempt,
        agent: command.agent ?? item.agent,
        branch: `ai-office/${workflow.shortId}/${key}${suffix}`,
        workspaceName: `aio-${workflow.shortId}-${key}${suffix}`,
        ...defined({ retryOf: item.currentAttemptId }),
      }),
    );
  }
  const update = command.update;
  if (
    update.attemptId !== undefined &&
    update.attemptId !== item.currentAttemptId
  )
    return reject(
      'conflict',
      'stale_attempt',
      'Status belongs to an old item attempt',
    );
  if (
    update.status !== item.status &&
    !transitions[item.status].includes(update.status)
  )
    return reject(
      'conflict',
      'invalid_item_transition',
      `Item cannot go ${item.status} → ${update.status}`,
    );
  // Approval and dispatch have dedicated commands, including their required metadata.
  if (update.status === 'approved' && item.status !== 'approved')
    return reject('conflict', 'approval_required', 'Use work item approval');
  return accept(draft(command.meta, scope, 'workitem.status', update));
};
