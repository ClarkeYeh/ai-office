import { z } from 'zod';
import {
  AgentSubmissionSchema,
  SubmissionResponseSchema,
  SubmissionHeadersSchema,
} from '../agent-submission/index.js';
import {
  DomainEventSchema,
  ErrorCategorySchema,
  GateDecisionSchema,
  GateEditsSchema,
  type ErrorCategory,
} from '../events/index.js';
import { Sha256Schema } from '../events/common.js';
import {
  StreamQuerySchema,
  StreamMessageSchema,
  StreamHeadersSchema,
} from '../stream/index.js';
import {
  AgentKindSchema,
  WorkflowTemplateSchema,
  RoleOverridesSchema,
  BudgetSchema,
} from '../template/index.js';
import {
  GateViewSchema,
  HealthViewSchema,
  QuestionViewSchema,
  RepoViewSchema,
  SeatViewSchema,
  WorkflowReadModelSchema,
  WorkflowSummarySchema,
} from './read-model.js';

export * from './read-model.js';

const id = z.string().min(1);
const seq = z.number().int().nonnegative();

/** Known `ErrorResponse.code` values with their HTTP status and §15 category. */
export const API_ERRORS = {
  validation_failed: { status: 400, category: 'validation' },
  unauthorized: { status: 401, category: 'auth' },
  bootstrap_code_invalid: { status: 401, category: 'auth' },
  control_token_invalid: { status: 401, category: 'auth' },
  bootstrap_rate_limited: { status: 429, category: 'rate_limited' },
  forbidden_origin: { status: 403, category: 'auth' },
  forbidden_host: { status: 403, category: 'auth' },
  not_found: { status: 404, category: 'permanent' },
  version_conflict: { status: 409, category: 'conflict' },
  gate_content_changed: { status: 409, category: 'conflict' },
  gate_not_open: { status: 409, category: 'conflict' },
  workflow_slot_busy: { status: 409, category: 'conflict' },
  workflow_not_terminal: { status: 409, category: 'conflict' },
  seat_not_alive: { status: 409, category: 'conflict' },
  idempotency_key_reused: { status: 422, category: 'validation' },
  template_invalid: { status: 422, category: 'validation' },
  runtime_unverified_ack_required: { status: 428, category: 'guard' },
  agent_required: { status: 422, category: 'validation' },
  answer_question_required: { status: 422, category: 'validation' },
  approval_mismatch: { status: 422, category: 'validation' },
  auto_not_allowed: { status: 422, category: 'validation' },
  cancel_not_requested: { status: 409, category: 'conflict' },
  cancel_requested: { status: 409, category: 'conflict' },
  conclusion_issue_missing: { status: 409, category: 'conflict' },
  current_unresolved: { status: 409, category: 'conflict' },
  dependency_cycle: { status: 422, category: 'validation' },
  duplicate_gate: { status: 409, category: 'conflict' },
  duplicate_key: { status: 422, category: 'validation' },
  duplicate_question: { status: 409, category: 'conflict' },
  edits_required: { status: 422, category: 'validation' },
  empty_answer: { status: 422, category: 'validation' },
  empty_message: { status: 422, category: 'validation' },
  empty_requirement: { status: 422, category: 'validation' },
  field_not_editable: { status: 422, category: 'validation' },
  final_pr_not_started: { status: 409, category: 'conflict' },
  gate_not_approved: { status: 409, category: 'conflict' },
  gate_not_optional: { status: 422, category: 'validation' },
  gate_open: { status: 409, category: 'conflict' },
  idempotency_key_required: { status: 422, category: 'validation' },
  invalid_answerer: { status: 409, category: 'conflict' },
  invalid_exception_gate: { status: 422, category: 'validation' },
  invalid_gate_decision: { status: 422, category: 'validation' },
  invalid_github_origin: { status: 422, category: 'validation' },
  invalid_integration_branch: { status: 422, category: 'validation' },
  invalid_options: { status: 422, category: 'validation' },
  invalid_proposal: { status: 422, category: 'validation' },
  invalid_responder: { status: 422, category: 'validation' },
  invalid_short_id: { status: 422, category: 'validation' },
  invalid_stage_gate: { status: 422, category: 'validation' },
  item_key_mismatch: { status: 422, category: 'validation' },
  live_attempts: { status: 409, category: 'conflict' },
  max_revisions_exceeded: { status: 409, category: 'conflict' },
  not_conclusion: { status: 422, category: 'validation' },
  pr_not_merged: { status: 409, category: 'conflict' },
  question_answered: { status: 409, category: 'conflict' },
  question_escalated: { status: 409, category: 'conflict' },
  question_not_escalated: { status: 409, category: 'conflict' },
  question_retry_available: { status: 409, category: 'conflict' },
  question_retry_limit: { status: 409, category: 'conflict' },
  repo_not_in_orca: { status: 422, category: 'validation' },
  repo_not_main_worktree: { status: 422, category: 'validation' },
  repo_not_ready: { status: 422, category: 'validation' },
  responder_not_failed: { status: 409, category: 'conflict' },
  runtime_unavailable: { status: 503, category: 'transient' },
  scm_login_mismatch: { status: 409, category: 'conflict' },
  scm_unavailable: { status: 503, category: 'transient' },
  snapshot_required: { status: 422, category: 'validation' },
  stage_not_complete: { status: 409, category: 'conflict' },
  stage_not_planning: { status: 409, category: 'conflict' },
  store_unavailable: { status: 503, category: 'transient' },
  tokens_required: { status: 422, category: 'validation' },
  unexpected_edits: { status: 422, category: 'validation' },
  unknown_budget_stage: { status: 422, category: 'validation' },
  unknown_dependency: { status: 422, category: 'validation' },
  unknown_live_attempt: { status: 422, category: 'validation' },
  unknown_role: { status: 422, category: 'validation' },
  unknown_stage: { status: 422, category: 'validation' },
  workflow_ended: { status: 409, category: 'conflict' },
  workflow_exists: { status: 409, category: 'conflict' },
  workflow_not_started: { status: 409, category: 'conflict' },
  workflow_paused: { status: 409, category: 'conflict' },
  wrong_question_gate: { status: 409, category: 'conflict' },
  dependency_unavailable: { status: 503, category: 'transient' },
  dependency_rate_limited: { status: 429, category: 'rate_limited' },
  dependency_unauthorized: { status: 401, category: 'auth' },
  dependency_suspect_escalation: {
    status: 503,
    category: 'suspect_escalation',
  },
  dependency_identity_invalid: { status: 503, category: 'identity' },
  dependency_hijacked: { status: 409, category: 'hijacked' },
  dependency_contract_mismatch: { status: 502, category: 'contract_mismatch' },
  dependency_rejected: { status: 422, category: 'permanent' },
  dependency_conflict: { status: 409, category: 'conflict' },
  dependency_validation_failed: { status: 422, category: 'validation' },
  dependency_guard_rejected: { status: 403, category: 'guard' },
  internal_error: { status: 500, category: 'bug' },
} as const satisfies Record<
  string,
  { status: number; category: ErrorCategory }
>;
export type ApiErrorCode = keyof typeof API_ERRORS;
export const API_ERROR_CODES = Object.keys(API_ERRORS) as ApiErrorCode[];
export const ApiErrorCodeSchema = z.enum(
  API_ERROR_CODES as [ApiErrorCode, ...ApiErrorCode[]],
);
// `code` stays an open string so /v1 can add codes compatibly (§13.2); see API_ERRORS.
export const ErrorResponseSchema = z.object({
  error: z.object({
    code: id,
    category: ErrorCategorySchema,
    message: z.string(),
    retryable: z.boolean(),
    details: z.unknown().optional(),
  }),
});
export const TemplateInvalidSchema = z.object({
  file: id,
  issues: z.array(z.object({ path: z.string(), message: z.string() })),
});
export const TemplatesResponseSchema = z.object({
  valid: z.array(WorkflowTemplateSchema),
  invalid: z.array(TemplateInvalidSchema),
});
export const BudgetOverridesSchema = z.object({
  stages: z.record(id, BudgetSchema.partial()).optional(),
  workflowBudget: z.object({ tokens: z.number().int().positive() }).optional(),
  hardLimitMultiplier: z.number().min(1).optional(),
});
export const StartWorkflowRequestSchema = z.object({
  templateId: id,
  repoId: id,
  requirement: id,
  roleOverrides: RoleOverridesSchema.optional(),
  budgetOverrides: BudgetOverridesSchema.optional(),
  gateToggles: z.record(id, z.boolean()).optional(),
  acknowledgeUnverifiedRuntime: z.boolean().optional(),
});
export const StartWorkflowResponseSchema = z.object({ workflowId: id });
export const WorkflowSnapshotResponseSchema = z.object({
  readModel: WorkflowReadModelSchema,
  asOfSeq: seq,
});
export const WorkflowsResponseSchema = z.object({
  workflows: z.array(WorkflowSummarySchema),
});
export const ReposResponseSchema = z.object({ repos: z.array(RepoViewSchema) });
export const RegisterRepoRequestSchema = z.object({ localPath: id });
const sourceStatus = z.enum(['ok', 'unavailable']);
/** Known `problem` codes of a local repo candidate (open string, like error codes). */
export const REPO_CANDIDATE_PROBLEMS = ['invalid_github_origin'] as const;
/**
 * v0.1.1 repo picker, a request-time read model (nothing persisted, no
 * events): the runtime's git main worktrees and one page of the viewer's own
 * GitHub repos, matched by owner/name ignoring case. A failed source is
 * reported in `sources` and its list is empty; the other still answers.
 */
export const RepoCandidatesResponseSchema = z.object({
  local: z.array(
    z.object({
      path: id,
      displayName: id,
      github: z.object({ owner: id, name: id }).nullable(),
      registered: z.boolean(),
      /** Why it cannot be registered, an `ApiErrorCode` (e.g. `invalid_github_origin`). */
      problem: id.optional(),
    }),
  ),
  remote: z.array(
    z.object({
      owner: id,
      name: id,
      visibility: z.enum(['public', 'private']),
      archived: z.boolean(),
      pushedAt: z.string().nullable(),
      local: z.object({ path: id }).nullable(),
      registered: z.boolean(),
    }),
  ),
  sources: z.object({ orca: sourceStatus, github: sourceStatus }),
});
export const GatesResponseSchema = z.object({ gates: z.array(GateViewSchema) });
export const QuestionsResponseSchema = z.object({
  questions: z.array(QuestionViewSchema),
});
export const AcceptedResponseSchema = z.object({ accepted: z.boolean() });
export const EventsQuerySchema = z.object({
  afterSeq: seq.optional(),
  limit: z.number().int().positive().optional(),
});
export const EventsResponseSchema = z.object({
  events: z.array(DomainEventSchema),
  nextAfterSeq: seq.optional(),
});
/**
 * Q1: `githubBodyHash` is required for conclusion-gate approve/revise (checked by domain,
 * which knows the gate kind); 409 `gate_content_changed` compares only that hash.
 * `edits` kinds and editable fields are also checked by domain against the gate.
 */
export const GateDecisionRequestSchema = z.object({
  decision: GateDecisionSchema.exclude(['answer']),
  optionId: id.optional(),
  comment: z.string().optional(),
  edits: GateEditsSchema.optional(),
  /** For options with `input: 'tokens'` / `'agent'` (§8.3). */
  additionalTokens: z.number().int().positive().optional(),
  agent: AgentKindSchema.optional(),
  expectedVersion: z.number().int().positive(),
  githubBodyHash: Sha256Schema.optional(),
  /** Display-only (Q1); never used for conflict detection. */
  githubUpdatedAt: z.iso.datetime({ offset: true }).optional(),
});
export const AnswerQuestionRequestSchema = z.object({
  body: id,
  optionId: id.optional(),
});
export const SeatMessageRequestSchema = z.object({ subject: id, body: id });
export const IdempotencyHeadersSchema = z.object({ 'idempotency-key': id });
const ack = AcceptedResponseSchema;
const params = z.object({ id });
const seatParams = z.object({ seatId: id });
export interface EndpointContract {
  method: 'get' | 'post';
  path: string;
  operationId: string;
  response: z.ZodType;
  body?: z.ZodType;
  query?: z.ZodObject;
  params?: z.ZodObject;
  headers?: z.ZodObject;
  status?: number;
  contentType?: string;
}
export const apiEndpoints = [
  {
    method: 'get',
    path: '/auth/bootstrap',
    operationId: 'bootstrap',
    query: z.object({ code: id }),
    response: z.null(),
    status: 302,
  },
  {
    method: 'get',
    path: '/api/v1/health',
    operationId: 'getHealth',
    response: HealthViewSchema,
  },
  {
    method: 'get',
    path: '/api/v1/repos',
    operationId: 'listRepos',
    response: ReposResponseSchema,
  },
  {
    method: 'post',
    path: '/api/v1/repos',
    operationId: 'registerRepo',
    body: RegisterRepoRequestSchema,
    response: RepoViewSchema,
    status: 201,
  },
  {
    method: 'get',
    path: '/api/v1/repos/{id}',
    operationId: 'getRepo',
    params,
    response: RepoViewSchema,
  },
  {
    method: 'get',
    path: '/api/v1/repo-candidates',
    operationId: 'listRepoCandidates',
    response: RepoCandidatesResponseSchema,
  },
  {
    method: 'get',
    path: '/api/v1/templates',
    operationId: 'listTemplates',
    response: TemplatesResponseSchema,
  },
  {
    method: 'get',
    path: '/api/v1/templates/{id}',
    operationId: 'getTemplate',
    params,
    response: TemplatesResponseSchema,
  },
  {
    method: 'get',
    path: '/api/v1/workflows',
    operationId: 'listWorkflows',
    response: WorkflowsResponseSchema,
  },
  {
    method: 'post',
    path: '/api/v1/workflows',
    operationId: 'startWorkflow',
    body: StartWorkflowRequestSchema,
    response: StartWorkflowResponseSchema,
    status: 201,
  },
  {
    method: 'get',
    path: '/api/v1/workflows/{id}',
    operationId: 'getWorkflow',
    params,
    response: WorkflowSnapshotResponseSchema,
  },
  {
    method: 'get',
    path: '/api/v1/workflows/{id}/events',
    operationId: 'listEvents',
    params,
    query: EventsQuerySchema,
    response: EventsResponseSchema,
  },
  {
    method: 'post',
    path: '/api/v1/workflows/{id}/cancel',
    operationId: 'cancelWorkflow',
    params,
    response: ack,
  },
  {
    method: 'post',
    path: '/api/v1/workflows/{id}/cleanup',
    operationId: 'cleanupWorkflow',
    params,
    response: ack,
  },
  {
    method: 'get',
    path: '/api/v1/gates',
    operationId: 'listGates',
    query: z.object({ status: z.literal('open').optional() }),
    response: GatesResponseSchema,
  },
  {
    method: 'get',
    path: '/api/v1/gates/{id}',
    operationId: 'getGate',
    params,
    response: GateViewSchema,
  },
  {
    method: 'post',
    path: '/api/v1/gates/{id}/decision',
    operationId: 'decideGate',
    params,
    headers: IdempotencyHeadersSchema,
    body: GateDecisionRequestSchema,
    response: ack,
  },
  {
    method: 'get',
    path: '/api/v1/questions',
    operationId: 'listQuestions',
    query: z.object({ status: z.literal('escalated').optional() }),
    response: QuestionsResponseSchema,
  },
  {
    method: 'post',
    path: '/api/v1/questions/{id}/answer',
    operationId: 'answerQuestion',
    params,
    headers: IdempotencyHeadersSchema,
    body: AnswerQuestionRequestSchema,
    response: ack,
  },
  {
    method: 'get',
    path: '/api/v1/seats/{seatId}',
    operationId: 'getSeat',
    params: seatParams,
    response: SeatViewSchema,
  },
  {
    method: 'post',
    path: '/api/v1/seats/{seatId}/message',
    operationId: 'messageSeat',
    params: seatParams,
    body: SeatMessageRequestSchema,
    response: ack,
  },
  {
    method: 'get',
    path: '/api/v1/stream',
    operationId: 'streamEvents',
    query: StreamQuerySchema,
    headers: StreamHeadersSchema,
    response: StreamMessageSchema,
    contentType: 'text/event-stream',
  },
  {
    method: 'post',
    path: '/agent/v1/submissions',
    operationId: 'submitAgent',
    headers: SubmissionHeadersSchema,
    body: AgentSubmissionSchema,
    response: SubmissionResponseSchema,
  },
] as const satisfies readonly EndpointContract[];
export type StartWorkflowRequest = z.infer<typeof StartWorkflowRequestSchema>;
export type GateDecisionRequest = z.infer<typeof GateDecisionRequestSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type RepoCandidatesResponse = z.infer<
  typeof RepoCandidatesResponseSchema
>;
export type WorkflowSnapshotResponse = z.infer<
  typeof WorkflowSnapshotResponseSchema
>;
