import type { ErrorInfo, PauseReason } from '@ai-office/domain';
import { PortError } from '../../ports/errors.js';

/** A thrown port error as recorded in `command.failed` (§15 categories). */
export const toErrorInfo = (error: unknown): ErrorInfo => {
  if (error instanceof PortError)
    return {
      category: error.category,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  // Adapters wrap expected failures in PortError; anything else is a defect.
  return {
    category: 'bug',
    code: 'unexpected_error',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
};

/** §15 transient backoff: three retries after 1s, 2s and 4s, each plus jitter. */
export const RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
/** Jitter adds up to this fraction of the base delay. */
export const RETRY_JITTER = 0.2;

/**
 * How many retries a category earns and how long to wait before retry `n`
 * (0-based). `identity` retries once at once: the runtime adapter re-runs
 * `CoordinatorIdentity.ensure()` and the same request ID is reused (§15).
 * `rate_limited` backs off like `transient`; adapters needing `Retry-After`
 * precision report `degraded` themselves.
 */
export const retryDelay = (
  category: ErrorInfo['category'],
  retry: number,
  random: () => number,
): number | undefined => {
  switch (category) {
    case 'transient':
    case 'rate_limited': {
      const base = RETRY_DELAYS_MS[retry];
      return base === undefined
        ? undefined
        : Math.round(base * (1 + RETRY_JITTER * random()));
    }
    case 'identity':
      return retry === 0 ? 0 : undefined;
    default:
      return undefined;
  }
};

/** Categories that pause the workflow after `command.failed` (§15). */
export const PAUSE_ON_FAILURE: Partial<
  Record<ErrorInfo['category'], PauseReason>
> = {
  auth: 'auth',
  identity: 'identity',
  hijacked: 'hijacked',
  contract_mismatch: 'contract_mismatch',
  bug: 'bug',
};

/** Categories also written as `error.recorded` (§15: `bug`, `guard`). */
export const RECORD_ON_FAILURE: ReadonlySet<ErrorInfo['category']> = new Set([
  'bug',
  'guard',
]);
