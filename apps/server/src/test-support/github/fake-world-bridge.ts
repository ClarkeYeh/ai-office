import type { ScmPort } from '../../ports/scm.js';
import { assertBranch, assertRepo, assertRunId } from './safety.js';
import type { GitPusher } from './pusher.js';
import { githubBranches } from './branch-namespace.js';

/** Adapter-free wiring; main.ts owns construction of the fake runtime and SCM. */
export function createGithubWorldBridge<
  Scm extends Pick<ScmPort, 'compareBranch'>,
>(options: {
  scm: Scm;
  repo: { owner: string; name: string };
  runId: string;
  shortId?: string;
  pusher: Pick<GitPusher, 'push'>;
}) {
  assertRepo(`${options.repo.owner}/${options.repo.name}`);
  assertRunId(options.runId);
  const repo = { ...options.repo };
  const branches = githubBranches(options.runId, options.shortId);
  let tail: Promise<void> = Promise.resolve();
  const remoteHead = async (ref: string): Promise<string | null> =>
    (await options.scm.compareBranch(repo, ref, ref))?.headSha ?? null;
  return {
    scm: options.scm,
    refreshHeadAfterPush: true as const,
    remoteHead,
    onPush(request: { branch: string; base?: string }): Promise<void> {
      // Validate before queuing; never forward a scenario's illustrative SHA.
      const branch = branches.remote(request.branch);
      assertBranch(branch, options.runId);
      if (!request.base || !/^[a-f0-9]{40}$/.test(request.base))
        throw new Error('GitHub fake push requires a pinned base');
      const push = { branch, base: request.base };
      // One pusher owns one checkout. Concurrent fake workers must not race it.
      const result = tail.then(async () => {
        await options.pusher.push(push);
      });
      tail = result.catch(() => undefined);
      return result;
    },
  };
}
