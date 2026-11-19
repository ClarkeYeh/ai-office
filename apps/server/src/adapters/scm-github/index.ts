import { GithubHttpClient } from './http/client.js';
import type { GithubHttpOptions } from './http/types.js';
export { GithubHttpClient } from './http/client.js';
export type {
  GithubHttp,
  GithubHttpOptions,
  GithubFetch,
  GithubResponse,
  RequestOptions,
  RequestParams,
  TokenProvider,
} from './http/types.js';
export { RepoAllowlist } from './policy/repos.js';
export type { EndpointId } from './policy/endpoints.js';
export {
  viewerSchema,
  rateLimitSchema,
  emptySchema,
} from './schemas/common.js';
/** Base factory: T4 composes the ScmPort methods around this shared transport. */
export function createGithubScm(options: GithubHttpOptions) {
  const http = new GithubHttpClient(options);
  return {
    http,
    repoAllowlist: options.repoAllowlist,
    diagnostics: () => ({
      rateLimit: http.governor.snapshot(),
      endpoints: http.metrics.snapshot(),
    }),
  };
}
