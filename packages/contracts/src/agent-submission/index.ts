import { z } from 'zod';

// Submission payloads are defined in contracts/events so domain can validate them (§9.1).
export {
  AgendaSchema,
  AgentSubmissionSchema,
  AnswerQuestionSchema,
  ConclusionSchema,
  DecisionRequestReasonSchema,
  DecisionRequestSchema,
  IntegrationReportSchema,
  MergeRequestSchema,
  StatementSchema,
  SUBMISSION_KINDS,
  SubmissionKindSchema,
  WorkItemDraftSchema,
  WorkItemsSubmissionSchema,
} from '../events/submission.js';
export type {
  Agenda,
  AgentSubmission,
  Conclusion,
  DecisionRequest,
  IntegrationReport,
  Statement,
  SubmissionKind,
  WorkItemDraft,
} from '../events/submission.js';

export const CLI_EXIT_CODES = {
  SUCCESS: 0,
  SCHEMA_ERROR: 2,
  IDENTITY_OR_STATE_ERROR: 3,
  BACKEND_UNREACHABLE: 4,
} as const;
export type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES];

const submissionId = z.string().min(1);
export const MergeFailureReasonSchema = z.enum([
  'conflict',
  'checks_failed',
  'not_mergeable',
  'head_mismatch',
  'not_found',
  'guard',
]);
/**
 * §9.2/§7.4. `accepted` (200) and `merged` (200) exit 0. A merge-request that
 * outlives the 120 s wait returns `pending` (202, exit 3); resubmitting the same
 * content returns the current state. Merge failures return `failed` (409, exit 3).
 */
export const SubmissionResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('accepted'), submissionId }),
  z.object({
    status: z.literal('merged'),
    submissionId,
    pr: z.number().int().positive(),
    mergeCommitSha: z.string().regex(/^[0-9a-f]{7,64}$/),
  }),
  z.object({ status: z.literal('pending'), submissionId }),
  z.object({
    status: z.literal('failed'),
    submissionId,
    pr: z.number().int().positive(),
    reason: MergeFailureReasonSchema,
    message: z.string(),
  }),
]);
export type SubmissionResponse = z.infer<typeof SubmissionResponseSchema>;
export const SUBMISSION_RESPONSE_HTTP_STATUS = {
  accepted: 200,
  merged: 200,
  pending: 202,
  failed: 409,
} as const satisfies Record<SubmissionResponse['status'], number>;

/**
 * Shared by agent-gateway and CLI so both agree on outcomes. Statuses not listed
 * fall back to {@link exitCodeForHttpStatus}; network failures map to 4.
 */
export const HTTP_STATUS_EXIT_CODES = {
  200: CLI_EXIT_CODES.SUCCESS,
  201: CLI_EXIT_CODES.SUCCESS,
  202: CLI_EXIT_CODES.IDENTITY_OR_STATE_ERROR,
  400: CLI_EXIT_CODES.SCHEMA_ERROR,
  413: CLI_EXIT_CODES.SCHEMA_ERROR,
  422: CLI_EXIT_CODES.SCHEMA_ERROR,
  401: CLI_EXIT_CODES.IDENTITY_OR_STATE_ERROR,
  403: CLI_EXIT_CODES.IDENTITY_OR_STATE_ERROR,
  404: CLI_EXIT_CODES.IDENTITY_OR_STATE_ERROR,
  409: CLI_EXIT_CODES.IDENTITY_OR_STATE_ERROR,
  410: CLI_EXIT_CODES.IDENTITY_OR_STATE_ERROR,
} as const satisfies Record<number, CliExitCode>;
export const exitCodeForHttpStatus = (status: number): CliExitCode => {
  const known = (HTTP_STATUS_EXIT_CODES as Record<number, CliExitCode>)[status];
  if (known !== undefined) return known;
  // 5xx means the backend cannot serve the submission; treat like unreachable.
  if (status >= 500) return CLI_EXIT_CODES.BACKEND_UNREACHABLE;
  if (status >= 200 && status < 300) return CLI_EXIT_CODES.SUCCESS;
  return CLI_EXIT_CODES.IDENTITY_OR_STATE_ERROR;
};

/** `<dataDir>/runtime.json` (§9.2, §17.1): written only by the lock holder, never holds tokens. */
export const RuntimeInfoSchema = z.object({
  port: z.number().int().min(1).max(65535),
  pid: z.number().int().positive(),
  startedAt: z.iso.datetime({ offset: true }),
});
export type RuntimeInfo = z.infer<typeof RuntimeInfoSchema>;

export const SEAT_TOKEN_PREFIX = 'aio_seat_';
export const SUBMISSION_HEADER_NAMES = {
  authorization: 'authorization',
  terminalHandle: 'x-aio-terminal-handle',
  paneKey: 'x-aio-pane-key',
  agentSession: 'x-aio-agent-session',
} as const;
export const SubmissionHeadersSchema = z.object({
  [SUBMISSION_HEADER_NAMES.authorization]: z
    .string()
    .startsWith(`Bearer ${SEAT_TOKEN_PREFIX}`),
  [SUBMISSION_HEADER_NAMES.terminalHandle]: z.string().min(1).optional(),
  [SUBMISSION_HEADER_NAMES.paneKey]: z.string().min(1).optional(),
  [SUBMISSION_HEADER_NAMES.agentSession]: z.string().min(1).optional(),
});
