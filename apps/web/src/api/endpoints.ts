import type { apiEndpoints } from '@ai-office/contracts/api';

type Contract = (typeof apiEndpoints)[number];
export type Operation = Exclude<
  Contract['operationId'],
  'bootstrap' | 'streamEvents' | 'submitAgent'
>;
export type Endpoint<K extends Operation> = Extract<
  Contract,
  { operationId: K }
>;
export type ApiResponse<K extends Operation> =
  Endpoint<K>['response']['_output'];
export type ApiBody<K extends Operation> =
  Endpoint<K> extends { body: { _output: infer B } } ? B : never;
export type ApiQuery<K extends Operation> =
  Endpoint<K> extends { query: { _input: infer Q } } ? Q : never;

type Routes = { [K in Operation]: Pick<Endpoint<K>, 'method' | 'path'> };

// Runtime table is intentionally schema-free; tests compare it with apiEndpoints.
export const endpoints = {
  getHealth: { method: 'get', path: '/api/v1/health' },
  listRepos: { method: 'get', path: '/api/v1/repos' },
  registerRepo: { method: 'post', path: '/api/v1/repos' },
  getRepo: { method: 'get', path: '/api/v1/repos/{id}' },
  listRepoCandidates: { method: 'get', path: '/api/v1/repo-candidates' },
  listTemplates: { method: 'get', path: '/api/v1/templates' },
  getTemplate: { method: 'get', path: '/api/v1/templates/{id}' },
  listWorkflows: { method: 'get', path: '/api/v1/workflows' },
  startWorkflow: { method: 'post', path: '/api/v1/workflows' },
  getWorkflow: { method: 'get', path: '/api/v1/workflows/{id}' },
  listEvents: { method: 'get', path: '/api/v1/workflows/{id}/events' },
  cancelWorkflow: { method: 'post', path: '/api/v1/workflows/{id}/cancel' },
  cleanupWorkflow: { method: 'post', path: '/api/v1/workflows/{id}/cleanup' },
  listGates: { method: 'get', path: '/api/v1/gates' },
  getGate: { method: 'get', path: '/api/v1/gates/{id}' },
  decideGate: { method: 'post', path: '/api/v1/gates/{id}/decision' },
  listQuestions: { method: 'get', path: '/api/v1/questions' },
  answerQuestion: { method: 'post', path: '/api/v1/questions/{id}/answer' },
  getSeat: { method: 'get', path: '/api/v1/seats/{seatId}' },
  messageSeat: { method: 'post', path: '/api/v1/seats/{seatId}/message' },
} as const satisfies Routes;

export function withQuery(
  path: string,
  query: Record<string, string | number | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) search.set(key, String(value));
  }
  return search.size ? `${path}?${search}` : path;
}

/** Navigation owns bootstrap redirects; realtime owns EventSource lifetime. */
export const bootstrapUrl = (code: string): string =>
  withQuery('/auth/bootstrap', { code });
export const streamUrl = (
  query: { workflowId?: string; afterSeq?: number } = {},
): string => withQuery('/api/v1/stream', query);
