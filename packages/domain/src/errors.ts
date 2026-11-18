import type {
  DomainEventDraft,
  ErrorCategory,
} from '@ai-office/contracts/events';

/**
 * A rejected command (§4: decide enforces invariants). `category` follows §15 so
 * application can map it to HTTP status / CLI exit codes without inspecting `code`.
 */
export interface DomainError {
  category: ErrorCategory;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type DecideResult =
  { ok: true; events: DomainEventDraft[] } | { ok: false; error: DomainError };

export const domainError = (
  category: ErrorCategory,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): DomainError =>
  details === undefined
    ? { category, code, message }
    : { category, code, message, details };

export const accept = (...events: DomainEventDraft[]): DecideResult => ({
  ok: true,
  events,
});

export const reject = (
  category: ErrorCategory,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): DecideResult => ({
  ok: false,
  error: domainError(category, code, message, details),
});
