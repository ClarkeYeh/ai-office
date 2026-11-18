import { apiEndpoints } from '@ai-office/contracts/api';
import type { Operation } from './endpoints.js';
import { invalidResponse } from './errors.js';

// Loaded only behind import.meta.env.DEV; never pull schemas into production.
export function validateResponse(
  operation: Operation,
  value: unknown,
  status: number,
): void {
  const endpoint = apiEndpoints.find(
    (entry) => entry.operationId === operation,
  )!;
  if (!endpoint.response.safeParse(value).success)
    throw invalidResponse(status);
  // Validate without replacing the object: preserve additive /v1 fields.
}
