import { z } from 'zod';
import {
  AgentKindSchema,
  BudgetSchema,
  RoleOverridesSchema,
  WorkflowTemplateSchema,
} from '../template/index.js';
import {
  ActivityMetaSchema,
  AttemptStateSchema,
  ErrorCategorySchema,
  GitShaSchema,
  id,
  isoDateTime,
  nonNegativeInt,
  OndemandPurposeSchema,
  OndemandRefSchema,
  PolicyHitSchema,
  positiveInt,
  RepoSnapshotSchema,
  SeatIdSchema,
  Sha256Schema,
  StageKindSchema,
  WorkItemKeySchema,
  WorkItemStatusSchema,
} from './common.js';
import {
  AgentSubmissionSchema,
  ConclusionSchema,
  DecisionRequestReasonSchema,
  StatementSchema,
  SubmissionKindSchema,
  WorkItemDraftSchema,
} from './submission.js';

// workflow ------------------------------------------------------------------

/** Budgets after start-time overrides (§10.1); engine never re-reads template budgets. */
export const AppliedBudgetsSchema = z.object({
  stages: z.record(id, BudgetSchema),
  workflow: z.object({ tokens: positiveInt }).optional(),
  hardLimitMultiplier: z.number().min(1),
});
/** Runtime limits snapshotted at start (Q9); config changes never affect a running workflow. */
export const WorkflowLimitsSchema = z.object({
  globalAgents: positiveInt,
  /** Snapshot of `engine.spawnStallMs` (§7.1); absent in older events, read as 600000. */
  spawnStallMs: positiveInt.optional(),
  /** Snapshot of `[budget] enforcement` (S25, §10.1); absent in older events, read as `'on'`. */
  budgetEnforcement: z.enum(['on', 'off']).optional(),
});
export const WorkflowStartedPayloadSchema = z.object({
  templateSnapshot: WorkflowTemplateSchema,
  repo: RepoSnapshotSchema,
  requirement: z.string().min(1),
  shortId: z.string().regex(/^[a-z0-9]{4,12}$/),
  integrationBranch: z.string().startsWith('ai-office/'),
  roleOverrides: RoleOverridesSchema,
  gateToggles: z.record(id, z.boolean()),
  budgets: AppliedBudgetsSchema,
  limits: WorkflowLimitsSchema,
  acknowledgedUnverifiedRuntime: z.boolean(),
});
// `paused` is an overlay flag; each reason is resumed independently.
export const PauseReasonSchema = z.enum([
  'runtime_unhealthy',
  'scm_unhealthy',
  'store_unhealthy',
  'anomaly',
  'budget',
  'auth',
  'identity',
  'hijacked',
  'contract_mismatch',
  'bug',
]);
export const WorkflowPausedPayloadSchema = z.object({
  reason: PauseReasonSchema,
  gateId: id.optional(),
  detail: z.string().optional(),
});
export const WorkflowResumedPayloadSchema = z.object({
  reason: PauseReasonSchema,
});
export const WorkflowCompletedPayloadSchema = z.object({
  finalPr: positiveInt,
  mergeCommitSha: GitShaSchema.optional(),
});
export const WorkflowFailedPayloadSchema = z.object({
  reason: z.enum(['max_reruns_exceeded', 'stage_failed', 'other']),
  stageId: id.optional(),
  detail: z.string().optional(),
});
export const WorkflowCancelRequestedPayloadSchema = z.object({
  by: z.enum(['user', 'gate']),
  gateId: id.optional(),
  reason: z.string().optional(),
});
export const WorkflowCancelledPayloadSchema = z.object({
  reason: z.string().optional(),
});

// stage ---------------------------------------------------------------------

export const StageModeSchema = z.enum(['initial', 'rerun', 'revision']);
export const StageStartedPayloadSchema = z.object({
  stageId: id,
  kind: StageKindSchema,
  attempt: positiveInt,
  mode: StageModeSchema,
  feedback: z.string().optional(),
  agentOverride: AgentKindSchema.optional(),
});
export const StageCompletedPayloadSchema = z.object({
  stageId: id,
  attempt: positiveInt,
});
export const StageFailedPayloadSchema = z.object({
  stageId: id,
  attempt: positiveInt,
  reason: z.enum([
    'timeout',
    'violation',
    'budget_hard_limit',
    'agent_failed',
    'cancelled',
    'other',
  ]),
  detail: z.string().optional(),
});
export const StageRerunRequestedPayloadSchema = z.object({
  stageId: id,
  fromAttempt: positiveInt,
  mode: StageModeSchema.exclude(['initial']),
  by: z.enum(['user', 'auto']),
  gateId: id.optional(),
  feedback: z.string().optional(),
  agentOverride: AgentKindSchema.optional(),
});

// gate ----------------------------------------------------------------------

export const ExceptionKindSchema = z.enum([
  'stage-violation',
  'workitem-failed',
  'budget-exceeded',
  'budget-hard-limit',
  'item-budget-exceeded',
  'item-budget-hard-limit',
  'decision-request',
  'question-escalation',
  'anomaly',
  'hijacked',
  // rev2.10 progressive merge (§8.3).
  'dependency-blocked',
  'merge-blocked',
  'rework-limit',
  'merge-review-failed',
  // rev2.11.1 spawn stall (§7.1, §8.3).
  'spawn-stall',
]);
/** `input` tells the UI which extra value the option needs (§8.3: budget top-up, reassignment). */
export const GateOptionSchema = z.object({
  optionId: id,
  label: z.string().min(1),
  input: z.enum(['tokens', 'agent', 'text']).optional(),
});
export const GateContentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('conclusion'),
    artifactId: id,
    renderedHash: Sha256Schema,
  }),
  z.object({ type: z.literal('work-items'), artifactId: id }),
  z.object({
    type: z.literal('final-pr'),
    artifactId: id,
    pr: positiveInt.optional(),
  }),
  z.object({
    type: z.literal('exception'),
    summary: z.string(),
    attemptId: id.optional(),
    itemKey: WorkItemKeySchema.optional(),
    questionId: id.optional(),
    commandId: id.optional(),
    triggerEventId: id.optional(),
    decisionRequest: z
      .object({ reason: DecisionRequestReasonSchema, question: z.string() })
      .optional(),
    changedFiles: z.array(z.string()).optional(),
  }),
]);
const gateOpenedBase = z.object({
  gateId: id,
  stageId: id,
  title: z.string().min(1),
  options: z.array(GateOptionSchema),
  content: GateContentSchema,
  version: positiveInt,
});
export const GateOpenedPayloadSchema = z.discriminatedUnion('kind', [
  gateOpenedBase.extend({
    kind: z.literal('stage'),
    templateGateId: id,
    stageKind: StageKindSchema.extract(['meeting', 'planning', 'final-pr']),
    optional: z.boolean(),
  }),
  gateOpenedBase.extend({
    kind: z.literal('exception'),
    exceptionKind: ExceptionKindSchema,
  }),
]);
// Q1: approval compares only bodyHash; githubUpdatedAt is display-only.
export const GateContentUpdatedPayloadSchema = z.discriminatedUnion('source', [
  z.object({
    gateId: id,
    source: z.literal('github'),
    version: positiveInt,
    bodyHash: Sha256Schema,
    githubUpdatedAt: isoDateTime,
  }),
  z.object({
    gateId: id,
    source: z.enum(['agent', 'user']),
    version: positiveInt,
    artifactId: id.optional(),
  }),
]);
export const GateEditsSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('conclusion'), conclusion: ConclusionSchema }),
  z.object({
    type: z.literal('work-items'),
    items: z.array(WorkItemDraftSchema),
  }),
]);
/** §8.2 step 3–4: the approved conclusion; `structured` is null when markers cannot be parsed. */
export const ApprovedSnapshotSchema = z.object({
  source: z.enum(['github', 'ai-office']),
  body: z.string(),
  bodyHash: Sha256Schema,
  githubUpdatedAt: isoDateTime.optional(),
  structured: ConclusionSchema.nullable(),
});
export const GateDecisionSchema = z.enum([
  'approve',
  'revise',
  'reject',
  'option',
  'answer',
]);
export const GateDecidedPayloadSchema = z.object({
  gateId: id,
  decision: GateDecisionSchema,
  by: z.enum(['user', 'auto']),
  version: positiveInt,
  optionId: id.optional(),
  comment: z.string().optional(),
  edits: GateEditsSchema.optional(),
  approvedSnapshot: ApprovedSnapshotSchema.optional(),
  additionalTokens: positiveInt.optional(),
  agent: AgentKindSchema.optional(),
});
export const GateClosedPayloadSchema = z.object({
  gateId: id,
  reason: z.enum(['merged', 'cancelled', 'superseded']),
});

// seat / attempt ------------------------------------------------------------

export const AttemptPurposeSchema = z.enum([
  'facilitator',
  'participant',
  'planner',
  'worker',
  'integrator',
  'oncall',
]);
export const SeatSpawnedPayloadSchema = z.object({
  seatId: SeatIdSchema,
  attemptId: id,
  /** 1-based per seat; on-demand attempts count on their role's shared seat. */
  attempt: positiveInt,
  stageId: id,
  role: id,
  agent: AgentKindSchema,
  purpose: AttemptPurposeSchema,
  /** Set for on-demand role instances (§7.5): on-call lead or merge-queue integrator. */
  ondemand: OndemandRefSchema.optional(),
  keepOpen: z.boolean(),
  itemKey: WorkItemKeySchema.optional(),
  retryOf: id.optional(),
  model: id.optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  spawnCommandId: id,
});
/**
 * S26 provider rate limit (provisional). Named `rateLimited` so it is not confused with
 * the GitHub `rate_limited` error category.
 */
const seatRateLimit = z.object({
  since: isoDateTime,
  evidence: z.enum(['worker-show', 'transcript']),
  resetsAt: isoDateTime.optional(),
});
export const SeatStatusPayloadSchema = z.object({
  attemptId: id,
  state: AttemptStateSchema,
  waitingSince: isoDateTime.optional(),
  /** Object: rate limit entered; `null`: lifted; absent: unchanged (S26, provisional). */
  rateLimited: seatRateLimit.nullable().optional(),
});
export const SeatActivityPayloadSchema = z.object({
  attemptId: id,
  activity: z.array(ActivityMetaSchema).min(1),
});
export const SeatDegradedPayloadSchema = z.object({
  attemptId: id,
  reason: z.enum([
    'no_transcript_source',
    'source_changed',
    'transcript_clipped',
  ]),
});
export const SeatPolicyViolationPayloadSchema = z.object({
  attemptId: id,
  hits: z.array(PolicyHitSchema).min(1),
});
export const SeatExitedPayloadSchema = z.object({
  attemptId: id,
  reason: z.string(),
  expected: z.boolean(),
});
export const SeatReleasedPayloadSchema = z.object({
  attemptId: id,
  removeWorkspace: z.boolean(),
});
export const AgentUnmanagedPayloadSchema = z.object({
  dispatch: id,
  parentDispatch: id.optional(),
  agentKind: z.string().optional(),
  title: z.string().optional(),
});

// meeting -------------------------------------------------------------------

export const MeetingRoundStartedPayloadSchema = z.object({
  stageId: id,
  round: positiveInt,
  attemptIds: z.array(id).min(1),
});
export const MeetingStatementPayloadSchema = z.object({
  stageId: id,
  attemptId: id,
  role: id,
  artifactId: id,
  statement: StatementSchema,
});
export const MeetingRoundCompletedPayloadSchema = z.object({
  stageId: id,
  round: positiveInt,
  statements: nonNegativeInt,
  absentAttemptIds: z.array(id),
  allReadyToConclude: z.boolean(),
});
export const MeetingConcludedPayloadSchema = z.object({
  stageId: id,
  rounds: positiveInt,
  endedEarly: z.boolean(),
  conclusionArtifactId: id,
});

// submission ----------------------------------------------------------------

/** Submitted content is stored here once (masked, §9.1); artifacts reference `submissionId`. */
export const SubmissionAcceptedPayloadSchema = z
  .object({
    submissionId: id,
    attemptId: id,
    kind: SubmissionKindSchema,
    submission: AgentSubmissionSchema,
    /** Provider session from X-AIO-Agent-Session, used for usage lookup. */
    agentSession: z
      .object({ provider: z.enum(['claude', 'codex']), id })
      .optional(),
    artifactId: id.optional(),
  })
  .refine((value) => value.kind === value.submission.kind, {
    path: ['kind'],
    message: 'kind must match submission.kind',
  });
export const SubmissionRejectionReasonSchema = z.enum([
  'schema',
  'identity_mismatch',
  'not_allowed',
  'gate_open',
]);
export const SubmissionRejectedPayloadSchema = z.object({
  reason: SubmissionRejectionReasonSchema,
  kind: SubmissionKindSchema.optional(),
  attemptId: id.optional(),
  detail: z.string().optional(),
  issues: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .optional(),
});

// message -------------------------------------------------------------------

export const MessageQuestionPayloadSchema = z.object({
  questionId: id,
  attemptId: id,
  itemKey: WorkItemKeySchema.optional(),
  body: z.string(),
});
export const MessageForwardedPayloadSchema = z.object({
  questionId: id,
  to: z.enum(['facilitator', 'on-call']),
  toAttemptId: id,
  /** 0 on first delivery; on-call failures retry each question once (§7.5). */
  retry: z.number().int().min(0).max(1),
});
export const MessageAnsweredPayloadSchema = z.object({
  questionId: id,
  by: z.enum(['agent', 'user']),
  body: z.string(),
  attemptId: id.optional(),
  optionId: id.optional(),
  gateId: id.optional(),
});
// Q10: questions never expire; timeouts escalate with reason `timeout`.
export const MessageEscalatedPayloadSchema = z.object({
  questionId: id,
  reason: z.enum([
    'timeout',
    'decision-request',
    'oncall-failed',
    'no-responder',
  ]),
  gateId: id,
});
export const MessageNudgePayloadSchema = z.object({
  attemptId: id,
  reason: z.enum([
    'missing-submission',
    'round-timeout',
    'stage-timeout',
    'item-timeout',
    'question-timeout',
    'review-timeout',
    'budget-wrap-up',
    // M2-T14 (§7.1): the one nudge after a spawn-stall period without activity.
    'spawn-stall',
  ]),
  subject: id,
  body: z.string(),
});
export const MessageInstructionPayloadSchema = z.object({
  seatId: SeatIdSchema,
  attemptId: id,
  subject: id,
  body: z.string(),
});

// on-demand role instances (§7.5; rev2.10 generalised `oncall.*`) -----------

export const OndemandStartedPayloadSchema = z.object({
  stageId: id,
  purpose: OndemandPurposeSchema,
  attemptId: id,
});
/** Queue entries are question ids (`oncall`) or work-item keys (`merge`). */
export const OndemandQueueChangedPayloadSchema = z.object({
  stageId: id,
  purpose: OndemandPurposeSchema,
  queue: z.array(id),
  current: id.optional(),
});
export const OndemandStoppedPayloadSchema = z.object({
  stageId: id,
  purpose: OndemandPurposeSchema,
  attemptId: id,
  reason: z.enum(['queue_empty', 'failed', 'stage_ended', 'cancelled']),
});

// work items ----------------------------------------------------------------

export const WorkItemProposedPayloadSchema = z.object({
  stageId: id,
  submissionId: id,
  items: z.array(WorkItemDraftSchema),
});
export const ApprovedWorkItemSchema = WorkItemDraftSchema.extend({
  agent: AgentKindSchema,
});
export const WorkItemApprovedPayloadSchema = z.object({
  gateId: id,
  items: z.array(ApprovedWorkItemSchema),
});
export const WorkItemDispatchedPayloadSchema = z.object({
  itemKey: WorkItemKeySchema,
  attemptId: id,
  attempt: positiveInt,
  agent: AgentKindSchema,
  /** `ai-office/<shortId>/<itemKey>` or `…-a<n>` for n ≥ 2 (§7.3). */
  branch: z.string().startsWith('ai-office/'),
  workspaceName: id,
  /**
   * rev2.10 §7.3: integration-branch commit the worktree was created from; it
   * contains every dependency's merge commit. Optional until dispatch records it (T14).
   */
  baseSha: GitShaSchema.optional(),
  retryOf: id.optional(),
  /** Set when this attempt answers a merge-queue `rework-request` (same branch and PR). */
  reworkOf: id.optional(),
});
export const WorkItemStatusPayloadSchema = z.object({
  itemKey: WorkItemKeySchema,
  status: WorkItemStatusSchema,
  attemptId: id.optional(),
  issue: positiveInt.optional(),
  pr: positiveInt.optional(),
  headSha: GitShaSchema.optional(),
  reason: z.string().optional(),
});
/** rev2.10 §7.3: worker PR opened (or reworked) and queued for review (§7.4a step 1). */
export const WorkItemMergeQueuedPayloadSchema = z.object({
  itemKey: WorkItemKeySchema,
  attemptId: id,
  pr: positiveInt,
  headSha: GitShaSchema,
});
/** §7.4a: the merge-queue integrator sent the PR back; `rework` counts this request (1-based). */
export const WorkItemReworkRequestedPayloadSchema = z.object({
  itemKey: WorkItemKeySchema,
  pr: positiveInt,
  submissionId: id,
  /** The merge-queue integrator's attempt that submitted the rework-request. */
  attemptId: id,
  reasons: z.array(z.string().min(1)).min(1),
  rework: positiveInt,
});
/** §7.4a: backend merge via ScmPort succeeded; later `pr.status{merged}` only confirms it. */
export const WorkItemMergedPayloadSchema = z.object({
  itemKey: WorkItemKeySchema,
  pr: positiveInt,
  mergeCommitSha: GitShaSchema,
  commandId: id,
});

// artifacts and SCM ---------------------------------------------------------

export const ArtifactKindSchema = z.enum([
  'agenda',
  'statement',
  'conclusion',
  'work-items',
  'integration-report',
  'issue',
  'branch',
  'pr',
]);
const submittedArtifact = <K extends string>(kind: K) =>
  z.object({
    artifactId: id,
    kind: z.literal(kind),
    submissionId: id,
    attemptId: id,
  });
export const ArtifactCreatedPayloadSchema = z.discriminatedUnion('kind', [
  submittedArtifact('agenda'),
  submittedArtifact('statement'),
  submittedArtifact('conclusion'),
  submittedArtifact('work-items'),
  submittedArtifact('integration-report'),
  z.object({
    artifactId: id,
    kind: z.literal('issue'),
    number: positiveInt,
    url: z.url(),
    purpose: z.enum(['conclusion', 'work-item']),
    itemKey: WorkItemKeySchema.optional(),
  }),
  z.object({
    artifactId: id,
    kind: z.literal('branch'),
    name: id,
    purpose: z.enum(['integration', 'worker']),
    itemKey: WorkItemKeySchema.optional(),
  }),
  z.object({
    artifactId: id,
    kind: z.literal('pr'),
    number: positiveInt,
    url: z.url(),
    purpose: z.enum(['worker', 'final']),
    head: id,
    base: id,
    itemKey: WorkItemKeySchema.optional(),
  }),
]);
export const PrStatusPayloadSchema = z.object({
  pr: positiveInt,
  state: z.enum(['open', 'closed', 'merged']),
  base: id,
  head: id,
  headSha: GitShaSchema,
  mergeable: z.boolean().nullable(),
  checks: z.enum(['pending', 'success', 'failure', 'none']).optional(),
  mergedBy: id.optional(),
  mergeCommitSha: GitShaSchema.optional(),
});
export const ScmIssueDriftPayloadSchema = z.object({
  issue: positiveInt,
  bodyHash: Sha256Schema,
  githubUpdatedAt: isoDateTime,
  labels: z.array(z.string()),
  itemKey: WorkItemKeySchema.optional(),
  gateId: id.optional(),
});
// §12.3 lists five anomaly kinds; lingering agents before a stage gate (§8.1) and
// reconcile give-ups (§11.5) reuse the anomaly gate.
export const AnomalyKindSchema = z.enum([
  'unknown-object',
  'unmanaged-merge',
  'early-merge',
  'default-branch-moved',
  'policy-hit',
  'agents-alive-before-gate',
  'reconcile-gave-up',
]);
export const AnomalyDetectedPayloadSchema = z.object({
  kind: AnomalyKindSchema,
  severity: z.enum(['high', 'medium', 'warning']),
  summary: z.string(),
  number: positiveInt.optional(),
  author: id.optional(),
  sha: GitShaSchema.optional(),
  attemptId: id.optional(),
  dispatch: id.optional(),
  commandId: id.optional(),
});

// usage / budget ------------------------------------------------------------

/** Deltas: application converts cumulative Codex samples before appending (§10.2). */
export const UsageTokensPayloadSchema = z.object({
  attemptId: id,
  inputUncached: nonNegativeInt,
  output: nonNegativeInt,
  cacheRead: nonNegativeInt,
  cacheWrite: nonNegativeInt,
  reasoning: nonNegativeInt.optional(),
  /** Computed with the configured budget formula at ingest time. */
  budgetTokens: nonNegativeInt,
});
export const UsageTurnsPayloadSchema = z.object({
  attemptId: id,
  turns: positiveInt,
});
const budgetBase = z.object({
  metric: z.enum(['tokens', 'turns', 'wallclock']),
  used: nonNegativeInt,
  budget: positiveInt,
  threshold: positiveInt,
  gateId: id.optional(),
});
export const BudgetScopeSchema = z.discriminatedUnion('scope', [
  budgetBase.extend({ scope: z.literal('workflow') }),
  budgetBase.extend({
    scope: z.literal('stage'),
    stageId: id,
    stageAttempt: positiveInt,
  }),
  budgetBase.extend({
    scope: z.literal('item'),
    stageId: id,
    itemKey: WorkItemKeySchema,
    attemptId: id,
  }),
]);
export const BudgetExceededPayloadSchema = BudgetScopeSchema;
export const BudgetHardLimitPayloadSchema = BudgetScopeSchema;

// timers --------------------------------------------------------------------

export const TimerPayloadSchema = z.discriminatedUnion('purpose', [
  z.object({
    purpose: z.literal('round-timeout'),
    stageId: id,
    round: positiveInt,
  }),
  z.object({
    purpose: z.literal('stage-timeout'),
    stageId: id,
    attempt: positiveInt,
  }),
  z.object({
    purpose: z.literal('item-timeout'),
    itemKey: WorkItemKeySchema,
    attemptId: id,
  }),
  z.object({ purpose: z.literal('question-timeout'), questionId: id }),
  z.object({
    purpose: z.literal('review-timeout'),
    itemKey: WorkItemKeySchema,
    attemptId: id,
  }),
  z.object({
    purpose: z.literal('ondemand-idle'),
    stageId: id,
    ondemand: OndemandPurposeSchema,
  }),
  z.object({
    purpose: z.literal('nudge-grace'),
    attemptId: id,
    reason: MessageNudgePayloadSchema.shape.reason,
  }),
  z.object({
    purpose: z.literal('gate-precheck'),
    stageId: id,
    phase: z.enum(['wait', 'restop']),
  }),
  // M2-T14 (§7.1): `nudge` fires one spawnStallMs after spawn, `gate` one more later.
  z.object({
    purpose: z.literal('spawn-stall'),
    attemptId: id,
    phase: z.enum(['nudge', 'gate']),
  }),
  z.object({
    purpose: z.literal('wallclock-hard-limit'),
    stageId: id,
    itemKey: WorkItemKeySchema.optional(),
    attemptId: id.optional(),
  }),
]);
export const TimerScheduledPayloadSchema = z.object({
  timerId: id,
  fireAt: isoDateTime,
  payload: TimerPayloadSchema,
});
export const TimerFiredPayloadSchema = z.object({ timerId: id });
export const TimerCancelledPayloadSchema = z.object({
  timerId: id,
  reason: z.string().optional(),
});

// system --------------------------------------------------------------------

export const RepoRegisteredPayloadSchema = RepoSnapshotSchema;
export const RepoUpdatedPayloadSchema = RepoSnapshotSchema.partial()
  .required({ repoId: true })
  .extend({
    status: z.enum(['registered', 'invalid']),
    issues: z.array(z.string()).optional(),
  });
export const HealthChangedPayloadSchema = z.object({
  component: z.enum(['runtime', 'scm', 'store', 'usage']),
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  breaker: z.enum(['closed', 'open', 'half_open']).optional(),
  runtimeVerified: z.boolean().optional(),
  detail: z.string().optional(),
});
export const RuntimeIdentityRestoredPayloadSchema = z.object({
  newShim: id,
  runs: z.array(id),
});
export const RuntimeIdentityHijackedPayloadSchema = z.object({
  run: id,
  coordinatorHandle: id,
  consumerGeneration: nonNegativeInt,
});
export const ErrorRecordedPayloadSchema = z.object({
  category: ErrorCategorySchema,
  code: id,
  message: z.string(),
  commandId: id.optional(),
  detail: z.string().optional(),
});
