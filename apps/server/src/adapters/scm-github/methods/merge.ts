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
const mergeSchema = z.looseObject({ sha: z.string(), merged: z.literal(true) });
/**
 * G11: GitHub may mark a merged PR as merged up to ~3 s after the merge
 * call. The read-back polls this many times, this far apart.
 */
export const MERGE_VERIFY_ATTEMPTS = 5;
export const MERGE_VERIFY_INTERVAL_MS = 1_000;
export type MergeOptions = {
  method: 'merge';
  expectedHeadSha: string;
  expectedBaseSha?: string;
};
const conflict = (code: string, message: string) =>
  new PortError('conflict', code, message);

/**
 * SPEC rev2.15 §11.2: judged by the PR's actual base (fresh reads, never the
 * HTTP cache). Retries after a timeout are safe: an already merged PR returns
 * its merge commit (G4), so the merge is never repeated.
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
  const merged = (
    await http.request(
      'pulls.merge',
      {
        ...prParams(ref),
        body: { merge_method: 'merge', sha: opts.expectedHeadSha },
      },
      {
        schema: mergeSchema,
        safety: { defaultBranch, actualBase: base },
      },
    )
  ).data;
  await verifyBase(readPull, sleep, base);
  return { mergeCommitSha: merged.sha };
}

/**
 * There is no atomic base lock: a base retargeted between the read and the
 * merge means GitHub merged elsewhere. Compare `base.ref`, not `base.sha`,
 * which stays the PR-open snapshot (G4).
 */
async function verifyBase(
  readPull: () => Promise<Pull>,
  sleep: (ms: number) => Promise<void>,
  base: string,
) {
  let pull: Pull | undefined;
  for (let attempt = 0; attempt < MERGE_VERIFY_ATTEMPTS; attempt++) {
    await sleep(MERGE_VERIFY_INTERVAL_MS);
    try {
      pull = await readPull();
    } catch {
      // The merge already happened: one failed read must not report failure.
      continue;
    }
    if (pull.base.ref !== base) break;
    if (isMerged(pull)) return;
  }
  // Retryable: the retry finds the merged PR and re-checks its base (G4).
  if (!pull) throw unavailable(false);
  if (pull.base.ref !== base) guard('merge_base_changed');
}
