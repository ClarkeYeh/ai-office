import type { z } from 'zod';
import type { Clock, Redactor } from '../../../ports/services.js';
import type { EndpointId } from '../policy/endpoints.js';
import type { RepoAllowlist } from '../policy/repos.js';

/** The same boundary is used by native fetch and recording/replay transports. */
export type GithubFetch = typeof globalThis.fetch;
export type TokenProvider = (options: { refresh: boolean }) => Promise<string>;
export type GithubHttpOptions = {
  fetch?: GithubFetch;
  clock?: Clock;
  sleep?: (milliseconds: number) => Promise<void>;
  tokenProvider: TokenProvider;
  repoAllowlist: RepoAllowlist;
  maskSecrets: Redactor['maskSecrets'];
  version?: string;
  timeoutMs?: number;
};
export type RequestParams = {
  owner?: string;
  repo?: string;
  number?: number;
  id?: number;
  ref?: string;
  branch?: string;
  base?: string;
  head?: string;
  sha?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};
export type RequestOptions<T> = {
  schema: z.ZodType<T>;
  /** true uses the HTTP cache; a string pins the caller's cursor ETag. */
  conditional?: boolean | string;
  /** Evidence fetched by the method layer immediately before destructive calls. */
  safety?: {
    defaultBranch?: string;
    protected?: boolean;
    author?: string;
    viewer?: string;
    body?: string;
    commandId?: string;
    actualBase?: string;
  };
};
export type GithubResponse<T> = {
  data: T;
  status: number;
  etag?: string;
  nextPage?: number;
  notModified: boolean;
};
export interface GithubHttp {
  request<T>(
    endpointId: EndpointId,
    params: RequestParams,
    options: RequestOptions<T>,
  ): Promise<GithubResponse<T>>;
  paginate<T>(
    endpointId: EndpointId,
    params: RequestParams,
    options: RequestOptions<T[]>,
  ): Promise<T[]>;
}
