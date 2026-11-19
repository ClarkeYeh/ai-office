import type { ErrorCategory } from '@ai-office/contracts/events';
export class PortError extends Error {
  readonly name = 'PortError';
  constructor(
    readonly category: ErrorCategory,
    readonly code: string,
    message: string,
    readonly retryable = false,
    /**
     * PP4: wait this long before retrying (any category). Rate limits carry
     * `x-ratelimit-reset`/`Retry-After`; `create_outcome_unknown` carries the
     * marker-scan rhythm (SPEC §11.2, §15).
     */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}
