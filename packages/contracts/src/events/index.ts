import { z } from 'zod';
import {
  CommandFailedPayloadSchema,
  CommandIssuedPayloadSchema,
  CommandReconciledPayloadSchema,
  CommandSucceededPayloadSchema,
} from './commands.js';
import * as p from './payloads.js';

export * from './commands.js';
export * from './payloads.js';
export * from './submission.js';
export {
  ActivityMetaSchema,
  AttemptStateSchema,
  ErrorCategorySchema,
  ErrorInfoSchema,
  IssueRefSchema,
  OndemandPurposeSchema,
  OndemandRefSchema,
  PolicyHitSchema,
  PrRefSchema,
  RepoRuntimeRefSchema,
  RepoScmRefSchema,
  RepoSnapshotSchema,
  ScmTargetSchema,
  SeatIdSchema,
  seatIdFor,
  StageKindSchema,
  WorkItemKeySchema,
  WorkItemStatusSchema,
} from './common.js';
export type {
  ActivityMeta,
  AttemptState,
  ErrorCategory,
  OndemandPurpose,
  PolicyHit,
  RepoSnapshot,
  WorkItemStatus,
} from './common.js';

export const EventEnvelopeSchema = z.object({
  seq: z.number().int().positive(),
  id: z.ulid(),
  occurredAt: z.iso.datetime({ offset: true }),
  recordedAt: z.iso.datetime({ offset: true }),
  workflowId: z.string().nullable(),
  stageId: z.string().optional(),
  seatId: z.string().optional(),
  attemptId: z.string().optional(),
  source: z.enum(['engine', 'runtime', 'scm', 'user', 'agent', 'system']),
  provenance: z.enum(['observed', 'decided', 'inferred']),
  schemaVersion: z.number().int().positive(),
  externalKey: z.string().optional(),
  causationId: z.string().optional(),
});

// Runtime-port events (agent.output, agent.status, …) are deliberately excluded (§11.1).
export const EVENT_TYPES = [
  'workflow.started',
  'workflow.paused',
  'workflow.resumed',
  'workflow.completed',
  'workflow.failed',
  'workflow.cancel_requested',
  'workflow.cancelled',
  'stage.started',
  'stage.completed',
  'stage.failed',
  'stage.rerun_requested',
  'gate.opened',
  'gate.content_updated',
  'gate.decided',
  'gate.closed',
  'seat.spawned',
  'seat.status',
  'seat.activity',
  'seat.degraded',
  'seat.policy_violation',
  'seat.exited',
  'seat.released',
  'agent.unmanaged',
  'meeting.round_started',
  'meeting.statement',
  'meeting.round_completed',
  'meeting.concluded',
  'submission.accepted',
  'submission.rejected',
  'message.question',
  'message.forwarded',
  'message.answered',
  'message.escalated',
  'message.nudge',
  'message.instruction',
  'ondemand.started',
  'ondemand.queue_changed',
  'ondemand.stopped',
  'workitem.proposed',
  'workitem.approved',
  'workitem.dispatched',
  'workitem.status',
  'workitem.merge_queued',
  'workitem.rework_requested',
  'workitem.merged',
  'artifact.created',
  'pr.status',
  'scm.issue_drift',
  'anomaly.detected',
  'usage.tokens',
  'usage.turns',
  'budget.exceeded',
  'budget.hard_limit',
  'command.issued',
  'command.succeeded',
  'command.failed',
  'command.reconciled',
  'timer.scheduled',
  'timer.fired',
  'timer.cancelled',
  'repo.registered',
  'repo.updated',
  'health.changed',
  'runtime.identity_restored',
  'runtime.identity_hijacked',
  'error.recorded',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Payload schema per event type; sources are cited in the M1-T1 PR table. */
export const EVENT_PAYLOAD_SCHEMAS = {
  'workflow.started': p.WorkflowStartedPayloadSchema,
  'workflow.paused': p.WorkflowPausedPayloadSchema,
  'workflow.resumed': p.WorkflowResumedPayloadSchema,
  'workflow.completed': p.WorkflowCompletedPayloadSchema,
  'workflow.failed': p.WorkflowFailedPayloadSchema,
  'workflow.cancel_requested': p.WorkflowCancelRequestedPayloadSchema,
  'workflow.cancelled': p.WorkflowCancelledPayloadSchema,
  'stage.started': p.StageStartedPayloadSchema,
  'stage.completed': p.StageCompletedPayloadSchema,
  'stage.failed': p.StageFailedPayloadSchema,
  'stage.rerun_requested': p.StageRerunRequestedPayloadSchema,
  'gate.opened': p.GateOpenedPayloadSchema,
  'gate.content_updated': p.GateContentUpdatedPayloadSchema,
  'gate.decided': p.GateDecidedPayloadSchema,
  'gate.closed': p.GateClosedPayloadSchema,
  'seat.spawned': p.SeatSpawnedPayloadSchema,
  'seat.status': p.SeatStatusPayloadSchema,
  'seat.activity': p.SeatActivityPayloadSchema,
  'seat.degraded': p.SeatDegradedPayloadSchema,
  'seat.policy_violation': p.SeatPolicyViolationPayloadSchema,
  'seat.exited': p.SeatExitedPayloadSchema,
  'seat.released': p.SeatReleasedPayloadSchema,
  'agent.unmanaged': p.AgentUnmanagedPayloadSchema,
  'meeting.round_started': p.MeetingRoundStartedPayloadSchema,
  'meeting.statement': p.MeetingStatementPayloadSchema,
  'meeting.round_completed': p.MeetingRoundCompletedPayloadSchema,
  'meeting.concluded': p.MeetingConcludedPayloadSchema,
  'submission.accepted': p.SubmissionAcceptedPayloadSchema,
  'submission.rejected': p.SubmissionRejectedPayloadSchema,
  'message.question': p.MessageQuestionPayloadSchema,
  'message.forwarded': p.MessageForwardedPayloadSchema,
  'message.answered': p.MessageAnsweredPayloadSchema,
  'message.escalated': p.MessageEscalatedPayloadSchema,
  'message.nudge': p.MessageNudgePayloadSchema,
  'message.instruction': p.MessageInstructionPayloadSchema,
  'ondemand.started': p.OndemandStartedPayloadSchema,
  'ondemand.queue_changed': p.OndemandQueueChangedPayloadSchema,
  'ondemand.stopped': p.OndemandStoppedPayloadSchema,
  'workitem.proposed': p.WorkItemProposedPayloadSchema,
  'workitem.approved': p.WorkItemApprovedPayloadSchema,
  'workitem.dispatched': p.WorkItemDispatchedPayloadSchema,
  'workitem.status': p.WorkItemStatusPayloadSchema,
  'workitem.merge_queued': p.WorkItemMergeQueuedPayloadSchema,
  'workitem.rework_requested': p.WorkItemReworkRequestedPayloadSchema,
  'workitem.merged': p.WorkItemMergedPayloadSchema,
  'artifact.created': p.ArtifactCreatedPayloadSchema,
  'pr.status': p.PrStatusPayloadSchema,
  'scm.issue_drift': p.ScmIssueDriftPayloadSchema,
  'anomaly.detected': p.AnomalyDetectedPayloadSchema,
  'usage.tokens': p.UsageTokensPayloadSchema,
  'usage.turns': p.UsageTurnsPayloadSchema,
  'budget.exceeded': p.BudgetExceededPayloadSchema,
  'budget.hard_limit': p.BudgetHardLimitPayloadSchema,
  'command.issued': CommandIssuedPayloadSchema,
  'command.succeeded': CommandSucceededPayloadSchema,
  'command.failed': CommandFailedPayloadSchema,
  'command.reconciled': CommandReconciledPayloadSchema,
  'timer.scheduled': p.TimerScheduledPayloadSchema,
  'timer.fired': p.TimerFiredPayloadSchema,
  'timer.cancelled': p.TimerCancelledPayloadSchema,
  'repo.registered': p.RepoRegisteredPayloadSchema,
  'repo.updated': p.RepoUpdatedPayloadSchema,
  'health.changed': p.HealthChangedPayloadSchema,
  'runtime.identity_restored': p.RuntimeIdentityRestoredPayloadSchema,
  'runtime.identity_hijacked': p.RuntimeIdentityHijackedPayloadSchema,
  'error.recorded': p.ErrorRecordedPayloadSchema,
} as const satisfies Record<EventType, z.ZodType>;

/** Every payload is at version 1; bump per type and add an upcaster in store-sqlite (§19). */
export const CURRENT_SCHEMA_VERSION = Object.fromEntries(
  EVENT_TYPES.map((type) => [type, 1]),
) as Record<EventType, number>;

const variant = <T extends EventType>(type: T) =>
  EventEnvelopeSchema.extend({
    type: z.literal(type),
    payload: EVENT_PAYLOAD_SCHEMAS[type],
  });
type Variants<T extends readonly EventType[]> = {
  -readonly [K in keyof T]: T[K] extends EventType
    ? ReturnType<typeof variant<T[K]>>
    : never;
};
export const DomainEventSchema = z.discriminatedUnion(
  'type',
  EVENT_TYPES.map((type) => variant(type)) as Variants<typeof EVENT_TYPES>,
);
export type DomainEvent = z.infer<typeof DomainEventSchema>;
export type EventOfType<T extends EventType> = Extract<
  DomainEvent,
  { type: T }
>;
export type EventPayload<T extends EventType> = EventOfType<T>['payload'];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
/** What `domain.decide` returns; EventStore assigns `seq`, `id`, and `recordedAt`. */
export type DomainEventDraft = DistributiveOmit<
  DomainEvent,
  'seq' | 'id' | 'recordedAt'
>;
