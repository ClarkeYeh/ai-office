import { z } from 'zod';
import { PortError } from '../../../ports/errors.js';
import type { PrRef } from '../../../ports/refs.js';
import { contractMismatch, unavailable } from '../errors.js';
import type { GithubHttp } from '../http/types.js';
import { guard } from '../policy/endpoints.js';
import { isMerged, prParams, pullSchema, type Pull } from './pr-schemas.js';

const repoSchema = z.looseObject({ default_branch: z.string() });
const branchSchema = z.looseObject({
  commit: z.looseObject({ sha: z.string() }),
  protected: z.boolean(),
});
/** 201 returns the merge commit; 204 (head already in base) has no body. */
const mergesSchema = z.union([
  z.looseObject({ sha: z.string() }),
  z.undefined(),
]);
/**
 * G11: GitHub marks the PR merged ~3 s after `POST /merges`. The read-back
 * waits these intervals (10 s in total) before giving up.
 */
export const MERGE_VERIFY_DELAYS_MS = [500, 1_000, 1_500, 2_000, 2_500, 2_500];
export type MergeOptions = {
  method: 'merge';
  expectedHeadSha: string;
  expectedBaseSha?: string;
};
const conflict = (code: string, message: string) =>
  new PortError('conflict', code, message);

/**
 * SPEC rev2.15 §11.2 with S20: the PR is judged on fresh reads, then merged
 * with `POST /merges` naming the base we checked, so a PR base retargeted
 * meanwhile cannot redirect the merge; the read-back flags it instead.
 * Retries after a timeout are safe: an already merged PR returns its merge
 * commit, and a repeated `/merges` answers 204 (G11).
 */
export async function mergePR(
  http: GithubHttp,
  sleep: (ms: number) => Promise<void>,
  ref: PrRef,
  opts: MergeOptions,
): Promise<{ mergeCommitSha: string }> {
  if (opts.method !== 'merge') guard('merge_method_not_allowed');
  const owner = ref.repo.owner,
    repo = ref.repo.name;
  const readPull = async () =>
    (
      await http.request('pulls.get', prParams(ref), {
        schema: pullSchema,
        conditional: false,
      })
    ).data;
  const pull = await readPull();
  const { default_branch: defaultBranch } = (
    await http.request(
      'repos.get',
      { owner, repo },
      { schema: repoSchema, conditional: false },
    )
  ).data;
  const base = pull.base.ref;
  if (base === defaultBranch) guard('default_branch_merge');
  if (!base.startsWith('ai-office/')) guard('base_not_ai_office');
  if (isMerged(pull)) {
    if (pull.head.sha !== opts.expectedHeadSha)
      throw conflict('head_mismatch', 'PR was merged at another head');
    if (!pull.merge_commit_sha) throw contractMismatch();
    return { mergeCommitSha: pull.merge_commit_sha };
  }
  if (pull.state !== 'open') throw conflict('not_mergeable', 'PR is closed');
  // Non-retryable: the caller re-reads the head and resubmits (SPEC §7.4).
  if (pull.head.sha !== opts.expectedHeadSha)
    throw conflict('head_mismatch', 'PR head changed');
  const branch = (
    await http.request(
      'branches.get',
      { owner, repo, branch: base },
      { schema: branchSchema, conditional: false },
    )
  ).data;
  // `protected` reflects rulesets too (G5); a 0-review ruleset does not stop
  // an API merge, so this guard is the barrier (SPEC §17.3).
  if (branch.protected) guard('protected_branch_merge');
  if (
    opts.expectedBaseSha !== undefined &&
    branch.commit.sha !== opts.expectedBaseSha
  )
    throw conflict('base_moved', 'PR base moved');
  let merged: z.infer<typeof mergesSchema>;
  try {
    merged = (
      await http.request(
        'merges.create',
        {
          owner,
          repo,
          body: {
            base,
            head: opts.expectedHeadSha,
            commit_message: `${pull.title} (#${ref.number})\n\n<!-- ai-office:pr=${ref.number} -->`,
          },
        },
        {
          schema: mergesSchema,
          safety: { defaultBranch, actualBase: base, protected: false },
        },
      )
    ).data;
  } catch (error) {
    // `/merges` answers 409 for a merge conflict, not for a stale head.
    if (error instanceof PortError && error.code === 'head_mismatch')
      throw conflict('not_mergeable', 'Merge conflict');
    throw error;
  }
  return { mergeCommitSha: await verifyMerged(readPull, sleep, base, merged) };
}

/**
 * The PR must show up merged on the base we named. `base.ref` is compared,
 * not `base.sha`, which stays the PR-open snapshot (G4). Never falls back
 * to `PUT pulls/{n}/merge`, which would follow a retargeted base.
 */
async function verifyMerged(
  readPull: () => Promise<Pull>,
  sleep: (ms: number) => Promise<void>,
  base: string,
  merged: z.infer<typeof mergesSchema>,
): Promise<string> {
  let read = false;
  for (const delay of MERGE_VERIFY_DELAYS_MS) {
    await sleep(delay);
    let pull: Pull;
    try {
      pull = await readPull();
    } catch {
      // The merge already happened: one failed read must not report failure.
      continue;
    }
    read = true;
    if (pull.base.ref !== base) guard('merge_base_changed');
    if (isMerged(pull)) {
      const sha = pull.merge_commit_sha ?? merged?.sha;
      if (!sha) throw contractMismatch();
      return sha;
    }
  }
  // Retryable: the retry finds the merged PR, or gets 204 and reads again.
  if (!read) throw unavailable(false);
  guard('pr_not_marked_merged');
}
