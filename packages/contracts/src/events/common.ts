import { z } from 'zod';
import { AgentKindSchema } from '../template/index.js';

export const id = z.string().min(1);
export const positiveInt = z.number().int().positive();
export const nonNegativeInt = z.number().int().nonnegative();
export const isoDateTime = z.iso.datetime({ offset: true });
export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const GitShaSchema = z.string().regex(/^[0-9a-f]{7,64}$/);

// Work-item keys appear in branch and worktree names (§7.3), so they stay branch-safe.
export const WorkItemKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);

/**
 * Seats are `(workflow, role[, workItem])` (§4). On-demand role instances (§7.5:
 * on-call lead, merge-queue integrator) share their role's seat and mark their
 * attempts with `ondemand: { purpose }` (Q10, rev2.10).
 */
export const SeatIdSchema = z.string().min(1);
export const seatIdFor = (seat: {
  workflowId: string;
  role: string;
  itemKey?: string;
}): string =>
  [seat.workflowId, seat.role, seat.itemKey]
    .filter((part): part is string => part !== undefined)
    .map(encodeURIComponent)
    .join(':');

export const StageKindSchema = z.enum([
  'meeting',
  'planning',
  'implement',
  'integrate',
  'final-pr',
]);

export const AttemptStateSchema = z.enum([
  'starting',
  'working',
  'waiting_input',
  'idle',
  'done',
  'error',
  'exited',
  'lost',
]);

export const WorkItemStatusSchema = z.enum([
  'proposed',
  'approved',
  'dispatched',
  'in_progress',
  'pushed',
  'pr_open',
  // rev2.10 progressive merge (§4): pr_open → merge_queued → in_review → merged;
  // in_review → rework → dispatched (new attempt, same branch and PR).
  'merge_queued',
  'in_review',
  'rework',
  'merged',
  'needs_attention',
  'skipped',
  'failed',
]);

/** §7.5 on-demand role instances; `merge` is the implement-stage merge queue. */
export const OndemandPurposeSchema = z.enum(['oncall', 'merge']);
export const OndemandRefSchema = z.object({ purpose: OndemandPurposeSchema });

// §15's 12 categories. Runtime adapters normally resolve `suspect_escalation` (§11.1)
// before it reaches the engine, but it stays a valid recorded category.
export const ErrorCategorySchema = z.enum([
  'transient',
  'rate_limited',
  'auth',
  'suspect_escalation',
  'identity',
  'hijacked',
  'contract_mismatch',
  'permanent',
  'bug',
  'conflict',
  'validation',
  'guard',
]);
export const ErrorInfoSchema = z.object({
  category: ErrorCategorySchema,
  code: id,
  message: z.string(),
  retryable: z.boolean(),
});

// §11.3: moved into contracts so the frontend can render activity and policy hits.
export const ActivityMetaSchema = z.object({
  messageId: id,
  tool: z.string().optional(),
  category: z.enum([
    'read',
    'edit',
    'shell',
    'git',
    'network',
    'orca',
    'other',
  ]),
  ok: z.boolean().optional(),
  durationMs: nonNegativeInt.optional(),
  inputLen: nonNegativeInt,
  outputLen: nonNegativeInt,
  inputHash: id,
});
export const PolicyHitSchema = z.object({
  rule: z.enum([
    'orca-dispatch',
    'orca-run-use',
    'orca-worker-stop',
    'orca-agent-launch',
    'gh-merge',
    'gh-comment',
    'push-default-branch',
    'gh-label',
    // rev2.15 §11.3 (M3-CP1): PRs and Issues are created only by the backend via ScmPort.
    'gh-pr-create',
    'gh-pr-edit',
    'gh-issue-create',
    // M5 §4.1: an agent ran `ai-office open` or read `control.token` (argv match).
    'aio-open',
  ]),
  severity: z.enum(['high', 'medium']),
  messageId: id,
});

export const RepoScmRefSchema = z.object({ owner: id, name: id });
export const RepoRuntimeRefSchema = z.object({
  orcaRepoId: id,
  localPath: id,
});
export const IssueRefSchema = z.object({
  repo: RepoScmRefSchema,
  number: positiveInt,
});
export const PrRefSchema = z.object({
  repo: RepoScmRefSchema,
  number: positiveInt,
});
export const ScmTargetSchema = IssueRefSchema.extend({
  type: z.enum(['issue', 'pr']),
});

/** Repo facts resolved at registration (§17.3) and snapshotted into each workflow. */
export const RepoSnapshotSchema = z.object({
  repoId: id,
  localPath: id,
  orcaRepoId: id,
  github: RepoScmRefSchema,
  defaultBranch: id,
  visibility: z.enum(['public', 'private']),
  ownerLogin: id,
  defaultBranchProtected: z.union([z.boolean(), z.literal('unknown')]),
  /** rev2.15 §17.3: `false` means the repo cannot start a workflow (`repo_not_ready`). */
  allowMergeCommit: z.boolean().optional(),
  /** rev2.15 §17.3 warning strings (M3 §8.6), usable as i18n keys. */
  warnings: z.array(z.string()).optional(),
});

export { AgentKindSchema };
export type AttemptState = z.infer<typeof AttemptStateSchema>;
export type WorkItemStatus = z.infer<typeof WorkItemStatusSchema>;
export type OndemandPurpose = z.infer<typeof OndemandPurposeSchema>;
export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;
export type ActivityMeta = z.infer<typeof ActivityMetaSchema>;
export type PolicyHit = z.infer<typeof PolicyHitSchema>;
export type RepoSnapshot = z.infer<typeof RepoSnapshotSchema>;
