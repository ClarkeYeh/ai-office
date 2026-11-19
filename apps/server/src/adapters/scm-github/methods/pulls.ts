import { z } from 'zod';
import { PortError } from '../../../ports/errors.js';
import type { PrRef, RepoScmRef } from '../../../ports/refs.js';
import type { Correlation } from '../../../ports/runtime.js';
import type { PrDraft, PrPatch, ScmPort } from '../../../ports/scm.js';
import type { GithubError } from '../errors.js';
import type { GithubHttp } from '../http/types.js';
import { guard } from '../policy/endpoints.js';
import { mergePR } from './merge.js';
import {
  anyMarker,
  isMerged,
  marker,
  prParams,
  pullSchema,
} from './pr-schemas.js';
import { listReviewComments } from './reviews.js';

/**
 * The part of T4's `ScmGithubDeps` (methods/deps.ts) these methods use, so
 * the full deps object can be passed once it lands.
 */
export type PrMethodsDeps = { http: GithubHttp };
export type PrMethodsOptions = {
  /** Spaces the post-merge read-back; tests inject a fake. */
  sleep?: (ms: number) => Promise<void>;
};
type PrMethods = Pick<
  ScmPort,
  'openPR' | 'getPR' | 'updatePR' | 'mergePR' | 'listReviewComments'
> & { closePR(ref: PrRef): Promise<void> };

const createdSchema = z.looseObject({
  number: z.number().int().positive(),
  html_url: z.string(),
});
const marked = (body: string, commandId: string) =>
  body.includes(marker(commandId)) ? body : `${body}\n\n${marker(commandId)}`;

export function createPrMethods(
  deps: PrMethodsDeps,
  options: PrMethodsOptions = {},
): PrMethods {
  const { http } = deps;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const readPull = async (ref: PrRef, conditional: boolean) =>
    (
      await http.request('pulls.get', prParams(ref), {
        schema: pullSchema,
        conditional,
      })
    ).data;

  /**
   * A timed-out create returns retryable `github_unavailable` (no pending
   * window): the retry gets GitHub's 422 for the same head/base (G10) and
   * adopts the open PR carrying this command's marker.
   */
  async function openPR(repo: RepoScmRef, draft: PrDraft, c: Correlation) {
    if (!draft.head.startsWith('ai-office/')) guard('pr_head_not_allowed');
    const params = { owner: repo.owner, repo: repo.name };
    const body = marked(draft.body, c.commandId);
    try {
      const { data } = await http.request(
        'pulls.create',
        {
          ...params,
          body: {
            title: draft.title,
            body,
            head: draft.head,
            base: draft.base,
            ...(draft.draft !== undefined ? { draft: draft.draft } : {}),
          },
        },
        { schema: createdSchema },
      );
      return { repo, number: data.number, url: data.html_url };
    } catch (error) {
      if (
        !(error instanceof PortError) ||
        !(error as GithubError).alreadyExists
      )
        throw error;
    }
    const open = await http.paginate(
      'pulls.list',
      {
        ...params,
        query: {
          head: `${repo.owner}:${draft.head}`,
          base: draft.base,
          state: 'open',
        },
      },
      { schema: z.array(pullSchema) },
    );
    const mine = open.find((pull) => pull.body?.includes(marker(c.commandId)));
    // Someone else's PR on our branch is not ours to adopt.
    if (!mine) guard('pr_exists_without_marker');
    return { repo, number: mine.number, url: mine.html_url };
  }

  async function getPR(ref: PrRef) {
    const pull = await readPull(ref, true);
    const merged = isMerged(pull);
    return {
      state: merged ? ('merged' as const) : pull.state,
      // GitHub fills merge_commit_sha with a test merge while the PR is open.
      ...(merged && pull.merge_commit_sha
        ? { mergeCommitSha: pull.merge_commit_sha }
        : {}),
      headSha: pull.head.sha,
      base: pull.base.ref,
      ...(pull.merged_by ? { mergedBy: pull.merged_by.login } : {}),
    };
  }

  /** Only PRs carrying an AI Office marker, judged on a fresh read. */
  async function closePR(ref: PrRef) {
    const pull = await readPull(ref, false);
    if (isMerged(pull))
      throw new PortError('conflict', 'pr_merged', 'PR already merged');
    const body = pull.body ?? '';
    if (!anyMarker.test(body)) guard('pr_close_not_allowed');
    if (pull.state === 'closed') return;
    await http.request(
      'pulls.update',
      { ...prParams(ref), body: { state: 'closed' } },
      { schema: z.unknown(), safety: { body } },
    );
  }

  /** Title, body and state only: the base is never changed (S20). */
  async function updatePR(ref: PrRef, patch: PrPatch) {
    // Close first, so the marker check sees the PR before any body change.
    if (patch.state === 'closed') await closePR(ref);
    const fields = {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.state === 'open' ? { state: 'open' as const } : {}),
    };
    if (Object.keys(fields).length)
      await http.request(
        'pulls.update',
        { ...prParams(ref), body: fields },
        { schema: z.unknown() },
      );
  }

  return {
    openPR,
    getPR,
    updatePR,
    closePR,
    mergePR: (ref, opts) => mergePR(http, sleep, ref, opts),
    listReviewComments: (ref) => listReviewComments(http, ref),
  };
}
