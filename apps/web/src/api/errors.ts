import type { ErrorResponse } from '@ai-office/contracts/api';

type ErrorInfo = ErrorResponse['error'];

/** Diagnostic messages are not UI copy: render localized text using code/category. */
export class ApiError extends Error {
  readonly code: string;
  readonly category: ErrorInfo['category'];
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(
    readonly status: number,
    error: ErrorInfo,
  ) {
    super(error.message);
    this.name = 'ApiError';
    this.code = error.code;
    this.category = error.category;
    this.retryable = error.retryable;
    this.details = error.details;
  }
}

const categories = new Set<ErrorInfo['category']>([
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

export function httpError(status: number, value: unknown): ApiError {
  const error =
    typeof value === 'object' && value !== null && 'error' in value
      ? value.error
      : undefined;
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.length > 0 &&
    'message' in error &&
    typeof error.message === 'string' &&
    'category' in error &&
    categories.has(error.category as ErrorInfo['category']) &&
    'retryable' in error &&
    typeof error.retryable === 'boolean'
  ) {
    return new ApiError(status, error as ErrorInfo);
  }
  return new ApiError(status, {
    code: status === 401 ? 'unauthorized' : 'http_error',
    category: status === 401 ? 'auth' : 'contract_mismatch',
    retryable: false,
    message: `HTTP ${status}`,
  });
}

export function invalidResponse(status: number): ApiError {
  return new ApiError(status, {
    code: 'invalid_response',
    category: 'contract_mismatch',
    retryable: false,
    message: 'Invalid API response',
  });
}
