import type { DomainCommand } from '../commands.js';
import type { DecideResult } from '../errors.js';
import type { WorkflowState } from '../state/index.js';
import { decideAnomaly } from './anomaly.js';
import { decideBudget } from './budget.js';
import { decideGate } from './gate.js';
import { decideQuestion } from './question.js';
import { decideSeat } from './seat.js';
import { decideStage } from './stage.js';
import { decideSubmission } from './submission.js';
import { decideWorkflow } from './workflow.js';
import { decideWorkItemDrafts } from './workitem-drafts.js';
import { decideWorkItem } from './workitem.js';

/**
 * `decide(state, command) → events | DomainError` (§1). Pure: no clock, no
 * randomness; ids and timestamps arrive on the command. Each partition file is
 * owned by one M1 work item (plan §5.1), so this dispatcher is the only shared
 * edit point and only changes when a command group is added.
 */
export const decide = (
  state: WorkflowState,
  command: DomainCommand,
): DecideResult => {
  switch (command.type) {
    case 'StartWorkflow':
    case 'PauseWorkflow':
    case 'ResumeWorkflow':
    case 'RequestCancel':
    case 'MarkCancelled':
    case 'CompleteWorkflow':
    case 'FailWorkflow':
      return decideWorkflow(state, command);
    case 'StartStage':
    case 'CompleteStage':
    case 'FailStage':
    case 'RequestStageRerun':
      return decideStage(state, command);
    case 'SpawnAttempt':
    case 'ObserveAttemptStatus':
    case 'RecordAttemptActivity':
    case 'MarkAttemptDegraded':
    case 'RecordPolicyViolation':
    case 'RecordAttemptExited':
    case 'ReleaseAttempt':
      return decideSeat(state, command);
    case 'OpenGate':
    case 'DecideGate':
    case 'UpdateGateContent':
    case 'CloseGate':
      return decideGate(state, command);
    case 'AcceptSubmission':
    case 'RejectSubmission':
      return decideSubmission(state, command);
    case 'ProposeWorkItems':
    case 'ApproveWorkItems':
      return decideWorkItemDrafts(state, command);
    case 'RecordUsageTokens':
    case 'RecordUsageTurns':
    case 'RecordWallclockLimit':
      return decideBudget(state, command);
    case 'AskQuestion':
    case 'ForwardQuestion':
    case 'AnswerQuestion':
    case 'EscalateQuestion':
      return decideQuestion(state, command);
    case 'DispatchWorkItem':
    case 'UpdateWorkItemStatus':
      return decideWorkItem(state, command);
    case 'EvaluateAnomaly':
      return decideAnomaly(state, command);
  }
};
