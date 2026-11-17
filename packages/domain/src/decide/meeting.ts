import type { MeetingCommand } from '../commands.js';
import { accept, reject } from '../errors.js';
import type { DecideResult } from '../errors.js';
import type { WorkflowState } from '../state/index.js';
import { draft, failed, isDomainError, runningWorkflow } from './support.js';

/** Validated, replayable meeting protocol transitions; no engine-owned mutable state. */
export const decideMeeting = (
  state: WorkflowState,
  command: MeetingCommand,
): DecideResult => {
  if (command.type === 'RecordStageArtifact') {
    const artifact = command.artifact;
    if (state.artifacts[artifact.artifactId]) return accept();
    if (!state.workflow || !state.stages[command.stageId])
      return reject(
        'validation',
        'unknown_stage',
        'Artifact stage does not exist',
      );
    if ('submissionId' in artifact) {
      const submitted = state.submissions[artifact.submissionId];
      if (
        !submitted ||
        submitted.attemptId !== artifact.attemptId ||
        submitted.kind !== artifact.kind ||
        state.attempts[artifact.attemptId]?.stageId !== command.stageId ||
        (submitted.artifactId ?? submitted.id) !== artifact.artifactId
      )
        return reject(
          'validation',
          'invalid_artifact',
          'Artifact must reference its accepted submission',
        );
    } else if (artifact.kind === 'issue') {
      const result =
        command.commandId === undefined
          ? undefined
          : state.commands[command.commandId]?.result;
      if (
        result?.kind !== 'scm.createIssue' ||
        result.result === null ||
        !('issue' in result.result) ||
        result.result.issue !== artifact.number ||
        result.result.url !== artifact.url ||
        (artifact.purpose === 'work-item' &&
          (!artifact.itemKey || !state.workItems[artifact.itemKey]))
      )
        return reject(
          'validation',
          'invalid_artifact',
          'Issue must reference a successful createIssue command',
        );
    } else
      return reject(
        'validation',
        'invalid_artifact',
        'Only stage submissions and issues are supported',
      );
    return accept(
      draft(
        command.meta,
        { workflowId: state.workflow.id, stageId: command.stageId },
        'artifact.created',
        artifact,
      ),
    );
  }
  const workflow = runningWorkflow(state, { dispatch: true });
  if (isDomainError(workflow)) return failed(workflow);
  const stage = state.stages[command.stageId];
  const meeting = state.meetings[command.stageId];
  const config = workflow.template.stages.find((s) => s.id === command.stageId);
  if (
    stage?.status !== 'running' ||
    config?.kind !== 'meeting' ||
    !meeting ||
    meeting.concluded
  )
    return reject('conflict', 'meeting_not_open', 'Meeting must be running');
  const scope = { workflowId: workflow.id, stageId: stage.id };
  const rounds = Object.values(meeting.rounds);
  if (command.type === 'StartMeetingRound') {
    if (
      command.round !== rounds.length + 1 ||
      command.round > config.maxRounds ||
      rounds.some((r) => !r.completed)
    )
      return reject(
        'conflict',
        'invalid_round',
        'Rounds must be sequential and within the limit',
      );
    if (
      !command.attemptIds.length ||
      new Set(command.attemptIds).size !== command.attemptIds.length ||
      command.attemptIds.some((id) => {
        const a = state.attempts[id];
        return (
          !a ||
          a.stageId !== stage.id ||
          a.stageAttempt !== stage.attempt ||
          a.purpose !== 'participant' ||
          a.released
        );
      })
    )
      return reject(
        'validation',
        'invalid_participants',
        'Participants must belong to this meeting attempt',
      );
    return accept(
      draft(command.meta, scope, 'meeting.round_started', {
        stageId: stage.id,
        round: command.round,
        attemptIds: command.attemptIds,
      }),
    );
  }
  if (command.type === 'CompleteMeetingRound') {
    const round = meeting.rounds[command.round];
    if (!round || round.completed)
      return reject('conflict', 'round_not_open', 'Round is not open');
    const absent = command.absentAttemptIds;
    if (
      new Set(absent).size !== absent.length ||
      absent.some((id) => !round.attemptIds.includes(id)) ||
      round.attemptIds.some(
        (id) =>
          !absent.includes(id) &&
          (!round.statements[id] || state.attempts[id]?.state !== 'done'),
      )
    )
      return reject(
        'validation',
        'round_incomplete',
        'Every participant must finish or be absent',
      );
    const valid = round.attemptIds.filter((id) => !absent.includes(id));
    return accept(
      draft(command.meta, scope, 'meeting.round_completed', {
        stageId: stage.id,
        round: command.round,
        statements: valid.length,
        absentAttemptIds: absent,
        allReadyToConclude:
          valid.length > 0 &&
          valid.every((id) => round.statements[id]?.readyToConclude),
      }),
    );
  }
  const record = state.submissions[command.submissionId];
  const attempt = record && state.attempts[record.attemptId];
  if (
    !record ||
    !attempt ||
    attempt.stageId !== stage.id ||
    attempt.stageAttempt !== stage.attempt ||
    attempt.submissions[record.kind] !== record.id
  )
    return reject(
      'validation',
      'invalid_submission',
      'Use the current accepted submission',
    );
  const artifactId = record.artifactId ?? record.id;
  if (command.type === 'RecordMeetingStatement') {
    const submission = record.submission;
    const round =
      submission.kind === 'statement'
        ? meeting.rounds[submission.payload.round]
        : undefined;
    if (
      submission.kind !== 'statement' ||
      !round ||
      round.completed ||
      !round.attemptIds.includes(attempt.attemptId)
    )
      return reject(
        'conflict',
        'round_not_open',
        'Statement must belong to an open round',
      );
    return accept(
      draft(command.meta, scope, 'meeting.statement', {
        stageId: stage.id,
        attemptId: attempt.attemptId,
        role: attempt.role,
        artifactId,
        statement: submission.payload,
      }),
    );
  }
  if (
    record.kind !== 'conclusion' ||
    !rounds.length ||
    rounds.some((r) => !r.completed) ||
    rounds.at(-1)!.completed!.statements < 2
  )
    return reject(
      'conflict',
      'meeting_incomplete',
      'Conclusion requires completed rounds with at least two speakers',
    );
  return accept(
    draft(command.meta, scope, 'meeting.concluded', {
      stageId: stage.id,
      rounds: rounds.length,
      endedEarly: rounds.length < config.maxRounds,
      conclusionArtifactId: artifactId,
    }),
  );
};
