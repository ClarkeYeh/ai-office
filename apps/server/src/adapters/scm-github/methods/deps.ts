import type { RepoScmRef } from '../../../ports/refs.js';
import type { GithubHttp } from '../http/types.js';
import type { RepoAllowlist } from '../policy/repos.js';

/** Shared assembly boundary for T4 methods, T5 PR methods and T6 polling. */
export interface ScmGithubDeps {
  http: GithubHttp;
  repoAllowlist: RepoAllowlist;
  clock: () => number;
  viewerLogin: () => Promise<string>;
  defaultBranch: (repo: RepoScmRef) => Promise<string>;
  /** Persisted registration time, when supplied by the composition root. */
  registeredAt?: (repo: RepoScmRef) => string | undefined;
}
export const repoParams = (repo: RepoScmRef) => ({
  owner: repo.owner,
  repo: repo.name,
});
