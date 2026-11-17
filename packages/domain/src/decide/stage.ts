import type {
  RequestStageRerun,
  StageCommand,
  StartStage,
} from '../commands.js';
import { accept, reject } from '../errors.js';
import type { DecideResult } from '../errors.js';
import { isAttemptPossiblyAlive } from '../state/index.js';
import type { Workflow, WorkflowState } from '../state/index.js';
import {
  defined,
  draft,
  failed,
  isDomainError,
  runningWorkflow,
} from './support.js';

const startStage = (
  state: WorkflowState,
  workflow: Workflow,
  command: StartStage,
): DecideResult => {
  const stage = state.stages[command.stageId];
  if (stage === undefined)
    return reject('validation', 'unknown_stage', `No stage ${command.stageId}`);
  const running = state.stageOrder.find(
    (id) => state.stages[id]?.status === 'running',
  );
  if (running !== undefined)
    return reject('conflict', 'stage_running', `Stage ${running} is running`, {
      stageId: running,
    });
  const pending = stage.pendingRerun;
  if (pending === undefined && stage.attempt > 0)
    return reject(
      'conflict',
      'rerun_not_requested',
      `Stage ${stage.id} already ran`,
    );
  // §4: a gate left undecided blocks every later stage.
  const blocking = state.stageOrder
    .slice(0, stage.index)
    .find((id) => state.stages[id]?.status !== 'done');
  if (blocking !== undefined)
    return reject(
      'conflict',
      'previous_stage_incomplete',
      `Stage ${blocking} is not done`,
      {
        stageId: blocking,
      },
    );
  return accept(
    draft(
      command.meta,
      { workflowId: workflow.id, stageId: stage.id },
      'stage.started',
      {
        stageId: stage.id,
        kind: stage.kind,
        attempt: stage.attempt + 1,
        mode: pending?.mode ?? 'initial',
        ...defined({
          feedback: pending?.feedback,
          agentOverride: pending?.agentOverride,
        }),
      },
    ),
  );
};

const requestRerun = (
  state: WorkflowState,
  workflow: Workflow,
  command: RequestStageRerun,
): DecideResult => {
  if (workflow.cancelRequested)
    return reject(
      'conflict',
      'cancel_requested',
      'Workflow is being cancelled',
    );
  const stage = state.stages[command.stageId];
  if (stage === undefined)
    return reject('validation', 'unknown_stage', `No stage ${command.stageId}`);
  if (stage.kind === 'final-pr')
    return reject(
      'validation',
      'not_rerunnable',
      'final-pr has no agent to rerun',
    );
  if (stage.status === 'running' || stage.attempt === 0)
    return reject(
      'conflict',
      'stage_not_rerunnable',
      `Stage ${stage.id} is ${stage.status}`,
    );
  if (stage.pendingRerun !== undefined)
    return reject(
      'conflict',
      'rerun_already_requested',
      `Stage ${stage.id} rerun is pending`,
    );
  if (
    command.gateId !== undefined &&
    !Object.hasOwn(state.gates, command.gateId)
  )
    return reject('validation', 'unknown_gate', `No gate ${command.gateId}`);
  if (command.mode === 'rerun') {
    const max = workflow.template.defaults.maxReruns;
    if (stage.reruns >= max)
      return reject(
        'conflict',
        'max_reruns_exceeded',
        `Stage ${stage.id} reran ${max} times`,
        {
          maxReruns: max,
        },
      );
  } else {
    if (stage.kind !== 'integrate')
      return reject(
        'validation',
        'revision_not_supported',
        'Only integrate has revision mode',
      );
    const finalPr = workflow.template.stages.find((s) => s.kind === 'final-pr');
    const max = finalPr?.kind === 'final-pr' ? finalPr.maxRevisions : 0;
    if (stage.revisions >= max)
      return reject(
        'conflict',
        'max_revisions_exceeded',
        `Revisions are used up (${max})`,
        {
          maxRevisions: max,
        },
      );
  }
  return accept(
    draft(
      command.meta,
      { workflowId: workflow.id, stageId: stage.id },
      'stage.rerun_requested',
      {
        stageId: stage.id,
        fromAttempt: stage.attempt,
        mode: command.mode,
        by: command.by,
        ...defined({
          gateId: command.gateId,
          feedback: command.feedback,
          agentOverride: command.agentOverride,
        }),
      },
    ),
  );
};

export const decideStage = (
  state: WorkflowState,
  command: StageCommand,
): DecideResult => {
  const workflow = runningWorkflow(state, {
    dispatch: command.type === 'StartStage',
  });
  if (isDomainError(workflow)) return failed(workflow);
  switch (command.type) {
    case 'StartStage':
      return startStage(state, workflow, command);
    case 'RequestStageRerun':
      return requestRerun(state, workflow, command);
    case 'CompleteStage':
    case 'FailStage': {
      const stage = state.stages[command.stageId];
      if (stage === undefined)
        return reject(
          'validation',
          'unknown_stage',
          `No stage ${command.stageId}`,
        );
      if (stage.status !== 'running' || stage.attempt !== command.attempt)
        return reject(
          'conflict',
          'stale_stage_attempt',
          `Stage ${stage.id} attempt ${command.attempt} is not running`,
          {
            status: stage.status,
            attempt: stage.attempt,
          },
        );
      if (
        stage.kind === 'implement' &&
        Object.values(state.attempts).some(
          (a) =>
            a.stageId === stage.id &&
            a.ondemand !== undefined &&
            isAttemptPossiblyAlive(a),
        )
      )
        return reject(
          'conflict',
          'ondemand_alive',
          'Stop on-demand instances before ending implementation',
        );
      const scope = { workflowId: workflow.id, stageId: stage.id };
      if (command.type === 'CompleteStage')
        return accept(
          draft(command.meta, scope, 'stage.completed', {
            stageId: stage.id,
            attempt: stage.attempt,
          }),
        );
      return accept(
        draft(command.meta, scope, 'stage.failed', {
          stageId: stage.id,
          attempt: stage.attempt,
          reason: command.reason,
          ...defined({ detail: command.detail }),
        }),
      );
    }
  }
};
