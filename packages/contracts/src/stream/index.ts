import { z } from 'zod';
import { DomainEventSchema } from '../events/index.js';

export const StreamQuerySchema = z.object({
  workflowId: z.string().optional(),
  afterSeq: z.number().int().nonnegative().optional(),
});
export const StreamHeadersSchema = z.object({
  'last-event-id': z.string().regex(/^\d+$/).optional(),
});
// Logical frames: keepalive is encoded as an SSE comment (:keepalive), not an event.
export const StreamMessageSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('domain'),
    id: z.string().regex(/^\d+$/),
    data: DomainEventSchema,
  }),
  z.object({
    event: z.literal('resync_required'),
    data: z.object({ reason: z.string().optional() }).optional(),
  }),
  z.object({ event: z.literal('keepalive'), comment: z.literal('keepalive') }),
]);
export type StreamMessage = z.infer<typeof StreamMessageSchema>;
export type StreamQuery = z.infer<typeof StreamQuerySchema>;
