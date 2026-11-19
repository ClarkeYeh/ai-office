import { PortError } from '../../ports/errors.js';
import { z } from 'zod';
export type GithubError = PortError & {
  retryAfterMs?: number;
  status?: number;
  requestId?: string;
  alreadyExists?: boolean;
};
export const CREATE_RETRY_AFTER_MS = 15_000;
export const errorBodySchema = z.looseObject({
  message: z.string().optional(),
  errors: z.array(z.looseObject({ code: z.string().optional() })).optional(),
});
export function unavailable(uncertain: boolean): GithubError {
  return Object.assign(
    new PortError(
      'transient',
      uncertain ? 'create_outcome_unknown' : 'github_unavailable',
      uncertain
        ? 'GitHub creation outcome is unknown'
        : 'GitHub is unavailable',
      true,
    ),
    uncertain ? { retryAfterMs: CREATE_RETRY_AFTER_MS } : {},
  );
}
export function contractMismatch(): GithubError {
  return new PortError(
    'contract_mismatch',
    'github_contract_mismatch',
    'GitHub response does not match the expected contract',
  );
}
export function rateLimited(code: string, retryAfterMs: number): GithubError {
  return Object.assign(
    new PortError(
      'rate_limited',
      code,
      'GitHub request budget is temporarily unavailable',
      true,
    ),
    { retryAfterMs: Math.max(0, retryAfterMs) },
  );
}
export function mapResponseError(
  status: number,
  value: unknown,
  uncertain: boolean,
): GithubError {
  const parsed = errorBodySchema.safeParse(value);
  const body = parsed.success ? parsed.data : {};
  if (status >= 500) return unavailable(uncertain);
  if (status === 401)
    return new PortError('auth', 'github_auth', 'GitHub authentication failed');
  if (status === 403)
    return new PortError(
      'permanent',
      'github_forbidden',
      'GitHub permission denied',
    );
  if (status === 404)
    return new PortError('permanent', 'not_found', 'GitHub object not found');
  if (status === 409)
    return new PortError(
      'conflict',
      'head_mismatch',
      'GitHub head does not match',
    );
  if (status === 405) {
    const rules = /rule|protect|required|check|review|restrict/i.test(
      body.message ?? '',
    );
    return new PortError(
      rules ? 'permanent' : 'conflict',
      rules ? 'merge_blocked_by_rules' : 'not_mergeable',
      'GitHub merge rejected',
    );
  }
  if (status === 422)
    return Object.assign(
      new PortError(
        'permanent',
        'github_validation',
        'GitHub validation failed',
      ),
      {
        alreadyExists:
          body.errors?.some((e) => e.code === 'already_exists') === true ||
          /already exists/i.test(body.message ?? ''),
      },
    );
  return new PortError(
    'permanent',
    'github_http_error',
    'GitHub request failed',
  );
}
