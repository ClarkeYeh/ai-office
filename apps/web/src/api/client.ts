import { endpoints, withQuery } from './endpoints.js';
import type { ApiBody, ApiQuery, ApiResponse, Operation } from './endpoints.js';
import { ApiError, httpError, invalidResponse } from './errors.js';

export interface RequestOptions {
  signal?: AbortSignal;
}
export interface DecisionOptions extends RequestOptions {
  idempotencyKey: string;
}
export interface ClientOptions {
  fetch?: typeof globalThis.fetch;
  onUnauthorized?: (error: ApiError) => void;
}

/** Create once per user action; retain across resends, discard when the action changes. */
export function createIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

/** First line, at most 60 Unicode code points; never retain the message in the client. */
export function messageSubject(body: string): string {
  return Array.from(body.split(/\r\n|\n|\r/, 1)[0] ?? '')
    .slice(0, 60)
    .join('');
}

type Request = RequestOptions & {
  id?: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  idempotencyKey?: string;
};

export function createApiClient(options: ClientOptions = {}) {
  const fetcher =
    options.fetch ??
    ((...args: Parameters<typeof globalThis.fetch>) =>
      globalThis.fetch(...args));
  async function request<K extends Operation>(
    operation: K,
    input: Request = {},
  ): Promise<ApiResponse<K>> {
    const endpoint = endpoints[operation];
    const path = endpoint.path.replace(/\{(?:id|seatId)\}/, () =>
      encodeURIComponent(input.id!),
    );
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (input.body !== undefined) headers['Content-Type'] = 'application/json';
    if (operation === 'decideGate' || operation === 'answerQuestion') {
      if (!input.idempotencyKey?.trim()) {
        throw new ApiError(0, {
          code: 'idempotency_key_required',
          category: 'validation',
          retryable: false,
          message: 'Idempotency key required',
        });
      }
      headers['Idempotency-Key'] = input.idempotencyKey;
    }
    let response: Response;
    try {
      response = await fetcher(withQuery(path, input.query ?? {}), {
        method: endpoint.method.toUpperCase(),
        headers,
        credentials: 'same-origin',
        ...(input.body === undefined
          ? {}
          : { body: JSON.stringify(input.body) }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      if (
        input.signal?.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      )
        throw error;
      throw new ApiError(0, {
        code: 'network_error',
        category: 'transient',
        retryable: true,
        message: 'API request failed',
      });
    }
    // Notify before reading the body: even an unreadable 401 must invalidate auth.
    if (response.status === 401)
      options.onUnauthorized?.(httpError(401, undefined));
    let value: unknown;
    try {
      value = await response.json();
    } catch (error) {
      if (
        input.signal?.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      )
        throw error;
      if (!response.ok) throw httpError(response.status, undefined);
      throw invalidResponse(response.status);
    }
    if (!response.ok) throw httpError(response.status, value);
    if (import.meta.env.DEV) {
      const { validateResponse } = await import('./validate.js');
      validateResponse(operation, value, response.status);
    }
    return value as ApiResponse<K>;
  }

  return {
    getHealth: (options?: RequestOptions) => request('getHealth', options),
    listRepos: (options?: RequestOptions) => request('listRepos', options),
    registerRepo: (body: ApiBody<'registerRepo'>, options?: RequestOptions) =>
      request('registerRepo', { ...options, body }),
    getRepo: (id: string, options?: RequestOptions) =>
      request('getRepo', { ...options, id }),
    listTemplates: (options?: RequestOptions) =>
      request('listTemplates', options),
    getTemplate: (id: string, options?: RequestOptions) =>
      request('getTemplate', { ...options, id }),
    listWorkflows: (options?: RequestOptions) =>
      request('listWorkflows', options),
    startWorkflow: (body: ApiBody<'startWorkflow'>, options?: RequestOptions) =>
      request('startWorkflow', { ...options, body }),
    getWorkflow: (id: string, options?: RequestOptions) =>
      request('getWorkflow', { ...options, id }),
    listEvents: (
      id: string,
      query: ApiQuery<'listEvents'> = {},
      options?: RequestOptions,
    ) => request('listEvents', { ...options, id, query }),
    cancelWorkflow: (id: string, options?: RequestOptions) =>
      request('cancelWorkflow', { ...options, id }),
    cleanupWorkflow: (id: string, options?: RequestOptions) =>
      request('cleanupWorkflow', { ...options, id }),
    listGates: (query: ApiQuery<'listGates'> = {}, options?: RequestOptions) =>
      request('listGates', { ...options, query }),
    getGate: (id: string, options?: RequestOptions) =>
      request('getGate', { ...options, id }),
    decideGate: (
      id: string,
      body: ApiBody<'decideGate'>,
      options: DecisionOptions,
    ) => request('decideGate', { ...options, id, body }),
    listQuestions: (
      query: ApiQuery<'listQuestions'> = {},
      options?: RequestOptions,
    ) => request('listQuestions', { ...options, query }),
    answerQuestion: (
      id: string,
      body: ApiBody<'answerQuestion'>,
      options: DecisionOptions,
    ) => request('answerQuestion', { ...options, id, body }),
    getSeat: (id: string, options?: RequestOptions) =>
      request('getSeat', { ...options, id }),
    messageSeat: (id: string, body: string, options?: RequestOptions) =>
      request('messageSeat', {
        ...options,
        id,
        body: {
          subject: messageSubject(body),
          body,
        } satisfies ApiBody<'messageSeat'>,
      }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
