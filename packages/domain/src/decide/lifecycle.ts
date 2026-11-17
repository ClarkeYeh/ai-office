import type { LifecycleCommand } from '../commands.js';
import { accept, reject } from '../errors.js';
import type { DecideResult } from '../errors.js';
import { isAttemptAlive } from '../state/index.js';
import type { WorkflowState } from '../state/index.js';
import {
  defined,
  draft,
  failed,
  isDomainError,
  runningWorkflow,
} from './support.js';

/**
 * Records engine's own protocol steps (M1-T12): the single nudge per attempt
 * and reason, and operational errors such as the §8.1 second stop.
 */
export const decideLifecycle = (
  state: WorkflowState,
  command: LifecycleCommand,
): DecideResult => {
  if (command.type === 'RecordError') {
    const workflow = state.workflow;
    if (workflow === null)
      return reject(
        'conflict',
        'workflow_not_started',
        'Workflow has not started',
      );
    if (
      command.stageId !== undefined &&
      !Object.hasOwn(state.stages, command.stageId)
    )
      return reject(
        'validation',
        'unknown_stage',
        `No stage ${command.stageId}`,
      );
    return accept(
      draft(
        command.meta,
        { workflowId: workflow.id, stageId: command.stageId },
        'error.recorded',
        {
          category: command.category,
          code: command.code,
          message: command.message,
          ...defined({ commandId: command.commandId, detail: command.detail }),
        },
      ),
    );
  }
  const workflow = runningWorkflow(state);
  if (isDomainError(workflow)) return failed(workflow);
  const attempt = state.attempts[command.attemptId];
  if (attempt === undefined)
    return reject(
      'validation',
      'unknown_attempt',
      `No attempt ${command.attemptId}`,
    );
  // One nudge per attempt and reason (§7.1); a repeat is an idempotent no-op.
  if (attempt.nudges.some((nudge) => nudge.reason === command.reason))
    return accept();
  if (!isAttemptAlive(attempt))
    return reject(
      'conflict',
      'attempt_not_alive',
      `Attempt ${attempt.attemptId} has ended`,
    );
  return accept(
    draft(
      command.meta,
      {
        workflowId: workflow.id,
        stageId: attempt.stageId,
        seatId: attempt.seatId,
        attemptId: attempt.attemptId,
      },
      'message.nudge',
      {
        attemptId: attempt.attemptId,
        reason: command.reason,
        subject: command.subject,
        body: command.body,
      },
    ),
  );
};
