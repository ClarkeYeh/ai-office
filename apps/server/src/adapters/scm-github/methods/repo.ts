import { z } from 'zod';
import { PortError } from '../../../ports/errors.js';
import type { ScmPort } from '../../../ports/scm.js';
import { rateLimitSchema } from '../schemas/common.js';
import { repoParams, type ScmGithubDeps } from './deps.js';
const repoSchema = z.looseObject({
  default_branch: z.string(),
  visibility: z.enum(['public', 'private']),
  archived: z.boolean(),
  allow_merge_commit: z.boolean(),
  permissions: z.looseObject({ push: z.boolean() }),
});
const branchSchema = z.looseObject({ protected: z.boolean() });
const rulesSchema = z.array(
  z.looseObject({
    type: z.string(),
    parameters: z
      .looseObject({
        required_approving_review_count: z.number().optional(),
        allowed_merge_methods: z.array(z.string()).optional(),
      })
      .optional(),
  }),
);
const protectionSchema = z.looseObject({
  required_pull_request_reviews: z
    .looseObject({ required_approving_review_count: z.number() })
    .nullable()
    .optional(),
});
const unavailableDetails = (error: unknown) =>
  error instanceof PortError &&
  ['not_found', 'github_forbidden'].includes(error.code);
export function createRepoMethods(
  deps: ScmGithubDeps,
): Pick<ScmPort, 'health' | 'inspectRepo'> {
  return {
    async health() {
      const viewerLogin = await deps.viewerLogin();
      const { data } = await deps.http.request(
        'rateLimit.get',
        {},
        { schema: rateLimitSchema, conditional: false },
      );
      return {
        available: true,
        viewerLogin,
        rateLimitRemaining: data.resources.core.remaining,
        rateLimitResetAt: new Date(
          data.resources.core.reset * 1000,
        ).toISOString(),
        ...(data.resources.core.remaining < 1000
          ? { warnings: ['rate_limit_low'] }
          : {}),
      };
    },
    async inspectRepo(repo) {
      return deps.repoAllowlist.inspect(repo, async () => {
        const { data } = await deps.http.request(
          'repos.get',
          repoParams(repo),
          { schema: repoSchema, conditional: false },
        );
        const viewerLogin = await deps.viewerLogin();
        const warnings: string[] = [];
        let protectedBranch: boolean | 'unknown' = 'unknown';
        try {
          protectedBranch = (
            await deps.http.request(
              'branches.get',
              { ...repoParams(repo), branch: data.default_branch },
              { schema: branchSchema, conditional: false },
            )
          ).data.protected;
        } catch (error) {
          if (!unavailableDetails(error)) throw error;
        }
        if (protectedBranch !== true)
          warnings.push(
            protectedBranch === false
              ? 'default_unprotected'
              : 'default_protection_unknown',
          );
        let approvals = false;
        try {
          const rules = (
            await deps.http.request(
              'branches.rules',
              { ...repoParams(repo), branch: data.default_branch },
              { schema: rulesSchema, conditional: false },
            )
          ).data;
          approvals = rules.some(
            (rule) =>
              rule.type === 'pull_request' &&
              (rule.parameters?.required_approving_review_count ?? 0) > 0,
          );
        } catch (error) {
          if (!unavailableDetails(error)) throw error;
        }
        if (protectedBranch === true && !approvals) {
          try {
            const classic = (
              await deps.http.request(
                'branches.protection',
                { ...repoParams(repo), branch: data.default_branch },
                { schema: protectionSchema, conditional: false },
              )
            ).data;
            approvals =
              (classic.required_pull_request_reviews
                ?.required_approving_review_count ?? 0) > 0;
          } catch (error) {
            if (!unavailableDetails(error)) throw error;
          }
        }
        if (approvals) warnings.push('default_requires_approvals');
        try {
          const rules = (
            await deps.http.request(
              'branches.rules',
              { ...repoParams(repo), branch: 'ai-office/protection-probe' },
              { schema: rulesSchema, conditional: false },
            )
          ).data;
          if (
            rules.some(
              (rule) =>
                rule.type === 'required_status_checks' ||
                (rule.parameters?.required_approving_review_count ?? 0) > 0 ||
                (rule.parameters?.allowed_merge_methods !== undefined &&
                  !rule.parameters.allowed_merge_methods.includes('merge')),
            )
          )
            warnings.push('ai_office_branches_ruled');
        } catch (error) {
          if (!unavailableDetails(error)) throw error;
        }
        if (!data.allow_merge_commit) warnings.push('merge_commit_disabled');
        if (!data.permissions.push) warnings.push('no_push_permission');
        if (data.archived) warnings.push('archived');
        return {
          defaultBranch: data.default_branch,
          visibility: data.visibility,
          defaultBranchProtected: protectedBranch,
          viewerLogin,
          allowMergeCommit: data.allow_merge_commit,
          archived: data.archived,
          canPush: data.permissions.push,
          warnings,
        };
      });
    },
  };
}
