import { z } from 'zod';
import {
  AgentSubmissionSchema,
  SubmissionResponseSchema,
  SubmissionHeadersSchema,
} from '../agent-submission/index.js';
import { DomainEventSchema } from '../events/index.js';
import {
  StreamQuerySchema,
  StreamMessageSchema,
  StreamHeadersSchema,
} from '../stream/index.js';
import {
  WorkflowTemplateSchema,
  RoleOverridesSchema,
  BudgetSchema,
} from '../template/index.js';

const id = z.string().min(1);
const seq = z.number().int().nonnegative();
// Read models are extensible skeletons until their projections are implemented in M1.
export const ReadModelSchema = z.record(z.string(), z.unknown());
export const ErrorResponseSchema = z.object({
  error: z.object({
    code: id,
    category: z.enum([
      'transient',
      'rate_limited',
      'auth',
      'identity',
      'hijacked',
      'contract_mismatch',
      'permanent',
      'bug',
      'conflict',
      'validation',
      'guard',
    ]),
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
export const WorkflowSnapshotResponseSchema = z.object({
  readModel: ReadModelSchema,
  asOfSeq: seq,
});
export const EventsQuerySchema = z.object({
  afterSeq: seq.optional(),
  limit: z.number().int().positive().optional(),
});
export const EventsResponseSchema = z.object({
  events: z.array(DomainEventSchema),
  nextAfterSeq: seq.optional(),
});
export const GateDecisionRequestSchema = z.object({
  decision: z.enum(['approve', 'revise', 'reject', 'option']),
  optionId: id.optional(),
  comment: z.string().optional(),
  edits: ReadModelSchema.optional(),
  expectedVersion: z.number().int().nonnegative(),
  githubUpdatedAt: z.iso.datetime({ offset: true }).optional(),
});
export const AnswerQuestionRequestSchema = z.object({
  body: id,
  optionId: id.optional(),
});
export const SeatMessageRequestSchema = z.object({ subject: id, body: id });
export const IdempotencyHeadersSchema = z.object({ 'idempotency-key': id });
const ack = z.object({ accepted: z.boolean() });
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
    response: ReadModelSchema,
  },
  {
    method: 'get',
    path: '/api/v1/repos',
    operationId: 'listRepos',
    response: z.object({ repos: z.array(ReadModelSchema) }),
  },
  {
    method: 'post',
    path: '/api/v1/repos',
    operationId: 'registerRepo',
    body: z.object({ localPath: id }),
    response: ReadModelSchema,
    status: 201,
  },
  {
    method: 'get',
    path: '/api/v1/repos/{id}',
    operationId: 'getRepo',
    params,
    response: ReadModelSchema,
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
    response: z.object({ workflows: z.array(ReadModelSchema) }),
  },
  {
    method: 'post',
    path: '/api/v1/workflows',
    operationId: 'startWorkflow',
    body: StartWorkflowRequestSchema,
    response: z.object({ workflowId: id }),
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
    response: z.object({ gates: z.array(ReadModelSchema) }),
  },
  {
    method: 'get',
    path: '/api/v1/gates/{id}',
    operationId: 'getGate',
    params,
    response: ReadModelSchema,
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
    response: z.object({ questions: z.array(ReadModelSchema) }),
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
    response: ReadModelSchema,
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
