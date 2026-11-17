import { z } from 'zod';
import {
  ActivityMetaSchema,
  AttemptStateSchema,
  ErrorCategorySchema,
  GitShaSchema,
  id,
  isoDateTime,
  nonNegativeInt,
  PolicyHitSchema,
  positiveInt,
  RepoSnapshotSchema,
  SeatIdSchema,
  Sha256Schema,
  StageKindSchema,
  WorkItemKeySchema,
  WorkItemStatusSchema,
} from '../events/common.js';
import {
  AnomalyDetectedPayloadSchema,
  AppliedBudgetsSchema,
  ArtifactKindSchema,
  AttemptPurposeSchema,
  ExceptionKindSchema,
  GateContentSchema,
  GateDecisionSchema,
  GateOptionSchema,
  HealthChangedPayloadSchema,
  MessageEscalatedPayloadSchema,
  PauseReasonSchema,
  PrStatusPayloadSchema,
  SeatDegradedPayloadSchema,
  StageFailedPayloadSchema,
  StageModeSchema,
  WorkflowFailedPayloadSchema,
  WorkflowLimitsSchema,
} from '../events/payloads.js';
import { ConclusionSchema, WorkItemDraftSchema } from '../events/submission.js';
import {
  AgentKindSchema,
  GateSchema,
  RoleOverridesSchema,
  WorkflowTemplateSchema,
} from '../template/index.js';

// Read models are built by projection from events (§13.3, §22.2); every field must be
// derivable by replaying events unless marked as filled at request time.

// shared --------------------------------------------------------------------

/** Summed `usage.tokens` deltas (§10.2); `reasoning` is 0 when no sample reported it. */
export const TokenUsageSchema = z.object({
  inputUncached: nonNegativeInt,
  output: nonNegativeInt,
  cacheRead: nonNegativeInt,
  cacheWrite: nonNegativeInt,
  reasoning: nonNegativeInt,
  budgetTokens: nonNegativeInt,
  turns: nonNegativeInt,
});
/** Whiteboard budget bar (§22.1); `hardLimit` = budget × hardLimitMultiplier (§10.1). */
export const BudgetBarSchema = z.object({
  scope: z.enum(['workflow', 'stage', 'item']),
  stageId: id.optional(),
  itemKey: WorkItemKeySchema.optional(),
  metric: z.enum(['tokens', 'turns', 'wallclock']),
  used: nonNegativeInt,
  budget: positiveInt,
  hardLimit: positiveInt,
  level: z.enum(['ok', 'exceeded', 'hard_limit']),
});
export const ErrorViewSchema = z.object({
  seq: positiveInt,
  at: isoDateTime,
  category: ErrorCategorySchema,
  code: id,
  message: z.string(),
  commandId: id.optional(),
  attemptId: id.optional(),
  detail: z.string().optional(),
});
export const AnomalyViewSchema = AnomalyDetectedPayloadSchema.extend({
  seq: positiveInt,
  at: isoDateTime,
  gateId: id.optional(),
});
/** Outbox tray item (§22.1); SCM fields are present for issue/branch/pr kinds only. */
export const ArtifactRefSchema = z.object({
  artifactId: id,
  kind: ArtifactKindSchema,
  at: isoDateTime,
  stageId: id.optional(),
  attemptId: id.optional(),
  submissionId: id.optional(),
  itemKey: WorkItemKeySchema.optional(),
  number: positiveInt.optional(),
  url: z.url().optional(),
  name: id.optional(),
  purpose: z.string().optional(),
});
export const PrSummarySchema = PrStatusPayloadSchema.omit({ pr: true }).extend({
  number: positiveInt,
  url: z.url().optional(),
  purpose: z.enum(['worker', 'final']),
  itemKey: WorkItemKeySchema.optional(),
  updatedAt: isoDateTime,
});

// seats / attempts ----------------------------------------------------------

export const AttemptViewSchema = z.object({
  attemptId: id,
  attempt: positiveInt,
  stageId: id,
  role: id,
  agent: AgentKindSchema,
  purpose: AttemptPurposeSchema,
  /** Q10: on-call attempts share the `onCall.role` seat. */
  oncall: z.boolean(),
  itemKey: WorkItemKeySchema.optional(),
  retryOf: id.optional(),
  state: AttemptStateSchema,
  degraded: z.boolean(),
  degradedReason: SeatDegradedPayloadSchema.shape.reason.optional(),
  waitingSince: isoDateTime.optional(),
  startedAt: isoDateTime,
  endedAt: isoDateTime.optional(),
  exitReason: z.string().optional(),
  released: z.boolean(),
  usage: TokenUsageSchema,
});
export const ActivityViewSchema = ActivityMetaSchema.extend({
  attemptId: id,
  at: isoDateTime,
});
export const SEAT_RECENT_ACTIVITY_LIMIT = 20;
/** Agent detail panel (§22.1); never contains transcript text (§20). */
export const SeatViewSchema = z.object({
  seatId: SeatIdSchema,
  workflowId: id,
  role: id,
  itemKey: WorkItemKeySchema.optional(),
  /** Latest attempt's values; null before the first spawn. */
  agent: AgentKindSchema.nullable(),
  state: AttemptStateSchema.nullable(),
  degraded: z.boolean(),
  currentAttemptId: id.optional(),
  currentWorkItem: WorkItemKeySchema.optional(),
  /** Newest last, at most SEAT_RECENT_ACTIVITY_LIMIT entries. */
  recentActivity: z.array(ActivityViewSchema).max(SEAT_RECENT_ACTIVITY_LIMIT),
  attempts: z.array(AttemptViewSchema),
  policyHits: z.array(PolicyHitSchema.extend({ attemptId: id })),
  usage: TokenUsageSchema,
  errors: z.array(ErrorViewSchema),
});

// gates ---------------------------------------------------------------------

/**
 * §4 gate states. Exception gates resolved by an option or answer end as `approved`;
 * the chosen option and decision kind stay in `GateView.decision`.
 */
export const GateStatusSchema = z.enum([
  'open',
  'approved',
  'revised',
  'rejected',
  'closed',
]);
/**
 * Conclusion gate diff info (§8.2). `changedOnGithub` is `githubBodyHash !== renderedHash`;
 * the UI must send `githubBodyHash` back with approve/revise (Q1).
 */
export const ConclusionGateViewSchema = z.object({
  original: ConclusionSchema.nullable(),
  renderedHash: Sha256Schema,
  githubBodyHash: Sha256Schema.optional(),
  githubUpdatedAt: isoDateTime.optional(),
  changedOnGithub: z.boolean(),
  /** Not in events: filled by `GET /gates/{id}` from the live issue for the diff view. */
  githubBody: z.string().optional(),
});
export const GateViewSchema = z.object({
  gateId: id,
  workflowId: id,
  stageId: id,
  kind: z.enum(['stage', 'exception']),
  templateGateId: id.optional(),
  stageKind: StageKindSchema.extract([
    'meeting',
    'planning',
    'final-pr',
  ]).optional(),
  optional: z.boolean().optional(),
  exceptionKind: ExceptionKindSchema.optional(),
  title: z.string().min(1),
  status: GateStatusSchema,
  /** Send as `expectedVersion`; increments on every content change (§4). */
  version: positiveInt,
  options: z.array(GateOptionSchema),
  content: GateContentSchema,
  openedAt: isoDateTime,
  conclusion: ConclusionGateViewSchema.optional(),
  /** Planning gate: proposed items; template `editable` fields limit revise edits. */
  workItems: z.array(WorkItemDraftSchema).optional(),
  editable: GateSchema.shape.editable,
  pr: PrSummarySchema.optional(),
  /** Question-escalation gates are decided via `POST /questions/{id}/answer`. */
  questionId: id.optional(),
  decision: z
    .object({
      decision: GateDecisionSchema,
      by: z.enum(['user', 'auto']),
      at: isoDateTime,
      optionId: id.optional(),
      comment: z.string().optional(),
    })
    .optional(),
  closedAt: isoDateTime.optional(),
  closeReason: z.enum(['merged', 'cancelled', 'superseded']).optional(),
});

// questions -----------------------------------------------------------------

/** Q10: no `expired`; timeouts escalate. */
export const QuestionStatusSchema = z.enum([
  'open',
  'forwarded',
  'answered',
  'escalated',
]);
export const QuestionViewSchema = z.object({
  questionId: id,
  workflowId: id,
  attemptId: id,
  seatId: SeatIdSchema,
  role: id,
  itemKey: WorkItemKeySchema.optional(),
  body: z.string(),
  status: QuestionStatusSchema,
  askedAt: isoDateTime,
  forwardedTo: z.enum(['facilitator', 'on-call']).optional(),
  escalation: z
    .object({
      reason: MessageEscalatedPayloadSchema.shape.reason,
      gateId: id,
      at: isoDateTime,
      options: z.array(GateOptionSchema),
    })
    .optional(),
  answer: z
    .object({
      by: z.enum(['agent', 'user']),
      body: z.string(),
      at: isoDateTime,
      optionId: id.optional(),
    })
    .optional(),
});

// work items ----------------------------------------------------------------

export const WorkItemViewSchema = WorkItemDraftSchema.extend({
  agent: AgentKindSchema.optional(),
  status: WorkItemStatusSchema,
  /** Number of dispatches so far (§7.3 `-a<n>` suffix). */
  attempts: nonNegativeInt,
  currentAttemptId: id.optional(),
  seatId: SeatIdSchema.optional(),
  branch: z.string().optional(),
  workspaceName: id.optional(),
  issue: z.object({ number: positiveInt, url: z.url().optional() }).optional(),
  pr: PrSummarySchema.optional(),
  headSha: GitShaSchema.optional(),
  reason: z.string().optional(),
  usage: TokenUsageSchema,
});

// stages --------------------------------------------------------------------

export const StageStatusSchema = z.enum([
  'pending',
  'running',
  'awaiting_gate',
  'done',
  'failed',
]);
export const StageRunViewSchema = z.object({
  attempt: positiveInt,
  mode: StageModeSchema,
  startedAt: isoDateTime,
  endedAt: isoDateTime.optional(),
  outcome: z.enum(['completed', 'failed']).optional(),
  failReason: StageFailedPayloadSchema.shape.reason.optional(),
  feedback: z.string().optional(),
  agentOverride: AgentKindSchema.optional(),
});
export const MeetingViewSchema = z.object({
  round: nonNegativeInt,
  maxRounds: positiveInt,
  concluded: z.boolean(),
  /** Speech bubbles (§22.1) come from `position`; full statements stay in artifacts. */
  statements: z.array(
    z.object({
      round: positiveInt,
      role: id,
      attemptId: id,
      artifactId: id,
      position: z.string(),
      readyToConclude: z.boolean(),
      at: isoDateTime,
    }),
  ),
});
export const OncallViewSchema = z.object({
  active: z.boolean(),
  attemptId: id.optional(),
  queue: z.array(id),
  current: id.optional(),
});
export const StageViewSchema = z.object({
  stageId: id,
  kind: StageKindSchema,
  status: StageStatusSchema,
  /** Stage attempts (reruns/revisions); empty while pending. */
  runs: z.array(StageRunViewSchema),
  gateId: id.optional(),
  meeting: MeetingViewSchema.optional(),
  oncall: OncallViewSchema.optional(),
  usage: TokenUsageSchema,
});

// workflow ------------------------------------------------------------------

export const WorkflowStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'cancelled',
]);
export const UsageViewSchema = z.object({
  total: TokenUsageSchema,
  byStage: z.record(id, TokenUsageSchema),
  byAgent: z.partialRecord(AgentKindSchema, TokenUsageSchema),
  bySeat: z.record(SeatIdSchema, TokenUsageSchema),
});
export const WorkflowReadModelSchema = z.object({
  workflowId: id,
  shortId: id,
  template: WorkflowTemplateSchema,
  repo: RepoSnapshotSchema,
  requirement: z.string().min(1),
  integrationBranch: id,
  roleOverrides: RoleOverridesSchema,
  gateToggles: z.record(id, z.boolean()),
  budgets: AppliedBudgetsSchema,
  limits: WorkflowLimitsSchema,
  status: WorkflowStatusSchema,
  /** `paused` is an overlay: non-empty means paused, each reason resumes independently. */
  pausedReasons: z.array(PauseReasonSchema),
  cancelRequested: z.boolean(),
  startedAt: isoDateTime,
  endedAt: isoDateTime.optional(),
  outcome: z
    .object({
      finalPr: positiveInt.optional(),
      mergeCommitSha: GitShaSchema.optional(),
      failReason: WorkflowFailedPayloadSchema.shape.reason.optional(),
      detail: z.string().optional(),
    })
    .optional(),
  currentStageId: id.nullable(),
  stages: z.array(StageViewSchema),
  gates: z.array(GateViewSchema),
  seats: z.array(SeatViewSchema),
  workItems: z.array(WorkItemViewSchema),
  questions: z.array(QuestionViewSchema),
  artifacts: z.array(ArtifactRefSchema),
  prs: z.array(PrSummarySchema),
  usage: UsageViewSchema,
  budgetBars: z.array(BudgetBarSchema),
  errors: z.array(ErrorViewSchema),
  anomalies: z.array(AnomalyViewSchema),
  /** Seq of the last event applied; equals `asOfSeq` in snapshot responses. */
  lastSeq: nonNegativeInt,
});
export const WorkflowSummarySchema = z.object({
  workflowId: id,
  shortId: id,
  templateId: id,
  templateName: z.string(),
  repoId: id,
  repoFullName: id,
  requirement: z.string().min(1),
  status: WorkflowStatusSchema,
  pausedReasons: z.array(PauseReasonSchema),
  currentStageId: id.nullable(),
  currentStageKind: StageKindSchema.nullable(),
  progress: z.object({ stagesDone: nonNegativeInt, stagesTotal: positiveInt }),
  openGates: nonNegativeInt,
  escalatedQuestions: nonNegativeInt,
  budgetTokens: nonNegativeInt,
  workflowBudgetTokens: positiveInt.optional(),
  startedAt: isoDateTime,
  endedAt: isoDateTime.optional(),
});

// repos / health ------------------------------------------------------------

/** §17.3 registration result; snapshot fields mirror the latest `repo.*` event. */
export const RepoViewSchema = RepoSnapshotSchema.extend({
  status: z.enum(['registered', 'invalid']),
  issues: z.array(z.string()),
  registeredAt: isoDateTime,
  updatedAt: isoDateTime,
});
const healthStatus = HealthChangedPayloadSchema.shape.status;
const healthComponent = z.object({
  status: healthStatus,
  breaker: HealthChangedPayloadSchema.shape.breaker,
  detail: z.string().optional(),
  checkedAt: isoDateTime.optional(),
});
/**
 * §13.2 health; `runtime.mode: fake` is shown in the banner (Q7).
 * TODO(M1-T26): the shim, scm.rateLimit, usage.sources, and adapters sub-structures are
 * provisional until HealthMonitor defines what it actually collects.
 */
export const HealthViewSchema = z.object({
  status: healthStatus,
  runtime: healthComponent.extend({
    mode: z.enum(['orca', 'fake']),
    version: z.string().optional(),
    verified: z.boolean(),
    shim: z
      .object({
        status: z.enum(['ok', 'missing', 'rebuilding']),
        location: z.string().optional(),
      })
      .optional(),
    runOwned: z.boolean().optional(),
    cliCallsPerMinute: nonNegativeInt.optional(),
  }),
  scm: healthComponent.extend({
    login: id.optional(),
    rateLimit: z
      .object({
        limit: nonNegativeInt,
        remaining: nonNegativeInt,
        resetAt: isoDateTime,
      })
      .optional(),
  }),
  store: healthComponent,
  usage: healthComponent.extend({
    sources: z.array(
      z.object({
        agent: AgentKindSchema,
        source: z.string(),
        available: z.boolean(),
      }),
    ),
  }),
  adapters: z.array(
    z.object({
      adapter: id,
      calls: nonNegativeInt,
      failures: nonNegativeInt,
      lastErrorCategory: ErrorCategorySchema.optional(),
    }),
  ),
});

export type TokenUsage = z.infer<typeof TokenUsageSchema>;
export type BudgetBar = z.infer<typeof BudgetBarSchema>;
export type AttemptView = z.infer<typeof AttemptViewSchema>;
export type SeatView = z.infer<typeof SeatViewSchema>;
export type GateView = z.infer<typeof GateViewSchema>;
export type QuestionView = z.infer<typeof QuestionViewSchema>;
export type WorkItemView = z.infer<typeof WorkItemViewSchema>;
export type StageView = z.infer<typeof StageViewSchema>;
export type WorkflowReadModel = z.infer<typeof WorkflowReadModelSchema>;
export type WorkflowSummary = z.infer<typeof WorkflowSummarySchema>;
export type RepoView = z.infer<typeof RepoViewSchema>;
export type HealthView = z.infer<typeof HealthViewSchema>;
