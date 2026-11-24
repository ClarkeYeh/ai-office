import { z } from 'zod';
import { AgentKindSchema } from '../template/index.js';
import {
  ErrorInfoSchema,
  GitShaSchema,
  id,
  IssueRefSchema,
  positiveInt,
  PrRefSchema,
  RepoRuntimeRefSchema,
  RepoScmRefSchema,
  ScmTargetSchema,
  Sha256Schema,
} from './common.js';

// Runtime refs are opaque adapter values (§11.1); application and engine never parse them.
const SessionRef = id;
const AgentRef = id;
const WorkspaceRef = id;
const QuestionRef = id;

/**
 * rev2.10 §6.5/§7.3: bases resolve against the remote. With `fetchBranch` the
 * adapter runs `git fetch origin <fetchBranch>` first; `baseBranch` may then be
 * the commit sha the backend resolved for `origin/<integration branch>`.
 */
const workspaceBase = {
  baseBranch: id,
  fetchBranch: id.optional(),
};
export const WorkspaceReqSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('new-worktree'),
    ...workspaceBase,
    name: id,
    branch: id,
  }),
  z.object({
    kind: z.literal('existing-worktree'),
    workspace: WorkspaceRef,
    readOnly: z.boolean(),
  }),
]);
export const LabelSpecSchema = z.object({
  name: id,
  color: z
    .string()
    .regex(/^[0-9a-fA-F]{6}$/)
    .optional(),
  description: z.string().optional(),
});

const command = <K extends string, A extends z.ZodType>(kind: K, args: A) =>
  z.object({ kind: z.literal(kind), args });

/**
 * `command.issued.args` (Q4). Args are fully concrete so retries and reconcile
 * replay byte-identical input (§11.5). Spawned agents receive their prompt through
 * the spec file; only its path and sha256 are recorded, never the seat token.
 * Correlation comes from the event envelope (`workflowId`, `attemptId`) and `commandId`.
 */
export const ExternalCommandSchema = z.discriminatedUnion('kind', [
  command(
    'runtime.openSession',
    z.object({ repo: RepoRuntimeRefSchema, objective: z.string() }),
  ),
  command(
    'runtime.prepareWorkspace',
    z.object({
      session: SessionRef,
      repo: RepoRuntimeRefSchema,
      /** Fresh worktree on the existing remote branch; caller supplies a -r<n> name. */
      checkoutExisting: z.literal(true).optional(),
      ...workspaceBase,
      name: id,
      branch: id,
    }),
  ),
  command('runtime.reclaimSession', z.object({ session: SessionRef })),
  command('runtime.disposeWorkspace', z.object({ workspace: WorkspaceRef })),
  command('runtime.inspectWorkspace', z.object({ workspace: WorkspaceRef })),
  command(
    'runtime.spawnAgent',
    z.object({
      session: SessionRef,
      agent: AgentKindSchema,
      model: id.optional(),
      effort: z.enum(['low', 'medium', 'high']).optional(),
      title: id,
      specPath: id,
      specSha256: Sha256Schema,
      workspace: WorkspaceReqSchema,
      keepOpen: z.boolean(),
    }),
  ),
  command(
    'runtime.send',
    z.object({ agent: AgentRef, subject: id, body: z.string() }),
  ),
  command(
    'runtime.answer',
    z.object({ question: QuestionRef, body: z.string() }),
  ),
  command('runtime.stop', z.object({ agent: AgentRef })),
  command(
    'runtime.release',
    z.object({ agent: AgentRef, removeWorkspace: z.boolean() }),
  ),
  command(
    'scm.ensureLabels',
    z.object({ repo: RepoScmRefSchema, labels: z.array(LabelSpecSchema) }),
  ),
  command(
    'scm.compareBranch',
    z.object({ repo: RepoScmRefSchema, base: id, head: id }),
  ),
  command(
    'scm.ensureBranch',
    z.object({ repo: RepoScmRefSchema, name: id, from: id }),
  ),
  command(
    'scm.deleteBranch',
    z.object({
      repo: RepoScmRefSchema,
      // §11.2: only AI Office branches may be deleted; adapters also refuse the default branch.
      name: z.string().startsWith('ai-office/'),
    }),
  ),
  command(
    'scm.createIssue',
    z.object({
      repo: RepoScmRefSchema,
      title: id,
      body: z.string(),
      labels: z.array(id),
    }),
  ),
  command(
    'scm.updateIssue',
    z.object({
      issue: IssueRefSchema,
      patch: z.object({
        title: id.optional(),
        body: z.string().optional(),
        state: z.enum(['open', 'closed']).optional(),
      }),
    }),
  ),
  command(
    'scm.comment',
    z.object({ target: ScmTargetSchema, body: z.string() }),
  ),
  command(
    'scm.setLabels',
    z.object({ target: ScmTargetSchema, labels: z.array(id) }),
  ),
  command(
    'scm.openPR',
    z.object({
      repo: RepoScmRefSchema,
      title: id,
      body: z.string(),
      head: id,
      base: id,
      draft: z.boolean().optional(),
    }),
  ),
  command(
    'scm.updatePR',
    z.object({
      pr: PrRefSchema,
      patch: z.object({
        title: id.optional(),
        body: z.string().optional(),
        state: z.enum(['open', 'closed']).optional(),
      }),
    }),
  ),
  command(
    'scm.mergePR',
    z.object({
      pr: PrRefSchema,
      method: z.literal('merge'),
      expectedHeadSha: GitShaSchema,
      /** rev2.15 §7.4: integration-branch head at merge-request time; mismatch → `base_moved`. */
      expectedBaseSha: GitShaSchema.optional(),
      /** M3 S20: the base branch from our record; a PR retargeted elsewhere → `base_mismatch`. */
      expectedBase: id.optional(),
    }),
  ),
  // Only for compensating duplicate marker comments (M3 §4.8); the adapter also
  // checks author, marker and repo before deleting.
  command(
    'scm.deleteComment',
    z.object({ target: ScmTargetSchema, commentId: id }),
  ),
]);
export type ExternalCommand = z.infer<typeof ExternalCommandSchema>;
export type ExternalCommandKind = ExternalCommand['kind'];
export const EXTERNAL_COMMAND_KINDS = [
  'runtime.openSession',
  'runtime.prepareWorkspace',
  'runtime.reclaimSession',
  'runtime.disposeWorkspace',
  'runtime.inspectWorkspace',
  'runtime.spawnAgent',
  'runtime.send',
  'runtime.answer',
  'runtime.stop',
  'runtime.release',
  'scm.ensureLabels',
  'scm.compareBranch',
  'scm.ensureBranch',
  'scm.deleteBranch',
  'scm.createIssue',
  'scm.updateIssue',
  'scm.comment',
  'scm.setLabels',
  'scm.openPR',
  'scm.updatePR',
  'scm.mergePR',
  'scm.deleteComment',
] as const satisfies readonly ExternalCommandKind[];
export const ExternalCommandKindSchema = z.enum(EXTERNAL_COMMAND_KINDS);

/** Orca orchestration mutations carry a caller-chosen request ID (§11.5); others must not. */
export const ORCA_REQUEST_ID_KINDS = [
  'runtime.openSession',
  'runtime.spawnAgent',
  'runtime.send',
  'runtime.answer',
] as const satisfies readonly ExternalCommandKind[];
const requiresOrcaRequestId = (kind: ExternalCommandKind) =>
  (ORCA_REQUEST_ID_KINDS as readonly string[]).includes(kind);

export const CommandIssuedPayloadSchema = z
  .intersection(
    z.object({ commandId: id, orcaRequestId: z.uuid().optional() }),
    ExternalCommandSchema,
  )
  .superRefine((value, ctx) => {
    if (
      requiresOrcaRequestId(value.kind) !==
      (value.orcaRequestId !== undefined)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['orcaRequestId'],
        message: `orcaRequestId is required exactly for ${ORCA_REQUEST_ID_KINDS.join(', ')}`,
      });
  });

const result = <K extends ExternalCommandKind, R extends z.ZodType>(
  kind: K,
  value: R,
) => z.object({ kind: z.literal(kind), result: value });
const empty = z.object({});
/** Result recorded by `command.succeeded`; opaque refs feed later command args. */
export const CommandResultSchema = z.discriminatedUnion('kind', [
  result('runtime.reclaimSession', z.object({ reclaimed: z.boolean() })),
  result('runtime.openSession', z.object({ session: SessionRef })),
  result(
    'runtime.prepareWorkspace',
    z.object({
      workspace: WorkspaceRef,
      path: id,
      /** Commit the worktree HEAD was created at (`workitem.dispatched.baseSha`). */
      baseSha: GitShaSchema.optional(),
    }),
  ),
  result('runtime.disposeWorkspace', empty),
  result(
    'runtime.inspectWorkspace',
    z.object({ clean: z.boolean(), changedFiles: z.array(z.string()) }),
  ),
  result(
    'runtime.spawnAgent',
    z.object({
      agent: AgentRef,
      /** M5 §4.2: the agent's worktree, so cleanup reads state only; absent in older events. */
      workspace: WorkspaceRef.optional(),
    }),
  ),
  result('runtime.send', empty),
  result('runtime.answer', empty),
  result('runtime.stop', empty),
  result('runtime.release', empty),
  result('scm.ensureLabels', empty),
  result('scm.ensureBranch', empty),
  result(
    'scm.compareBranch',
    z
      .object({ ahead: z.number().int().nonnegative(), headSha: GitShaSchema })
      .nullable(),
  ),
  result('scm.deleteBranch', empty),
  result('scm.createIssue', z.object({ issue: positiveInt, url: z.url() })),
  result('scm.updateIssue', empty),
  result('scm.comment', empty),
  result('scm.setLabels', empty),
  result('scm.openPR', z.object({ pr: positiveInt, url: z.url() })),
  result('scm.updatePR', empty),
  result('scm.mergePR', z.object({ mergeCommitSha: GitShaSchema })),
  result('scm.deleteComment', empty),
]);
export const CommandSucceededPayloadSchema = z.intersection(
  z.object({ commandId: id }),
  CommandResultSchema,
);
export const CommandFailedPayloadSchema = z.object({
  commandId: id,
  kind: ExternalCommandKindSchema,
  error: ErrorInfoSchema,
  attempts: positiveInt,
});
/**
 * `found` is followed by `command.succeeded` with the recovered result; `redone`
 * re-executes with the original args; `gave_up` opens an anomaly gate (§11.5).
 */
export const CommandReconciledPayloadSchema = z.object({
  commandId: id,
  kind: ExternalCommandKindSchema,
  outcome: z.enum(['found', 'redone', 'gave_up']),
  detail: z.string().optional(),
});
export type CommandResult = z.infer<typeof CommandResultSchema>;
