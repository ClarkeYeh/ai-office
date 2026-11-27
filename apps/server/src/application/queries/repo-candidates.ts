import { parseGithubOrigin, type RepoScmRef } from '../../ports/refs.js';
import type { LocalRepo, RuntimePort } from '../../ports/runtime.js';
import type { ScmPort, ViewerRepo } from '../../ports/scm.js';
import type { Logger } from '../../ports/services.js';
import { toErrorInfo } from '../commands/errors.js';
import { withTimeout } from './gate-bodies.js';

type Source = 'ok' | 'unavailable';
/** `GET /api/v1/repo-candidates` (contracts `RepoCandidatesResponse`). */
export type RepoCandidates = {
  local: {
    path: string;
    displayName: string;
    github: RepoScmRef | null;
    registered: boolean;
    problem?: string;
  }[];
  remote: {
    owner: string;
    name: string;
    visibility: 'public' | 'private';
    archived: boolean;
    pushedAt: string | null;
    local: { path: string } | null;
    registered: boolean;
  }[];
  sources: { orca: Source; github: Source };
};
type Registered = { localPath: string; github: RepoScmRef };
export type RepoCandidateDeps = {
  runtime: Pick<RuntimePort, 'listLocalRepos'>;
  scm: Pick<ScmPort, 'listViewerRepos'>;
  /** Registered repos (any status), read when the request arrives. */
  registered: () => readonly Registered[];
  logger?: Pick<Logger, 'warn'>;
  /** A source slower than this is reported unavailable. */
  timeoutMs?: number;
};

const repoKey = (repo: RepoScmRef) =>
  `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
const pathKey = (path: string) => path.replace(/\/+$/, '') || '/';

/**
 * Pure matching for the repo picker. Only git main worktrees are local
 * candidates; remote repos match them by owner/name ignoring case, and a
 * failed source (`null`) leaves its list empty and is marked unavailable.
 */
export function matchRepoCandidates(input: {
  local: readonly LocalRepo[] | null;
  remote: readonly ViewerRepo[] | null;
  registered: readonly Registered[];
}): RepoCandidates {
  const registeredPaths = new Set(
    input.registered.map((r) => pathKey(r.localPath)),
  );
  const registeredRepos = new Set(
    input.registered.map((r) => repoKey(r.github)),
  );
  const local: RepoCandidates['local'] = (input.local ?? [])
    .filter((repo) => repo.isGitMainWorktree)
    .map((repo) => {
      const github = parseGithubOrigin(repo.originUrl);
      return {
        path: repo.path,
        displayName: repo.displayName,
        github,
        registered: registeredPaths.has(pathKey(repo.path)),
        ...(github ? {} : { problem: 'invalid_github_origin' }),
      };
    });
  const byRepo = new Map<string, string>();
  for (const repo of local)
    if (repo.github && !byRepo.has(repoKey(repo.github)))
      byRepo.set(repoKey(repo.github), repo.path);
  const remote = (input.remote ?? []).map((repo) => {
    const path = byRepo.get(repoKey(repo));
    return {
      owner: repo.owner,
      name: repo.name,
      visibility: repo.visibility,
      archived: repo.archived,
      pushedAt: repo.pushedAt,
      local: path === undefined ? null : { path },
      registered: registeredRepos.has(repoKey(repo)),
    };
  });
  return {
    local,
    remote,
    sources: {
      orca: input.local ? 'ok' : 'unavailable',
      github: input.remote ? 'ok' : 'unavailable',
    },
  };
}

/** v0.1.1 repo picker: a request-time read model; nothing is persisted. */
export class RepoCandidateQueries {
  constructor(private readonly deps: RepoCandidateDeps) {}
  async listRepoCandidates(): Promise<RepoCandidates> {
    const timeoutMs = this.deps.timeoutMs ?? 10_000;
    const settle = async <T>(
      source: 'orca' | 'github',
      read: () => Promise<T>,
    ): Promise<T | null> => {
      try {
        return await withTimeout(read(), timeoutMs);
      } catch (error) {
        this.deps.logger?.warn(
          { source, error: toErrorInfo(error) },
          'repo candidates source unavailable',
        );
        return null;
      }
    };
    const [local, remote] = await Promise.all([
      settle('orca', () => this.deps.runtime.listLocalRepos()),
      settle('github', () => this.deps.scm.listViewerRepos()),
    ]);
    return matchRepoCandidates({
      local,
      remote,
      registered: this.deps.registered(),
    });
  }
}
