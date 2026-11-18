import type { SubmissionCommand } from '../commands.js';
import { accept, reject } from '../errors.js';
import type { DecideResult } from '../errors.js';
import type { WorkflowState, SubmissionKind } from '../state/index.js';
import {
  defined,
  draft,
  failed,
  isDomainError,
  runningWorkflow,
} from './support.js';
import { validateWorkItemDrafts } from './workitem-drafts.js';

/** Transport/schema validation and identity checks precede this command. */
export const decideSubmission = (
  state: WorkflowState,
  command: SubmissionCommand,
): DecideResult => {
  const workflow = runningWorkflow(state);
  if (isDomainError(workflow)) return failed(workflow);
  if (command.type === 'RejectSubmission')
    return accept(
      draft(
        command.meta,
        { workflowId: workflow.id, attemptId: command.rejection.attemptId },
        'submission.rejected',
        command.rejection,
      ),
    );
  const attempt = state.attempts[command.attemptId];
  if (!attempt)
    return reject('conflict', 'unknown_attempt', 'Unknown submission attempt');
  const stage = state.stages[attempt.stageId];
  // A stage gate blocks that stage; an exception gate blocks only its requester.
  if (
    Object.values(state.gates).some(
      (g) =>
        g.status === 'open' &&
        (g.kind === 'stage'
          ? g.stageId === attempt.stageId
          : g.content.type === 'exception' &&
            g.content.attemptId === attempt.attemptId),
    )
  )
    return reject('conflict', 'gate_open', 'Submission gate is open');
  if (
    workflow.cancelRequested ||
    attempt.released ||
    ['exited', 'lost', 'error'].includes(attempt.state) ||
    stage?.status !== 'running' ||
    stage.attempt !== attempt.stageAttempt
  )
    return reject(
      'conflict',
      'not_allowed',
      'Attempt is no longer accepting submissions',
    );
  const allowed: Record<string, SubmissionKind[]> = {
    'meeting:facilitator': [
      'agenda',
      'conclusion',
      'answer-question',
      'decision-request',
    ],
    'meeting:participant': ['statement'],
    'planning:planner': ['work-items'],
    'implement:oncall': ['answer-question', 'decision-request'],
    'implement:integrator': [
      'merge-request',
      'rework-request',
      'decision-request',
    ],
    'integrate:integrator': [
      'merge-request',
      'decision-request',
      'integration-report',
    ],
  };
  const config = workflow.template.stages.find((s) => s.id === stage.id);
  const roleAllowed =
    config?.kind === 'meeting'
      ? attempt.purpose === 'facilitator'
        ? attempt.role === config.facilitator
        : attempt.purpose === 'participant' &&
          config.participants.includes(attempt.role)
      : config?.kind === 'planning' || config?.kind === 'integrate'
        ? attempt.role === config.owner
        : config?.kind === 'implement' &&
          (attempt.purpose === 'oncall'
            ? attempt.role === config.onCall.role &&
              attempt.ondemand?.purpose === 'oncall'
            : attempt.role === config.mergeQueue.role &&
              attempt.ondemand?.purpose === 'merge');
  if (!roleAllowed)
    return reject(
      'conflict',
      'not_allowed',
      'Attempt role does not match the stage template',
    );
  const submission = command.submission;
  if (!allowed[`${stage.kind}:${attempt.purpose}`]?.includes(submission.kind))
    return reject(
      'conflict',
      'not_allowed',
      'Submission kind is not allowed for this role and stage',
    );
  if (
    stage.kind === 'implement' &&
    (submission.kind === 'merge-request' ||
      submission.kind === 'rework-request')
  ) {
    const queue = state.ondemand[stage.id]?.merge;
    const item = state.workItems[queue?.current ?? ''];
    if (
      queue?.stopped ||
      queue?.attemptId !== attempt.attemptId ||
      !item ||
      item.status !== 'in_review' ||
      item.pr !== submission.payload.pr
    )
      return reject(
        'conflict',
        'not_allowed',
        'Submission must target this instance’s current PR review',
      );
  }
  if (
    stage.kind === 'integrate' &&
    submission.kind === 'merge-request' &&
    !Object.values(state.workItems).some(
      (item) =>
        item.pr === submission.payload.pr &&
        ['pr_open', 'merge_queued', 'in_review'].includes(item.status),
    )
  )
    return reject(
      'conflict',
      'not_allowed',
      'Final integration can only merge a remaining worker PR',
    );
  if (submission.kind === 'work-items') {
    const error = validateWorkItemDrafts(state, submission.payload.items);
    if (error) return failed(error);
  }
  if (Object.hasOwn(state.submissions, command.submissionId))
    return reject(
      'conflict',
      'duplicate_submission',
      'Submission id is already recorded',
    );
  return accept(
    draft(
      command.meta,
      {
        workflowId: workflow.id,
        stageId: stage.id,
        seatId: attempt.seatId,
        attemptId: attempt.attemptId,
      },
      'submission.accepted',
      {
        submissionId: command.submissionId,
        attemptId: attempt.attemptId,
        kind: submission.kind,
        submission,
        ...defined({ artifactId: command.artifactId }),
        ...(command.agentSession !== undefined &&
        (command.agentSession.provider !== attempt.agentSession?.provider ||
          command.agentSession.id !== attempt.agentSession?.id)
          ? { agentSession: command.agentSession }
          : {}),
      },
    ),
  );
};
