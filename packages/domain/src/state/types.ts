import type {
  AttemptState,
  EventPayload,
  OndemandPurpose,
  PolicyHit,
  RepoSnapshot,
  WorkItemStatus,
} from '@ai-office/contracts/events';
import type { WorkflowTemplate } from '@ai-office/contracts/template';

export type PauseReason = EventPayload<'workflow.paused'>['reason'];
export type StageKind = EventPayload<'stage.started'>['kind'];
export type StageMode = EventPayload<'stage.started'>['mode'];
export type RerunMode = EventPayload<'stage.rerun_requested'>['mode'];
export type AgentKind = EventPayload<'seat.spawned'>['agent'];
export type AttemptPurpose = EventPayload<'seat.spawned'>['purpose'];
export type AppliedBudgets = EventPayload<'workflow.started'>['budgets'];
export type WorkflowLimits = EventPayload<'workflow.started'>['limits'];
export type RoleOverrides = EventPayload<'workflow.started'>['roleOverrides'];
export type GateOpened = EventPayload<'gate.opened'>;
export type GateDecided = EventPayload<'gate.decided'>;
export type SubmissionKind = EventPayload<'submission.accepted'>['kind'];
export type AgentSubmission = EventPayload<'submission.accepted'>['submission'];
export type ApprovedWorkItem =
  EventPayload<'workitem.approved'>['items'][number];
export type WorkItemDraft = EventPayload<'workitem.proposed'>['items'][number];
export type TimerPayload = EventPayload<'timer.scheduled'>['payload'];
export type CommandIssued = EventPayload<'command.issued'>;
export type CommandResult = Omit<
  EventPayload<'command.succeeded'>,
  'commandId'
>;
export type ErrorInfo = EventPayload<'command.failed'>['error'];

export type WorkflowStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** §4 Workflow; `paused` is an overlay, one entry per still-unresolved reason. */
export interface Workflow {
  id: string;
  shortId: string;
  template: WorkflowTemplate;
  repo: RepoSnapshot;
  requirement: string;
  integrationBranch: string;
  roleOverrides: RoleOverrides;
  gateToggles: Record<string, boolean>;
  budgets: AppliedBudgets;
  limits: WorkflowLimits;
  acknowledgedUnverifiedRuntime: boolean;
  startedAt: string;
  status: WorkflowStatus;
  pausedReasons: PauseReason[];
  cancelRequested: boolean;
  endedAt?: string;
  failure?: EventPayload<'workflow.failed'>;
  finalPr?: number;
  mergeCommitSha?: string;
}

/** §4 Stage: `pending → running → awaiting_gate → done`; `running → failed`. */
export type StageStatus =
  'pending' | 'running' | 'awaiting_gate' | 'done' | 'failed';

export interface PendingRerun {
  mode: RerunMode;
  by: 'user' | 'auto';
  fromAttempt: number;
  gateId?: string;
  feedback?: string;
  agentOverride?: AgentKind;
}

export interface Stage {
  id: string;
  kind: StageKind;
  index: number;
  status: StageStatus;
  /** 0 until the first `stage.started`; then the current attempt number. */
  attempt: number;
  mode?: StageMode;
  feedback?: string;
  agentOverride?: AgentKind;
  startedAt?: string;
  endedAt?: string;
  /** Starts in `rerun` / `revision` mode, checked against maxReruns / maxRevisions. */
  reruns: number;
  revisions: number;
  pendingRerun?: PendingRerun;
  failure?: Pick<EventPayload<'stage.failed'>, 'reason' | 'detail'>;
}

/**
 * §4 Gate states, matching the read model's `GateStatus`: exception gates
 * resolved by an option or answer end as `approved`; `decision` keeps the kind.
 */
export type GateStatus =
  'open' | 'approved' | 'revised' | 'rejected' | 'closed';

export type Gate = GateOpened & {
  status: GateStatus;
  openedAt: string;
  decision?: GateDecided & { decidedAt: string };
  closedReason?: EventPayload<'gate.closed'>['reason'];
  /** Latest GitHub view of the conclusion Issue (§8.2 step 2). */
  github?: { bodyHash: string; githubUpdatedAt: string };
  contentArtifactId?: string;
};

/** A seat is `(workflow, role[, workItem])`; its state is its latest attempt's. */
export interface Seat {
  id: string;
  role: string;
  itemKey?: string;
  attemptIds: string[];
}

export type Attempt = EventPayload<'seat.spawned'> & {
  /** The owning stage's attempt number when this attempt was spawned. */
  stageAttempt: number;
  spawnedAt: string;
  state: AttemptState;
  degraded: boolean;
  released: boolean;
  removeWorkspace?: boolean;
  waitingSince?: string;
  lastActivityAt?: string;
  exit?: { reason: string; expected: boolean };
  policyHits: PolicyHit[];
  nudges: Pick<EventPayload<'message.nudge'>, 'reason' | 'subject'>[];
  /** Opaque runtime ref from the spawn command's result (§11.1). */
  agentRef?: string;
  /** Last reported provider session, used by application usage lookup. */
  agentSession?: EventPayload<'submission.accepted'>['agentSession'];
  /** Latest accepted submission id per kind (statements: latest of any round). */
  submissions: Partial<Record<SubmissionKind, string>>;
  /** S26 (provisional): the provider rate limit in force; `since` is kept from the first evidence. */
  rateLimited?: AttemptRateLimit;
  /** S26: rate-limit windows, the open one last; excluded from item wallclock time. */
  rateLimitWindows?: { from: string; to?: string }[];
};

export type AttemptRateLimit = NonNullable<
  EventPayload<'seat.status'>['rateLimited']
> & {
  /** Time of the latest evidence; the 30-minute lift rule counts from it (§7.1). */
  lastEvidenceAt: string;
};

export interface MeetingRound {
  round: number;
  attemptIds: string[];
  /** Latest statement per attempt for this round. */
  statements: Record<string, { artifactId: string; readyToConclude: boolean }>;
  completed?: Omit<
    EventPayload<'meeting.round_completed'>,
    'stageId' | 'round'
  >;
}

export interface Meeting {
  stageId: string;
  stageAttempt: number;
  rounds: Record<string, MeetingRound>;
  concluded?: Omit<EventPayload<'meeting.concluded'>, 'stageId'>;
}

export interface SubmissionRecord {
  id: string;
  attemptId: string;
  kind: SubmissionKind;
  submission: AgentSubmission;
  artifactId?: string;
  acceptedAt: string;
}

/** §4 Question: `open → forwarded → answered`; `forwarded → escalated → answered`. */
export type QuestionStatus = 'open' | 'forwarded' | 'escalated' | 'answered';

export interface Question {
  id: string;
  attemptId: string;
  itemKey?: string;
  body: string;
  askedAt: string;
  /** Event time used to reconstruct paused work-item timeout intervals. */
  answeredAt?: string;
  status: QuestionStatus;
  forwarded?: Omit<EventPayload<'message.forwarded'>, 'questionId'>;
  escalation?: Omit<EventPayload<'message.escalated'>, 'questionId'>;
  answer?: Omit<EventPayload<'message.answered'>, 'questionId'>;
}

/** One on-demand role instance (§7.5) per stage and purpose. */
export interface OnDemand {
  stageId: string;
  attemptId?: string;
  queue: string[];
  current?: string;
  stopped?: EventPayload<'ondemand.stopped'>['reason'];
  /** Reconstructed from current assignments, across replacement instances. */
  deliveries?: Record<string, { attemptId: string; retries: number }>;
}

export interface WorkItemProposal {
  stageId: string;
  submissionId: string;
  items: WorkItemDraft[];
}

export type WorkItem = ApprovedWorkItem & {
  status: WorkItemStatus;
  approvedGateId: string;
  /** Item attempt ids in dispatch order; `attempt` is the latest number. */
  attemptIds: string[];
  attempt: number;
  currentAttemptId?: string;
  branch?: string;
  workspaceName?: string;
  issue?: number;
  pr?: number;
  headSha?: string;
  statusReason?: string;
  baseSha?: string;
  /** Submission id of the rework request answered by the current attempt. */
  reworkOf?: string;
  rework?: number;
  reworkSubmissionIds?: string[];
  reworkRequest?: EventPayload<'workitem.rework_requested'>;
  mergeCommitSha?: string;
};

export type Artifact = EventPayload<'artifact.created'> & { createdAt: string };

export interface Usage {
  tokens: number;
  turns: number;
}

/** Budget accounting (§10.1): stage keys are `stageKey(stageId, stageAttempt)`. */
export interface UsageLedger {
  workflow: Usage;
  stages: Record<string, Usage>;
  attempts: Record<string, Usage>;
}

export type BudgetLevel = 'exceeded' | 'hard_limit';
export type BudgetAlert = EventPayload<'budget.exceeded'> & {
  level: BudgetLevel;
};

export type CommandStatus = 'issued' | 'succeeded' | 'failed';

/** The outbox ledger (§11.5); also the "commands we issued" record for §12.3. */
export interface CommandRecord {
  id: string;
  issued: CommandIssued;
  attemptId?: string;
  issuedAt: string;
  status: CommandStatus;
  result?: CommandResult;
  error?: ErrorInfo;
  failedAttempts?: number;
  reconciled?: EventPayload<'command.reconciled'>['outcome'];
}

export interface Timer {
  id: string;
  fireAt: string;
  payload: TimerPayload;
  /**
   * S26: paused while its attempt is rate-limited (a `timer.cancelled` with
   * `TIMER_PAUSE_REASON`). Still pending, but never fires until engine
   * reschedules it with the remaining `fireAt − pausedAt`.
   */
  pausedAt?: string;
}

export type Anomaly = EventPayload<'anomaly.detected'> & { detectedAt: string };

/** Everything decide/engine need about one workflow, rebuilt by `evolve`. */
export interface WorkflowState {
  workflowId: string | null;
  /** Highest applied event seq; events at or below it are skipped. */
  lastSeq: number;
  workflow: Workflow | null;
  stages: Record<string, Stage>;
  stageOrder: string[];
  gates: Record<string, Gate>;
  seats: Record<string, Seat>;
  attempts: Record<string, Attempt>;
  meetings: Record<string, Meeting>;
  submissions: Record<string, SubmissionRecord>;
  rejectedSubmissions: number;
  questions: Record<string, Question>;
  /** Keyed by stage id, then by on-demand purpose. */
  ondemand: Record<string, Partial<Record<OndemandPurpose, OnDemand>>>;
  proposals: Record<string, WorkItemProposal>;
  workItems: Record<string, WorkItem>;
  workItemOrder: string[];
  artifacts: Record<string, Artifact>;
  /** Latest `pr.status` per PR number. */
  prs: Record<string, EventPayload<'pr.status'>>;
  /** Latest `scm.issue_drift` per issue number. */
  issueDrift: Record<string, EventPayload<'scm.issue_drift'>>;
  anomalies: Anomaly[];
  unmanagedAgents: EventPayload<'agent.unmanaged'>[];
  usage: UsageLedger;
  /** Budget gates already raised, keyed by `budgetAlertKey` (§10.1 dedupe). */
  budgetAlerts: Record<string, BudgetAlert>;
  commands: Record<string, CommandRecord>;
  /** Scheduled timers that have neither fired nor been cancelled. */
  timers: Record<string, Timer>;
}
