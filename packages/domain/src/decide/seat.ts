import { seatIdFor } from '@ai-office/contracts/events';
import type { SeatCommand, SpawnAttempt } from '../commands.js';
import { accept, reject } from '../errors.js';
import type { DecideResult } from '../errors.js';
import { canTransitionAttempt, isAttemptAlive } from '../state/index.js';
import type { Attempt, Workflow, WorkflowState } from '../state/index.js';
import {
  defined,
  draft,
  failed,
  isDomainError,
  runningWorkflow,
} from './support.js';

const spawnAttempt = (
  state: WorkflowState,
  workflow: Workflow,
  command: SpawnAttempt,
): DecideResult => {
  const stage = state.stages[command.stageId];
  if (stage === undefined)
    return reject('validation', 'unknown_stage', `No stage ${command.stageId}`);
  if (stage.status !== 'running')
    return reject(
      'conflict',
      'stage_not_running',
      `Stage ${stage.id} is ${stage.status}`,
    );
  const config = workflow.template.stages.find((s) => s.id === stage.id);
  const ondemand =
    command.purpose === 'oncall'
      ? ('oncall' as const)
      : command.purpose === 'integrator' && stage.kind === 'implement'
        ? ('merge' as const)
        : undefined;
  if (ondemand !== undefined) {
    if (
      config?.kind !== 'implement' ||
      command.role !==
        (ondemand === 'oncall' ? config.onCall.role : config.mergeQueue.role) ||
      !command.keepOpen
    )
      return reject(
        'conflict',
        'not_allowed',
        'On-demand attempts must use the configured role and keep-open',
      );
    if (
      Object.values(state.attempts).some(
        (a) =>
          a.stageId === stage.id &&
          a.ondemand?.purpose === ondemand &&
          isAttemptAlive(a),
      )
    )
      return reject(
        'conflict',
        'ondemand_alive',
        'Only one live instance per stage and purpose',
      );
  }
  const role = workflow.template.roles[command.role];
  if (role === undefined)
    return reject('validation', 'unknown_role', `No role ${command.role}`);
  if (Object.hasOwn(state.attempts, command.attemptId))
    return reject(
      'conflict',
      'duplicate_attempt',
      `Attempt ${command.attemptId} exists`,
    );
  if ((command.purpose === 'worker') !== (command.itemKey !== undefined))
    return reject(
      'validation',
      'item_key_mismatch',
      'Exactly worker attempts carry an itemKey',
    );
  if (
    command.itemKey !== undefined &&
    !Object.hasOwn(state.workItems, command.itemKey)
  )
    return reject(
      'validation',
      'unknown_item',
      `No work item ${command.itemKey}`,
    );
  const seatId = seatIdFor({
    workflowId: workflow.id,
    role: command.role,
    ...defined({ itemKey: command.itemKey }),
  });
  const previous = state.seats[seatId]?.attemptIds ?? [];
  if (command.retryOf !== undefined && !previous.includes(command.retryOf))
    return reject(
      'validation',
      'unknown_retry_of',
      `Attempt ${command.retryOf} is not on seat ${seatId}`,
    );
  const occupant = previous
    .map((id) => state.attempts[id])
    .find((attempt) => attempt !== undefined && isAttemptAlive(attempt));
  if (occupant !== undefined)
    return reject(
      'conflict',
      'seat_occupied',
      `Seat ${seatId} has live attempt ${occupant.attemptId}`,
      {
        attemptId: occupant.attemptId,
      },
    );
  const override = workflow.roleOverrides[command.role];
  return accept(
    draft(
      command.meta,
      {
        workflowId: workflow.id,
        stageId: stage.id,
        seatId,
        attemptId: command.attemptId,
      },
      'seat.spawned',
      {
        seatId,
        attemptId: command.attemptId,
        attempt: previous.length + 1,
        stageId: stage.id,
        role: command.role,
        agent: command.agent ?? override?.agent ?? role.agent,
        purpose: command.purpose,
        ...(ondemand !== undefined ? { ondemand: { purpose: ondemand } } : {}),
        keepOpen: command.keepOpen,
        spawnCommandId: command.spawnCommandId,
        ...defined({
          itemKey: command.itemKey,
          retryOf: command.retryOf,
          model: command.model,
          effort: command.effort ?? override?.effort ?? role.effort,
        }),
      },
    ),
  );
};

export const decideSeat = (
  state: WorkflowState,
  command: SeatCommand,
): DecideResult => {
  if (command.type === 'SpawnAttempt') {
    const workflow = runningWorkflow(state, { dispatch: true });
    if (isDomainError(workflow)) return failed(workflow);
    return spawnAttempt(state, workflow, command);
  }
  // Observations still record reality after the workflow has ended (e.g. late releases).
  const workflow = state.workflow;
  if (workflow === null)
    return reject(
      'conflict',
      'workflow_not_started',
      'Workflow has not started',
    );
  const attempt: Attempt | undefined = state.attempts[command.attemptId];
  if (attempt === undefined)
    return reject(
      'validation',
      'unknown_attempt',
      `No attempt ${command.attemptId}`,
    );
  const scope = {
    workflowId: workflow.id,
    stageId: attempt.stageId,
    seatId: attempt.seatId,
    attemptId: attempt.attemptId,
  };
  switch (command.type) {
    case 'ObserveAttemptStatus':
      // Repeated observations are no-ops; released attempts are no longer tracked.
      if (attempt.released || command.state === attempt.state) return accept();
      if (!canTransitionAttempt(attempt.state, command.state))
        return reject(
          'conflict',
          'invalid_attempt_transition',
          `Attempt ${attempt.attemptId} cannot go ${attempt.state} → ${command.state}`,
          { from: attempt.state, to: command.state },
        );
      return accept(
        draft(command.meta, scope, 'seat.status', {
          attemptId: attempt.attemptId,
          state: command.state,
          ...defined({ waitingSince: command.waitingSince }),
        }),
      );
    case 'RecordAttemptActivity':
      if (command.activity.length === 0) return accept();
      return accept(
        draft(command.meta, scope, 'seat.activity', {
          attemptId: attempt.attemptId,
          activity: command.activity,
        }),
      );
    case 'MarkAttemptDegraded':
      if (attempt.degraded) return accept();
      return accept(
        draft(command.meta, scope, 'seat.degraded', {
          attemptId: attempt.attemptId,
          reason: command.reason,
        }),
      );
    case 'RecordPolicyViolation':
      if (command.hits.length === 0) return accept();
      return accept(
        draft(command.meta, scope, 'seat.policy_violation', {
          attemptId: attempt.attemptId,
          hits: command.hits,
        }),
      );
    case 'RecordAttemptExited':
      if (attempt.state === 'exited') return accept();
      return accept(
        draft(command.meta, scope, 'seat.exited', {
          attemptId: attempt.attemptId,
          reason: command.reason,
          expected: command.expected,
        }),
      );
    case 'ReleaseAttempt':
      if (attempt.released) return accept();
      return accept(
        draft(command.meta, scope, 'seat.released', {
          attemptId: attempt.attemptId,
          removeWorkspace: command.removeWorkspace,
        }),
      );
  }
};
