import { z } from 'zod';
import { IssueRefSchema, PrRefSchema } from '@ai-office/contracts/events';
const sha = z.string().regex(/^[0-9a-f]{7,64}$/);
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
    mergeCommitSha: sha.optional(),
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
  // PP3: the default branch and ai-office/ branches (§11.2).
  envelope.extend({
    type: z.literal('branch.head_changed'),
    branch: z.string().min(1),
    sha,
    previousSha: sha.nullable(),
  }),
  // PP7: one command marker on two or more objects (M3_PLAN §4.8).
  envelope.extend({
    type: z.literal('object.duplicate'),
    commandId: z.string().min(1),
    kind: z.enum(['issue', 'pr', 'comment']),
    target: z.union([IssueRefSchema, PrRefSchema]).optional(),
    numbers: z.array(z.number().int().positive()).min(2).optional(),
    commentIds: z.array(z.string().min(1)).min(2).optional(),
  }),
]);
export type ScmEvent = z.infer<typeof ScmEventSchema>;
