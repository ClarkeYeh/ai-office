import type { RequestParams, RequestOptions } from './request.js';
export type { RequestParams, RequestOptions } from './request.js';
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
