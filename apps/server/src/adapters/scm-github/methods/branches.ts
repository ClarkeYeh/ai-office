import { z } from 'zod';
import { PortError } from '../../../ports/errors.js';
import type { ScmPort } from '../../../ports/scm.js';
import type { GithubError } from '../errors.js';
import { guard } from '../policy/endpoints.js';
import { emptySchema } from '../schemas/common.js';
import { repoParams, type ScmGithubDeps } from './deps.js';
const refSchema = z.looseObject({
  object: z.looseObject({ sha: z.string().regex(/^[a-f0-9]{40}$/i) }),
});
const branchSchema = z.looseObject({ protected: z.boolean() });
const repoSchema = z.looseObject({ default_branch: z.string() });
const compareSchema = z.looseObject({
  ahead_by: z.number().int().nonnegative(),
});
const missing = (error: unknown) =>
  error instanceof PortError && error.code === 'not_found';
export function createBranchMethods(
  deps: ScmGithubDeps,
): Pick<ScmPort, 'ensureBranch' | 'deleteBranch' | 'compareBranch'> {
  const readRef = async (
    repo: Parameters<ScmPort['compareBranch']>[0],
    ref: string,
    conditional = false,
  ) =>
    (
      await deps.http.request(
        'refs.get',
        { ...repoParams(repo), ref },
        { schema: refSchema, conditional },
      )
    ).data.object.sha;
  return {
    async ensureBranch(repo, name, from) {
      deps.repoAllowlist.assert(repo, true);
      if (
        !name.startsWith('ai-office/') ||
        name === (await deps.defaultBranch(repo))
      )
        guard('branch_create_not_allowed');
      try {
        await readRef(repo, name);
        return;
      } catch (error) {
        if (!missing(error)) throw error;
      }
      const sha = /^[a-f0-9]{40}$/i.test(from)
        ? from
        : await readRef(repo, from);
      try {
        await deps.http.request(
          'refs.create',
          { ...repoParams(repo), body: { ref: `refs/heads/${name}`, sha } },
          { schema: emptySchema },
        );
      } catch (error) {
        if (
          !(error instanceof PortError) ||
          !(error as GithubError).alreadyExists
        )
          throw error;
        // Confirm the racing creator's ref, without ever updating it.
        await readRef(repo, name);
      }
    },
    async deleteBranch(repo, name) {
      deps.repoAllowlist.assert(repo, true);
      if (!name.startsWith('ai-office/')) guard('branch_delete_not_allowed');
      // Destructive evidence deliberately bypasses both method and HTTP caches.
      const { data: repository } = await deps.http.request(
        'repos.get',
        repoParams(repo),
        { schema: repoSchema, conditional: false },
      );
      if (name === repository.default_branch)
        guard('branch_delete_not_allowed');
      try {
        const { data } = await deps.http.request(
          'branches.get',
          { ...repoParams(repo), branch: name },
          { schema: branchSchema, conditional: false },
        );
        await deps.http.request(
          'refs.delete',
          { ...repoParams(repo), ref: name },
          {
            schema: emptySchema,
            safety: {
              defaultBranch: repository.default_branch,
              protected: data.protected,
            },
          },
        );
      } catch (error) {
        if (missing(error)) return;
        // A concurrent deletion can return 422 rather than 404. Only a fresh
        // absence check may turn that validation failure into success.
        if (error instanceof PortError && error.code === 'github_validation') {
          try {
            await deps.http.request(
              'branches.get',
              { ...repoParams(repo), branch: name },
              { schema: branchSchema, conditional: false },
            );
          } catch (checkError) {
            if (missing(checkError)) return;
            throw checkError;
          }
        }
        throw error;
      }
    },
    async compareBranch(repo, base, head) {
      try {
        if (base === head)
          return { ahead: 0, headSha: await readRef(repo, head, true) };
        const { data } = await deps.http.request(
          'branches.compare',
          { ...repoParams(repo), base, head },
          { schema: compareSchema, conditional: true },
        );
        // Compare commits can be truncated; resolve the actual head separately.
        const headSha = /^[a-f0-9]{40}$/i.test(head)
          ? head
          : await readRef(repo, head);
        return { ahead: data.ahead_by, headSha };
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
  };
}
