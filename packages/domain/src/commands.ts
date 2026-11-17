import type {
  DomainEvent,
  EventPayload,
  RepoSnapshot,
} from '@ai-office/contracts/events';
import type { WorkflowTemplate } from '@ai-office/contracts/template';
import type {
  AgentKind,
  AgentSubmission,
  AttemptPurpose,
  PauseReason,
  RerunMode,
  RoleOverrides,
  WorkflowLimits,
} from './state/index.js';

/**
 * Who issued a command and when. decide never reads a clock (§4): `occurredAt`
 * and correlation come from the caller and land on every emitted event.
 * `provenance` defaults to `observed` for runtime/scm sources, else `decided`.
 */
export interface CommandMeta {
  occurredAt: string;
  source: DomainEvent['source'];
  provenance?: DomainEvent['provenance'];
  causationId?: string;
  externalKey?: string;
}

interface Base<T extends string> {
  type: T;
  meta: CommandMeta;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

// workflow (T6, decide/workflow.ts) -------------------------------------------

/** Mirrors `BudgetOverridesSchema` in contracts/api, which domain may not import. */
export interface BudgetOverrides {
  stages?: Record<
    string,
    {
      tokens?: number;
      maxTurns?: number;
      perItem?: { tokens: number; maxTurns?: number };
    }
  >;
  workflowBudget?: { tokens: number };
  hardLimitMultiplier?: number;
}

/**
 * Ids are minted by the caller (IdGen); the global single-workflow slot is a
 * read-model check in application (§16.3), not a domain invariant.
 */
export interface StartWorkflow extends Base<'StartWorkflow'> {
  workflowId: string;
  shortId: string;
  template: WorkflowTemplate;
  repo: RepoSnapshot;
  requirement: string;
  roleOverrides?: RoleOverrides;
  budgetOverrides?: BudgetOverrides;
  gateToggles?: Record<string, boolean>;
  limits: WorkflowLimits;
  acknowledgedUnverifiedRuntime?: boolean;
}
export interface PauseWorkflow extends Base<'PauseWorkflow'> {
  reason: PauseReason;
  gateId?: string;
  detail?: string;
}
export interface ResumeWorkflow extends Base<'ResumeWorkflow'> {
  reason: PauseReason;
}
export interface RequestCancel extends Base<'RequestCancel'> {
  by: 'user' | 'gate';
  gateId?: string;
  reason?: string;
}
export interface MarkCancelled extends Base<'MarkCancelled'> {
  reason?: string;
}
export interface CompleteWorkflow extends Base<'CompleteWorkflow'> {
  finalPr: number;
  mergeCommitSha?: string;
}
export interface FailWorkflow extends Base<'FailWorkflow'> {
  reason: EventPayload<'workflow.failed'>['reason'];
  stageId?: string;
  detail?: string;
}
export type WorkflowCommand =
  | StartWorkflow
  | PauseWorkflow
  | ResumeWorkflow
  | RequestCancel
  | MarkCancelled
  | CompleteWorkflow
  | FailWorkflow;

// stage (T6, decide/stage.ts) -------------------------------------------------

/** Mode, feedback and agent override come from the pending rerun request, if any. */
export interface StartStage extends Base<'StartStage'> {
  stageId: string;
}
export interface CompleteStage extends Base<'CompleteStage'> {
  stageId: string;
  attempt: number;
}
export interface FailStage extends Base<'FailStage'> {
  stageId: string;
  attempt: number;
  reason: EventPayload<'stage.failed'>['reason'];
  detail?: string;
}
export interface RequestStageRerun extends Base<'RequestStageRerun'> {
  stageId: string;
  mode: RerunMode;
  by: 'user' | 'auto';
  gateId?: string;
  feedback?: string;
  agentOverride?: AgentKind;
}
export type StageCommand =
  StartStage | CompleteStage | FailStage | RequestStageRerun;

// seat / attempt (T6, decide/seat.ts) -----------------------------------------

/**
 * Records a new attempt before engine issues `runtime.spawnAgent` with
 * `spawnCommandId`. `agent` / `effort` default to role overrides, then template.
 */
export interface SpawnAttempt extends Base<'SpawnAttempt'> {
  stageId: string;
  role: string;
  attemptId: string;
  purpose: AttemptPurpose;
  keepOpen: boolean;
  spawnCommandId: string;
  itemKey?: string;
  agent?: AgentKind;
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  retryOf?: string;
}
export interface ObserveAttemptStatus extends Base<'ObserveAttemptStatus'> {
  attemptId: string;
  state: EventPayload<'seat.status'>['state'];
  waitingSince?: string;
}
export interface RecordAttemptActivity extends Base<'RecordAttemptActivity'> {
  attemptId: string;
  activity: EventPayload<'seat.activity'>['activity'];
}
export interface MarkAttemptDegraded extends Base<'MarkAttemptDegraded'> {
  attemptId: string;
  reason: EventPayload<'seat.degraded'>['reason'];
}
export interface RecordPolicyViolation extends Base<'RecordPolicyViolation'> {
  attemptId: string;
  hits: EventPayload<'seat.policy_violation'>['hits'];
}
export interface RecordAttemptExited extends Base<'RecordAttemptExited'> {
  attemptId: string;
  reason: string;
  expected: boolean;
}
export interface ReleaseAttempt extends Base<'ReleaseAttempt'> {
  attemptId: string;
  removeWorkspace: boolean;
}
export type SeatCommand =
  | SpawnAttempt
  | ObserveAttemptStatus
  | RecordAttemptActivity
  | MarkAttemptDegraded
  | RecordPolicyViolation
  | RecordAttemptExited
  | ReleaseAttempt;

// gate (T9, decide/gate.ts) — T9 owns these shapes and may refine them ---------

export interface OpenGate extends Base<'OpenGate'> {
  gate: DistributiveOmit<EventPayload<'gate.opened'>, 'version'>;
  /** Engine-supplied precondition: no attempt of this workflow is alive (§8.1). */
  noLiveAttempts: boolean;
}
export interface DecideGate extends Base<'DecideGate'> {
  gateId: string;
  decision: EventPayload<'gate.decided'>['decision'];
  by: 'user' | 'auto';
  expectedVersion: number;
  optionId?: string;
  comment?: string;
  edits?: EventPayload<'gate.decided'>['edits'];
  /** Conclusion gates (Q1): hash the user saw vs. hash application just read. */
  requestedGithubBodyHash?: string;
  currentGithubBodyHash?: string;
  approvedSnapshot?: EventPayload<'gate.decided'>['approvedSnapshot'];
  additionalTokens?: number;
  agent?: AgentKind;
}
export interface UpdateGateContent extends Base<'UpdateGateContent'> {
  update: DistributiveOmit<EventPayload<'gate.content_updated'>, 'version'>;
}
export interface CloseGate extends Base<'CloseGate'> {
  gateId: string;
  reason: EventPayload<'gate.closed'>['reason'];
}
export type GateCommand = OpenGate | DecideGate | UpdateGateContent | CloseGate;

// submission (T9, decide/submission.ts) ---------------------------------------

/** Identity-checked submission; decide applies §9 rules (kind/role, gate open…). */
export interface AcceptSubmission extends Base<'AcceptSubmission'> {
  submissionId: string;
  attemptId: string;
  submission: AgentSubmission;
  artifactId?: string;
}
/** Failures found before decide (schema, identity) are still recorded (§9.3). */
export interface RejectSubmission extends Base<'RejectSubmission'> {
  rejection: EventPayload<'submission.rejected'>;
}
export type SubmissionCommand = AcceptSubmission | RejectSubmission;

// work-item drafts (T9, decide/workitem-drafts.ts) ----------------------------

export interface ProposeWorkItems extends Base<'ProposeWorkItems'> {
  stageId: string;
  submissionId: string;
  items: EventPayload<'workitem.proposed'>['items'];
}
export interface ApproveWorkItems extends Base<'ApproveWorkItems'> {
  gateId: string;
  items: EventPayload<'workitem.approved'>['items'];
}
export type WorkItemDraftCommand = ProposeWorkItems | ApproveWorkItems;

// budget (T10, decide/budget.ts) — T10 owns these shapes ----------------------

/** Usage deltas (application converts cumulative samples, §10.2). */
export interface RecordUsageTokens extends Base<'RecordUsageTokens'> {
  usage: EventPayload<'usage.tokens'>;
}
export interface RecordUsageTurns extends Base<'RecordUsageTurns'> {
  usage: EventPayload<'usage.turns'>;
}
/** Wall-clock substitute limit when usage is unavailable (§10.2). */
export interface RecordWallclockLimit extends Base<'RecordWallclockLimit'> {
  stageId: string;
  itemKey?: string;
  attemptId?: string;
  /** Raw elapsed minutes; domain subtracts recorded question waits for items. */
  usedMinutes: number;
}
export type BudgetCommand =
  RecordUsageTokens | RecordUsageTurns | RecordWallclockLimit;

// question (T10, decide/question.ts) ------------------------------------------

export interface AskQuestion extends Base<'AskQuestion'> {
  questionId: string;
  attemptId: string;
  itemKey?: string;
  body: string;
}
export interface ForwardQuestion extends Base<'ForwardQuestion'> {
  questionId: string;
  to: EventPayload<'message.forwarded'>['to'];
  toAttemptId: string;
  retry: number;
}
export interface AnswerQuestion extends Base<'AnswerQuestion'> {
  questionId: string;
  by: 'agent' | 'user';
  body: string;
  attemptId?: string;
  optionId?: string;
  gateId?: string;
}
export interface EscalateQuestion extends Base<'EscalateQuestion'> {
  questionId: string;
  reason: EventPayload<'message.escalated'>['reason'];
  gateId: string;
}
export type QuestionCommand =
  AskQuestion | ForwardQuestion | AnswerQuestion | EscalateQuestion;

// work item (T10, decide/workitem.ts) -----------------------------------------

export interface DispatchWorkItem extends Base<'DispatchWorkItem'> {
  itemKey: string;
  attemptId: string;
  agent?: AgentKind;
  retryOf?: string;
}
export interface UpdateWorkItemStatus extends Base<'UpdateWorkItemStatus'> {
  update: EventPayload<'workitem.status'>;
}
export type WorkItemCommand = DispatchWorkItem | UpdateWorkItemStatus;

// anomaly (T10, decide/anomaly.ts) --------------------------------------------

/** One SCM / runtime observation to classify against §12.3 (pure). */
export interface EvaluateAnomaly extends Base<'EvaluateAnomaly'> {
  observation:
    | {
        kind: 'pr';
        pr: EventPayload<'pr.status'>;
        author?: string;
        managed: boolean;
        /** Creation time from SCM; unknown-object detection requires this. */
        createdAt?: string;
      }
    | {
        kind: 'issue';
        number: number;
        author?: string;
        managed: boolean;
        createdAt?: string;
      }
    /** ObservationLoop supplies its persisted compareBranch polling baseline. */
    | { kind: 'default-branch'; sha: string; previousSha?: string }
    | {
        kind: 'policy-hits';
        attemptId: string;
        hits: EventPayload<'seat.policy_violation'>['hits'];
      }
    | { kind: 'unmanaged-agent'; agent: EventPayload<'agent.unmanaged'> };
}
export type AnomalyCommand = EvaluateAnomaly;

// lifecycle records (T12, decide/lifecycle.ts) -------------------------------

/** Records the one nudge engine sent an attempt for `reason` (§7.1 violation protocol). */
export interface RecordNudge extends Base<'RecordNudge'> {
  attemptId: string;
  reason: EventPayload<'message.nudge'>['reason'];
  subject: string;
  body: string;
}
/** Records an operational error against the workflow (e.g. §8.1 second stop). */
export interface RecordError extends Base<'RecordError'> {
  category: EventPayload<'error.recorded'>['category'];
  code: string;
  message: string;
  stageId?: string;
  commandId?: string;
  detail?: string;
}
export type LifecycleCommand = RecordNudge | RecordError;

// Meeting protocol records (M1-T13). Payloads reuse the event contracts.
export interface StartMeetingRound extends Base<'StartMeetingRound'> {
  stageId: string;
  round: number;
  attemptIds: string[];
}
export interface RecordMeetingStatement extends Base<'RecordMeetingStatement'> {
  stageId: string;
  submissionId: string;
}
export interface CompleteMeetingRound extends Base<'CompleteMeetingRound'> {
  stageId: string;
  round: number;
  absentAttemptIds: string[];
}
export interface ConcludeMeeting extends Base<'ConcludeMeeting'> {
  stageId: string;
  submissionId: string;
}
export interface RecordStageArtifact extends Base<'RecordStageArtifact'> {
  stageId: string;
  artifact: EventPayload<'artifact.created'>;
  commandId?: string;
}
export type MeetingCommand =
  | RecordStageArtifact
  | StartMeetingRound
  | RecordMeetingStatement
  | CompleteMeetingRound
  | ConcludeMeeting;

export type DomainCommand =
  | MeetingCommand
  | WorkflowCommand
  | StageCommand
  | SeatCommand
  | GateCommand
  | SubmissionCommand
  | WorkItemDraftCommand
  | BudgetCommand
  | QuestionCommand
  | WorkItemCommand
  | AnomalyCommand
  | LifecycleCommand;
export type DomainCommandType = DomainCommand['type'];
