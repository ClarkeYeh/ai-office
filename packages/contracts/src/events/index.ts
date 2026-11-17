import { z } from 'zod';

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
// Payloads remain extensible M0 skeletons; runtime-port events are deliberately excluded.
const payload = z.record(z.string(), z.unknown());
export const DomainEventSchema = z.discriminatedUnion('type', [
  EventEnvelopeSchema.extend({ type: z.literal('workflow.started'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('workflow.paused'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('workflow.resumed'), payload }),
  EventEnvelopeSchema.extend({
    type: z.literal('workflow.completed'),
    payload,
  }),
  EventEnvelopeSchema.extend({ type: z.literal('workflow.failed'), payload }),
  EventEnvelopeSchema.extend({
    type: z.literal('workflow.cancel_requested'),
    payload,
  }),
  EventEnvelopeSchema.extend({
    type: z.literal('workflow.cancelled'),
    payload,
  }),
  EventEnvelopeSchema.extend({ type: z.literal('stage.started'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('stage.completed'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('stage.failed'), payload }),
  EventEnvelopeSchema.extend({
    type: z.literal('stage.rerun_requested'),
    payload,
  }),
  EventEnvelopeSchema.extend({ type: z.literal('gate.opened'), payload }),
  EventEnvelopeSchema.extend({
    type: z.literal('gate.content_updated'),
    payload,
  }),
  EventEnvelopeSchema.extend({ type: z.literal('gate.decided'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('gate.closed'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('seat.spawned'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('seat.status'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('seat.activity'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('seat.degraded'), payload }),
  EventEnvelopeSchema.extend({
    type: z.literal('seat.policy_violation'),
    payload,
  }),
  EventEnvelopeSchema.extend({ type: z.literal('seat.exited'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('seat.released'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('agent.unmanaged'), payload }),
  EventEnvelopeSchema.extend({
    type: z.literal('meeting.round_started'),
    payload,
  }),
  EventEnvelopeSchema.extend({ type: z.literal('meeting.statement'), payload }),
  EventEnvelopeSchema.extend({
    type: z.literal('meeting.round_completed'),
    payload,
  }),
  EventEnvelopeSchema.extend({ type: z.literal('meeting.concluded'), payload }),
  EventEnvelopeSchema.extend({
    type: z.literal('submission.accepted'),
    payload,
  }),
  EventEnvelopeSchema.extend({
    type: z.literal('submission.rejected'),
    payload,
  }),
  EventEnvelopeSchema.extend({ type: z.literal('message.question'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('message.forwarded'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('message.answered'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('message.escalated'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('message.nudge'), payload }),
  EventEnvelopeSchema.extend({
    type: z.literal('message.instruction'),
    payload,
  }),
  EventEnvelopeSchema.extend({ type: z.literal('oncall.started'), payload }),
  EventEnvelopeSchema.extend({
    type: z.literal('oncall.queue_changed'),
    payload,
  }),
  EventEnvelopeSchema.extend({ type: z.literal('oncall.stopped'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('workitem.proposed'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('workitem.approved'), payload }),
  EventEnvelopeSchema.extend({
    type: z.literal('workitem.dispatched'),
    payload,
  }),
  EventEnvelopeSchema.extend({ type: z.literal('workitem.status'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('artifact.created'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('pr.status'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('scm.issue_drift'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('anomaly.detected'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('usage.tokens'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('usage.turns'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('budget.exceeded'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('budget.hard_limit'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('command.issued'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('command.succeeded'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('command.failed'), payload }),
  EventEnvelopeSchema.extend({
    type: z.literal('command.reconciled'),
    payload,
  }),
  EventEnvelopeSchema.extend({ type: z.literal('timer.scheduled'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('timer.fired'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('timer.cancelled'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('repo.registered'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('repo.updated'), payload }),
  EventEnvelopeSchema.extend({ type: z.literal('health.changed'), payload }),
  EventEnvelopeSchema.extend({
    type: z.literal('runtime.identity_restored'),
    payload,
  }),
  EventEnvelopeSchema.extend({
    type: z.literal('runtime.identity_hijacked'),
    payload,
  }),
  EventEnvelopeSchema.extend({ type: z.literal('error.recorded'), payload }),
]);
export type DomainEvent = z.infer<typeof DomainEventSchema>;
export type EventType = DomainEvent['type'];
