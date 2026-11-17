import type { ErrorCategory } from '@ai-office/contracts/events';
export class PortError extends Error {
  readonly name = 'PortError';
  constructor(
    readonly category: ErrorCategory,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}
