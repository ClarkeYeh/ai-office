import type { DomainCommand } from '../commands.js';
import type {
  OndemandPurpose,
  WorkItemStatus,
} from '@ai-office/contracts/events';
import {
  Harness,
  eventDraft,
  meta,
  spawn,
  startStage,
  throughStage,
} from './fixtures.js';

export const item = (key: string, deps: string[] = []) => ({
  key,
  deps,
  title: key,
  body: 'Build',
  acceptance: ['Works'],
  role: 'engineer',
  agent: 'codex' as const,
});
export const implementation = () =>
  throughStage(new Harness(), 'breakdown').given(
    eventDraft('workitem.approved', {
      gateId: 'task-split',
      items: [item('A'), item('B', ['A']), item('C', ['B']), item('D')],
    }),
    startStage('implement'),
  );
export const status = (
  itemKey: string,
  status: WorkItemStatus,
): DomainCommand => ({
  type: 'UpdateWorkItemStatus',
  meta: meta(),
  update: { itemKey, status },
});
export const dispatch = (
  itemKey = 'A',
  attemptId = 'worker',
): DomainCommand => ({
  type: 'DispatchWorkItem',
  meta: meta(),
  itemKey,
  attemptId,
  baseSha: 'abcdef1',
});
export const dependency = (
  itemKey = 'B',
  gateId = 'dependency',
): DomainCommand => ({
  type: 'EvaluateWorkItemDependencies',
  meta: meta(),
  itemKey,
  gateId,
});
export const choose = (gateId: string, optionId: string): DomainCommand => ({
  type: 'DecideGate',
  meta: meta(),
  gateId,
  expectedVersion: 1,
  by: 'user',
  decision: 'option',
  optionId,
  ...(optionId === 'reassign' ? { agent: 'claude-code' as const } : {}),
});
export const exit = (id: string, lost = false): DomainCommand =>
  lost
    ? {
        type: 'ObserveAttemptStatus',
        meta: meta(),
        attemptId: id,
        state: 'lost',
      }
    : {
        type: 'RecordAttemptExited',
        meta: meta(),
        attemptId: id,
        expected: true,
        reason: 'stopped',
      };
export const queue = (
  purpose: OndemandPurpose,
  entries: string[],
  current?: string,
): DomainCommand => ({
  type: 'UpdateOnDemandQueue',
  meta: meta(),
  update: {
    stageId: 'implement',
    purpose,
    queue: entries,
    ...(current === undefined ? {} : { current }),
  },
});
export const start = (
  purpose: OndemandPurpose,
  attemptId: string = purpose,
): DomainCommand => ({
  type: 'StartOnDemand',
  meta: meta(),
  instance: { stageId: 'implement', purpose, attemptId },
});
export const stop = (
  purpose: OndemandPurpose,
  attemptId: string = purpose,
  reason: 'failed' | 'queue_empty' | 'stage_ended' = 'queue_empty',
): DomainCommand => ({
  type: 'StopOnDemand',
  meta: meta(),
  stop: { stageId: 'implement', purpose, attemptId, reason },
});
export const timeout = (
  purpose: OndemandPurpose,
  attemptId: string = purpose,
): DomainCommand => ({
  type: 'TimeoutOnDemand',
  meta: meta(),
  stageId: 'implement',
  purpose,
  attemptId,
  current: purpose === 'merge' ? 'A' : 'q',
  gateId: 'timeout',
});
export const instance = (
  h: Harness,
  purpose: OndemandPurpose,
  id: string = purpose,
) =>
  h.given(
    spawn(id, purpose === 'merge' ? 'integrator' : 'lead', 'implement', {
      purpose: purpose === 'merge' ? 'integrator' : 'oncall',
    }),
    start(purpose, id),
  );
export const readyPR = () =>
  implementation().given(
    dispatch(),
    status('A', 'in_progress'),
    status('A', 'pushed'),
    status('A', 'pr_open'),
    {
      type: 'QueueWorkItemForMerge',
      meta: meta(),
      item: { itemKey: 'A', attemptId: 'worker', pr: 11, headSha: 'abcdef2' },
    },
  );
export const reviewing = () =>
  instance(readyPR().given(queue('merge', ['A'])), 'merge').given(
    queue('merge', [], 'A'),
  );
export const submission = (
  kind: 'merge-request' | 'rework-request' = 'rework-request',
  id = 'review',
  attemptId = 'merge',
  pr = 11,
): DomainCommand => ({
  type: 'AcceptSubmission',
  meta: meta(),
  submissionId: id,
  attemptId,
  submission:
    kind === 'rework-request'
      ? { kind, payload: { pr, reasons: ['Add edge coverage'] } }
      : { kind, payload: { pr, expectedHeadSha: 'abcdef2' } },
});
export const rework = (id = 'review'): DomainCommand => ({
  type: 'RequestWorkItemRework',
  meta: meta(),
  submissionId: id,
  gateId: 'rework-limit',
});
export const merged: DomainCommand = {
  type: 'MarkWorkItemMerged',
  meta: meta(),
  merged: {
    itemKey: 'A',
    pr: 11,
    mergeCommitSha: 'abcdef3',
    commandId: 'merge-command',
  },
};
