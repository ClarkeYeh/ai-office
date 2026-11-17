import type {
  DomainEventDraft,
  WorkItemStatus,
} from '@ai-office/contracts/events';
import type { CommandMeta, DecideGate, WorkItemCommand } from '../commands.js';
import { accept, reject } from '../errors.js';
import type { DecideResult } from '../errors.js';
import { isAttemptAlive, stageByKind } from '../state/index.js';
import type { Gate, WorkflowState } from '../state/index.js';
import {
  defined,
  draft,
  failed,
  isDomainError,
  runningWorkflow,
} from './support.js';

export const WORKITEM_EXCEPTION_OPTIONS = {
  'dependency-blocked': ['proceed', 'skip', 'abort'],
  'merge-blocked': ['retry', 'reassign', 'skip', 'abort'],
  'rework-limit': ['rework', 'retry', 'reassign', 'skip', 'abort'],
  'merge-review-failed': ['requeue', 'merge', 'skip', 'abort'],
} as const;

const transitions: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
  proposed: ['approved'],
  approved: ['skipped', 'failed'],
  dispatched: ['in_progress', 'needs_attention', 'failed', 'skipped'],
  in_progress: ['pushed', 'needs_attention', 'failed', 'skipped'],
  pushed: ['pr_open', 'needs_attention', 'failed', 'skipped'],
  pr_open: ['merge_queued', 'needs_attention', 'failed', 'skipped'],
  merge_queued: ['in_review', 'needs_attention', 'failed', 'skipped'],
  in_review: ['merged', 'rework', 'needs_attention', 'failed', 'skipped'],
  rework: ['needs_attention', 'failed', 'skipped'],
  needs_attention: ['failed', 'skipped'],
  failed: ['skipped'],
  skipped: [],
  merged: [],
};

/** Iterative, cycle-safe traversal also fails closed for missing dependencies. */
export const workItemDependencies = (
  state: WorkflowState,
  key: string,
): string[] => {
  const seen = new Set<string>();
  const pending = [...(state.workItems[key]?.deps ?? [])];
  while (pending.length) {
    const dep = pending.pop()!;
    if (seen.has(dep)) continue;
    seen.add(dep);
    pending.push(...(state.workItems[dep]?.deps ?? []));
  }
  return [...seen];
};

export const workItemException = (
  state: WorkflowState,
  meta: CommandMeta,
  gateId: string,
  kind: keyof typeof WORKITEM_EXCEPTION_OPTIONS,
  itemKey: string,
  summary: string,
): DecideResult => {
  const stage = stageByKind(state, 'implement');
  if (!stage || stage.status !== 'running')
    return reject(
      'conflict',
      'stage_not_running',
      'Implementation stage is not running',
    );
  if (
    Object.values(state.gates).some(
      (g) =>
        g.status === 'open' &&
        g.kind === 'exception' &&
        g.exceptionKind === kind &&
        g.content.type === 'exception' &&
        g.content.itemKey === itemKey,
    )
  )
    return accept();
  if (state.gates[gateId])
    return reject('conflict', 'duplicate_gate', 'Gate id already exists');
  return accept(
    draft(
      meta,
      { workflowId: state.workflowId!, stageId: stage.id },
      'gate.opened',
      {
        gateId,
        stageId: stage.id,
        kind: 'exception',
        exceptionKind: kind,
        title: summary,
        version: 1,
        options: WORKITEM_EXCEPTION_OPTIONS[kind].map((optionId) => ({
          optionId,
          label: optionId,
          ...(optionId === 'reassign' ? { input: 'agent' as const } : {}),
        })),
        content: { type: 'exception', itemKey, summary },
      },
    ),
  );
};

/** Gate decisions are the replayable authorization for dependency overrides. */
const dependencyOverride = (state: WorkflowState, itemKey: string): boolean =>
  Object.values(state.gates).some(
    (g) =>
      g.kind === 'exception' &&
      g.exceptionKind === 'dependency-blocked' &&
      g.content.type === 'exception' &&
      g.content.itemKey === itemKey &&
      g.decision?.optionId === 'proceed',
  );

/** Only the new exception options have work-item side effects; T9 options stay unchanged. */
export const workItemGateEffects = (
  state: WorkflowState,
  gate: Gate,
  command: DecideGate,
): DomainEventDraft[] => {
  if (
    gate.kind !== 'exception' ||
    !(gate.exceptionKind in WORKITEM_EXCEPTION_OPTIONS) ||
    gate.content.type !== 'exception'
  )
    return [];
  const key = gate.content.itemKey;
  if (!key || !state.workItems[key]) return [];
  const scope = { workflowId: state.workflowId!, stageId: gate.stageId };
  if (command.optionId === 'skip') {
    const keys =
      gate.exceptionKind === 'dependency-blocked'
        ? state.workItemOrder.filter(
            (k) => k === key || workItemDependencies(state, k).includes(key),
          )
        : [key];
    return keys
      .filter(
        (k) => !['merged', 'skipped'].includes(state.workItems[k]!.status),
      )
      .map((itemKey) =>
        draft(command.meta, scope, 'workitem.status', {
          itemKey,
          status: 'skipped',
          reason: gate.gateId,
        }),
      );
  }
  if (
    ['rework', 'retry', 'reassign', 'requeue', 'merge'].includes(
      command.optionId ?? '',
    )
  )
    return [
      draft(command.meta, scope, 'workitem.status', {
        itemKey: key,
        status:
          command.optionId === 'rework'
            ? 'rework'
            : command.optionId === 'requeue'
              ? 'merge_queued'
              : 'needs_attention',
        reason: gate.gateId,
      }),
    ];
  return [];
};

export const decideWorkItem = (
  state: WorkflowState,
  command: WorkItemCommand,
): DecideResult => {
  const workflow = runningWorkflow(state, {
    dispatch: command.type === 'DispatchWorkItem',
  });
  if (isDomainError(workflow)) return failed(workflow);
  const stage = stageByKind(state, 'implement');
  const scope = { workflowId: workflow.id, stageId: stage?.id };
  if (
    (command.type === 'RequestWorkItemRework' ||
      command.type === 'QueueWorkItemForMerge') &&
    stage?.status !== 'running'
  )
    return reject(
      'conflict',
      'stage_not_running',
      'Implementation stage is not running',
    );
  if (command.type === 'RequestWorkItemRework') {
    const submission = state.submissions[command.submissionId];
    if (submission?.submission.kind !== 'rework-request')
      return reject(
        'conflict',
        'not_allowed',
        'An accepted rework request is required',
      );
    const pr = submission.submission.payload.pr;
    const item = Object.values(state.workItems).find((i) => i.pr === pr);
    if (
      !item ||
      item.status !== 'in_review' ||
      state.ondemand[stage?.id ?? '']?.merge?.current !== item.key ||
      state.ondemand[stage?.id ?? '']?.merge?.attemptId !== submission.attemptId
    )
      return reject(
        'conflict',
        'not_allowed',
        'Rework must target the current review',
      );
    if (item.reworkSubmissionIds?.includes(submission.id))
      return reject(
        'conflict',
        'duplicate_rework',
        'Rework request already applied',
      );
    const rework = (item.rework ?? 0) + 1;
    const config = workflow.template.stages.find((s) => s.id === stage?.id);
    const limit =
      config?.kind === 'implement'
        ? (config.mergeQueue.maxRework ?? workflow.template.defaults.maxReruns)
        : 0;
    const events: DomainEventDraft[] = [
      draft(command.meta, scope, 'workitem.rework_requested', {
        itemKey: item.key,
        pr: item.pr!,
        submissionId: submission.id,
        attemptId: submission.attemptId,
        reasons: submission.submission.payload.reasons,
        rework,
      }),
    ];
    if (rework > limit) {
      const gate = workItemException(
        state,
        command.meta,
        command.gateId,
        'rework-limit',
        item.key,
        'Rework limit exceeded',
      );
      if (!gate.ok) return gate;
      events.push(
        draft(command.meta, scope, 'workitem.status', {
          itemKey: item.key,
          status: 'needs_attention',
          reason: 'rework-limit',
        }),
        ...gate.events,
      );
    }
    return accept(...events);
  }
  const key =
    command.type === 'UpdateWorkItemStatus'
      ? command.update.itemKey
      : command.type === 'QueueWorkItemForMerge'
        ? command.item.itemKey
        : command.type === 'MarkWorkItemMerged'
          ? command.merged.itemKey
          : command.itemKey;
  const item = state.workItems[key];
  if (!item) return reject('validation', 'unknown_item', `No work item ${key}`);
  if (command.type === 'EvaluateWorkItemDependencies') {
    if (
      !['approved', 'failed', 'needs_attention', 'rework'].includes(
        item.status,
      ) ||
      dependencyOverride(state, key)
    )
      return accept();
    const blocked = workItemDependencies(state, key).filter((dep) =>
      ['skipped', 'failed'].includes(state.workItems[dep]?.status ?? ''),
    );
    return blocked.length
      ? workItemException(
          state,
          command.meta,
          command.gateId,
          'dependency-blocked',
          key,
          `Dependencies unavailable: ${blocked.join(', ')}`,
        )
      : accept();
  }
  if (command.type === 'QueueWorkItemForMerge') {
    if (item.currentAttemptId !== command.item.attemptId)
      return reject(
        'conflict',
        'stale_attempt',
        'Queue belongs to an old attempt',
      );
    if (item.status !== 'pr_open')
      return reject(
        'conflict',
        'invalid_item_transition',
        'Only an open PR can enter the merge queue',
      );
    if (item.pr !== undefined && item.pr !== command.item.pr)
      return reject(
        'conflict',
        'wrong_pr',
        'Queue must reference the current PR',
      );
    return accept(
      draft(command.meta, scope, 'workitem.merge_queued', command.item),
    );
  }
  if (command.type === 'MarkWorkItemMerged') {
    const finalIntegration = stageByKind(state, 'integrate');
    const finishing =
      finalIntegration?.status === 'running' &&
      ['pr_open', 'merge_queued', 'in_review'].includes(item.status);
    const human = Object.values(state.gates).some(
      (g) =>
        g.kind === 'exception' &&
        g.exceptionKind === 'merge-review-failed' &&
        g.content.type === 'exception' &&
        g.content.itemKey === key &&
        g.decision?.optionId === 'merge' &&
        item.statusReason === g.gateId,
    );
    if (
      (item.status !== 'in_review' && !human && !finishing) ||
      item.pr !== command.merged.pr
    )
      return reject(
        'conflict',
        'invalid_item_transition',
        'Merge must target the reviewed PR',
      );
    return accept(
      draft(
        command.meta,
        finishing
          ? { workflowId: workflow.id, stageId: finalIntegration.id }
          : scope,
        'workitem.merged',
        command.merged,
      ),
    );
  }
  if (command.type === 'DispatchWorkItem') {
    if (stage?.status !== 'running')
      return reject(
        'conflict',
        'stage_not_running',
        'Implementation stage is not running',
      );
    if (
      !['approved', 'needs_attention', 'failed', 'rework'].includes(item.status)
    )
      return reject(
        'conflict',
        'item_not_dispatchable',
        `Item is ${item.status}`,
      );
    if (
      Object.values(state.gates).some(
        (g) =>
          g.status === 'open' &&
          g.content.type === 'exception' &&
          g.content.itemKey === key,
      )
    )
      return reject(
        'conflict',
        'gate_open',
        'Resolve the work item exception before dispatch',
      );
    const deps = workItemDependencies(state, key);
    if (
      deps.some(
        (dep) =>
          state.workItems[dep]?.status !== 'merged' &&
          !(
            dependencyOverride(state, key) &&
            ['skipped', 'failed'].includes(state.workItems[dep]?.status ?? '')
          ),
      )
    )
      return reject(
        'conflict',
        'dependencies_not_ready',
        'All transitive dependencies must be merged, or explicitly waived by a dependency exception',
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
    if (current && isAttemptAlive(current))
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
    const rework = item.status === 'rework';
    if (
      rework &&
      (!item.branch || !item.workspaceName || !item.pr || !item.reworkRequest)
    )
      return reject(
        'conflict',
        'missing_rework_workspace',
        'Rework requires the existing branch, workspace, PR and request',
      );
    return accept(
      draft(command.meta, scope, 'workitem.dispatched', {
        itemKey: key,
        attemptId: command.attemptId,
        attempt,
        agent: command.agent ?? item.agent,
        branch: rework
          ? item.branch!
          : `ai-office/${workflow.shortId}/${key}${suffix}`,
        workspaceName: rework
          ? item.workspaceName!
          : `aio-${workflow.shortId}-${key}${suffix}`,
        ...defined({
          retryOf: item.currentAttemptId,
          reworkOf: rework ? item.reworkRequest?.submissionId : undefined,
          baseSha: command.baseSha,
        }),
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
  if (update.status === 'approved' && item.status !== 'approved')
    return reject('conflict', 'approval_required', 'Use work item approval');
  if (
    update.status !== item.status &&
    ['merge_queued', 'rework', 'merged'].includes(update.status)
  )
    return reject(
      'conflict',
      'dedicated_command_required',
      'Use the queue, rework or merged command to record required metadata',
    );
  if (
    update.status === 'in_review' &&
    state.ondemand[stage?.id ?? '']?.merge?.current !== key
  )
    return reject(
      'conflict',
      'not_current_review',
      'Assign the current on-demand review first',
    );
  return accept(draft(command.meta, scope, 'workitem.status', update));
};
