import type { ScmPort } from '../../ports/scm.js';
import type { RepoScmRef } from '../../ports/refs.js';
import { viewerSchema } from './schemas/common.js';
import { createRepoMethods } from './methods/repo.js';
import { createBranchMethods } from './methods/branches.js';
import { createLabelMethods } from './methods/labels.js';
import { createIssueMethods } from './methods/issues.js';
import { createCommentMethods } from './methods/comments.js';
import { createPoller } from './poll/index.js';
import { createMarkerMethods } from './methods/marker.js';
import { createPrMethods } from './methods/pulls.js';
import type { ScmGithubDeps } from './methods/deps.js';
export type { ScmGithubDeps } from './methods/deps.js';
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

export type GithubScmOptions = GithubHttpOptions & {
  registeredAt?: (repo: RepoScmRef) => string | undefined;
};
export function createGithubScm(options: GithubScmOptions) {
  const http = new GithubHttpClient(options);
  let viewer: Promise<string> | undefined;
  const defaults = new Map<string, string>();
  const deps: ScmGithubDeps = {
    http,
    repoAllowlist: options.repoAllowlist,
    clock: () => (options.clock?.now() ?? new Date()).getTime(),
    viewerLogin: () => {
      viewer ??= http
        .request('user.get', {}, { schema: viewerSchema, conditional: true })
        .then((result) => result.data.login)
        .catch((error) => {
          viewer = undefined;
          throw error;
        });
      return viewer;
    },
    defaultBranch: async (repo) => {
      const key = JSON.stringify([
        repo.owner.toLowerCase(),
        repo.name.toLowerCase(),
      ]);
      const cached = defaults.get(key);
      if (cached) return cached;
      return (await inspectRepo(repo)).defaultBranch;
    },
    ...(options.registeredAt ? { registeredAt: options.registeredAt } : {}),
  };
  const repoMethods = createRepoMethods(deps);
  const inspectRepo: ScmPort['inspectRepo'] = async (repo) => {
    const result = await repoMethods.inspectRepo(repo);
    defaults.set(
      JSON.stringify([repo.owner.toLowerCase(), repo.name.toLowerCase()]),
      result.defaultBranch,
    );
    return result;
  };
  const methods: ScmPort = {
    ...repoMethods,
    inspectRepo,
    ...createBranchMethods(deps),
    ...createLabelMethods(deps),
    ...createIssueMethods(deps),
    ...createCommentMethods(deps),
    ...createMarkerMethods(deps),
    ...createPrMethods(deps, options.sleep ? { sleep: options.sleep } : {}),
    ...createPoller(deps),
  };
  return {
    ...methods,
    http,
    repoAllowlist: options.repoAllowlist,
    diagnostics: () => ({
      rateLimit: http.governor.snapshot(),
      endpoints: http.metrics.snapshot(),
    }),
  };
}
