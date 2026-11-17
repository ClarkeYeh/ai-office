import {
  API_ERRORS,
  type ApiErrorCode,
  type ErrorResponse,
} from '@ai-office/contracts/api';
import type { ErrorCategory } from '@ai-office/contracts/events';
import { UseCaseError } from '../application/facade.js';
import { toErrorInfo } from '../application/commands/errors.js';

/** Explicit transport translation; API status wins over historical use-case status. */
export const USE_CASE_ERRORS = {
  agent_required: 'agent_required',
  answer_question_required: 'answer_question_required',
  approval_mismatch: 'approval_mismatch',
  auto_not_allowed: 'auto_not_allowed',
  cancel_not_requested: 'cancel_not_requested',
  cancel_requested: 'cancel_requested',
  conclusion_issue_missing: 'conclusion_issue_missing',
  current_unresolved: 'current_unresolved',
  dependency_cycle: 'dependency_cycle',
  duplicate_gate: 'duplicate_gate',
  duplicate_key: 'duplicate_key',
  duplicate_question: 'duplicate_question',
  edits_required: 'edits_required',
  empty_answer: 'empty_answer',
  empty_message: 'empty_message',
  empty_requirement: 'empty_requirement',
  field_not_editable: 'field_not_editable',
  final_pr_not_started: 'final_pr_not_started',
  gate_content_changed: 'gate_content_changed',
  gate_not_approved: 'gate_not_approved',
  gate_not_open: 'gate_not_open',
  gate_not_optional: 'gate_not_optional',
  gate_open: 'gate_open',
  gate_version_conflict: 'version_conflict',
  idempotency_key_required: 'idempotency_key_required',
  idempotency_mismatch: 'idempotency_key_reused',
  invalid_answerer: 'invalid_answerer',
  invalid_exception_gate: 'invalid_exception_gate',
  invalid_gate_decision: 'invalid_gate_decision',
  invalid_github_origin: 'invalid_github_origin',
  invalid_integration_branch: 'invalid_integration_branch',
  invalid_options: 'invalid_options',
  invalid_proposal: 'invalid_proposal',
  invalid_responder: 'invalid_responder',
  invalid_short_id: 'invalid_short_id',
  invalid_stage_gate: 'invalid_stage_gate',
  item_key_mismatch: 'item_key_mismatch',
  live_attempts: 'live_attempts',
  max_revisions_exceeded: 'max_revisions_exceeded',
  no_live_attempt: 'seat_not_alive',
  not_conclusion: 'not_conclusion',
  pr_not_merged: 'pr_not_merged',
  question_answered: 'question_answered',
  question_escalated: 'question_escalated',
  question_gate_not_open: 'gate_not_open',
  question_not_escalated: 'question_not_escalated',
  question_retry_available: 'question_retry_available',
  question_retry_limit: 'question_retry_limit',
  repo_not_in_orca: 'repo_not_in_orca',
  repo_not_main_worktree: 'repo_not_main_worktree',
  responder_not_failed: 'responder_not_failed',
  runtime_unavailable: 'runtime_unavailable',
  runtime_unverified: 'runtime_unverified_ack_required',
  scm_unavailable: 'scm_unavailable',
  snapshot_required: 'snapshot_required',
  stage_not_complete: 'stage_not_complete',
  stage_not_planning: 'stage_not_planning',
  store_unavailable: 'store_unavailable',
  template_invalid: 'template_invalid',
  tokens_required: 'tokens_required',
  unexpected_edits: 'unexpected_edits',
  unknown_budget_stage: 'unknown_budget_stage',
  unknown_dependency: 'unknown_dependency',
  unknown_gate: 'not_found',
  unknown_live_attempt: 'unknown_live_attempt',
  unknown_question: 'not_found',
  unknown_repo: 'not_found',
  unknown_role: 'unknown_role',
  unknown_stage: 'unknown_stage',
  unknown_template: 'not_found',
  unknown_workflow: 'not_found',
  workflow_ended: 'workflow_ended',
  workflow_exists: 'workflow_exists',
  workflow_not_started: 'workflow_not_started',
  workflow_not_terminal: 'workflow_not_terminal',
  workflow_paused: 'workflow_paused',
  workflow_slot_busy: 'workflow_slot_busy',
  wrong_question_gate: 'wrong_question_gate',
} as const satisfies Record<string, ApiErrorCode>;

export class ApiError extends Error {
  constructor(readonly code: ApiErrorCode) {
    super(code);
  }
}
export function apiError(code: ApiErrorCode): {
  status: number;
  body: ErrorResponse;
} {
  const { status, category } = API_ERRORS[code];
  return {
    status,
    body: {
      error: {
        code,
        category,
        message: code.replaceAll('_', ' '),
        retryable: category === 'transient' || category === 'rate_limited',
      },
    },
  };
}

const CATEGORY_ERRORS: Record<ErrorCategory, ApiErrorCode> = {
  transient: 'dependency_unavailable',
  rate_limited: 'dependency_rate_limited',
  auth: 'dependency_unauthorized',
  suspect_escalation: 'dependency_suspect_escalation',
  identity: 'dependency_identity_invalid',
  hijacked: 'dependency_hijacked',
  contract_mismatch: 'dependency_contract_mismatch',
  permanent: 'dependency_rejected',
  bug: 'internal_error',
  conflict: 'dependency_conflict',
  validation: 'dependency_validation_failed',
  guard: 'dependency_guard_rejected',
};

/** Never echo adapter messages, request bodies or validation values into responses. */
export function mapError(error: unknown): {
  status: number;
  body: ErrorResponse;
} {
  if (error instanceof ApiError) return apiError(error.code);
  if (error instanceof UseCaseError) {
    const code = Object.hasOwn(USE_CASE_ERRORS, error.code)
      ? USE_CASE_ERRORS[error.code as keyof typeof USE_CASE_ERRORS]
      : 'internal_error';
    return apiError(code);
  }
  const info = toErrorInfo(error);
  if (info.category === 'bug') return apiError('internal_error');
  const code = Object.hasOwn(API_ERRORS, info.code)
    ? (info.code as ApiErrorCode)
    : CATEGORY_ERRORS[info.category];
  return apiError(code);
}
