import { z } from 'zod';
import { IssueRefSchema, PrRefSchema } from '@ai-office/contracts/events';
const envelope = z.object({
  externalKey: z.string().min(1),
  occurredAt: z.iso.datetime({ offset: true }),
});
export const ScmEventSchema = z.discriminatedUnion('type', [
  envelope.extend({
    type: z.literal('pr.state'),
    pr: PrRefSchema,
    state: z.enum(['open', 'closed', 'merged']),
    base: z.string(),
    head: z.string(),
    headSha: z.string(),
    mergeable: z.boolean().nullable(),
    mergedBy: z.string().optional(),
  }),
  envelope.extend({
    type: z.literal('pr.checks'),
    pr: PrRefSchema,
    status: z.enum(['pending', 'success', 'failure', 'none']),
  }),
  envelope.extend({
    type: z.literal('issue.edited'),
    issue: IssueRefSchema,
    bodyHash: z.string(),
    updatedAt: z.iso.datetime({ offset: true }),
    labels: z.array(z.string()),
  }),
  envelope.extend({
    type: z.literal('repo.object_created'),
    ref: z.union([IssueRefSchema, PrRefSchema]),
    author: z.string(),
    hasMarker: z.boolean(),
  }),
]);
export type ScmEvent = z.infer<typeof ScmEventSchema>;
