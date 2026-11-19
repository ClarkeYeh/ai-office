import type { RepoScmRef } from '../../../ports/refs.js';
import type { GithubHttp } from '../http/types.js';
import type { RepoAllowlist } from '../policy/repos.js';
/**
 * Structural copy of T4's `methods/deps.ts` `ScmGithubDeps`; switch to that
 * import once it merges. The poller reads only `http`, `clock`, `viewerLogin`
 * and `defaultBranch`.
 */
export type ScmGithubDeps = {
  http: GithubHttp;
  repoAllowlist: RepoAllowlist;
  clock: () => number;
  viewerLogin: () => Promise<string>;
  defaultBranch: (repo: RepoScmRef) => Promise<string>;
};
export type PollDeps = Pick<
  ScmGithubDeps,
  'http' | 'clock' | 'viewerLogin' | 'defaultBranch'
>;
