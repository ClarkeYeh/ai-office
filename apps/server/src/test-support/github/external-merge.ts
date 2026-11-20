import { fileURLToPath } from 'node:url';
import type { ScmCursor } from '../../ports/refs.js';
import type { GithubBindingFactory } from './contract-binding.js';
import { contractRepo } from './contract-transport.js';
import { ROOT } from './safety.js';

/**
 * Spike PR #144, merged by the owner by hand (M3 smoke). Read-only: the
 * recording observes history and never merges or moves anything.
 */
export const externalMerge = {
  number: 144,
  head: 'ai-office/1cd773791d59-smoke-test-work-item-1-adds-smok',
  headSha: 'efd7f5cebdf51f631caab3584b45f850d6398086',
  /** `main` before the merge (the merge commit's first parent). */
  baseSha: '1e6c7acab6fcd2ad2c50a045fcd5e28f01b6d00d',
  mergeCommitSha: '64681a692873a262fe0ef5a877a5649b6fef5a03',
  mergedBy: 'ClarkeYeh',
  updatedAt: '2026-11-20T02:19:59Z',
  /** Fixed scenario clock: refs events carry it, so live and replay agree. */
  now: '2026-11-20T03:00:00.000Z',
} as const;

export const externalMergeTape = fileURLToPath(
  new URL(
    '../../../../../fixtures/github/2022-11-28/observations/external-merge-pr-144.json',
    import.meta.url,
  ),
);

/** The cursor of an office that last saw PR #144 open and `main` before it. */
export function cursorBeforeMerge(): ScmCursor {
  const x = externalMerge;
  return JSON.stringify({
    v: 1,
    r: 'clarkeyeh/ai-office-spike',
    d: 'main',
    e: {},
    iw: x.updatedAt,
    cw: x.updatedAt,
    refs: { main: x.baseSha },
    prs: { [x.number]: { s: 'open', h: x.headSha, b: 'main', m: true } },
    ck: {},
    is: { [x.number]: 0 },
    mk: {},
    dp: {},
    k: {},
  }) as ScmCursor;
}

/**
 * GET only, and other spike history never enters the tape: collection rows are
 * scoped to PR #144 (other refs and comments are dropped) before the adapter
 * sees them, so live and replay observe the same responses.
 */
export function externalMergeTransport(transport: typeof fetch): typeof fetch {
  const scoped: Record<string, (row: { number?: number }) => boolean> = {
    [`${ROOT}/issues`]: (row) => row.number === externalMerge.number,
    [`${ROOT}/pulls`]: (row) => row.number === externalMerge.number,
    [`${ROOT}/issues/comments`]: () => false,
    [`${ROOT}/git/matching-refs/heads/ai-office/`]: () => false,
  };
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== 'GET')
      throw new Error('External merge observation is read-only');
    const response = await transport(request);
    const keep = scoped[new URL(request.url).pathname];
    if (!keep || response.status !== 200) return response;
    const rows = (await response.json()) as { number?: number }[];
    const headers = new Headers(response.headers);
    // The scoped list is complete: never follow GitHub's next page.
    headers.delete('link');
    headers.delete('content-length');
    return new Response(JSON.stringify(rows.filter(keep)), {
      status: 200,
      headers,
    });
  };
}

/** getPR reports the hand merge; the next poll observes it from an open cursor. */
export async function externalMergeScenario(
  fetch: typeof globalThis.fetch,
  create: GithubBindingFactory,
) {
  const scm = create({
    fetch,
    clock: { now: () => new Date(externalMerge.now) },
    sleep: async () => {},
    registeredAt: () => externalMerge.now,
  });
  const pr = await scm.getPR({
    repo: contractRepo,
    number: externalMerge.number,
  });
  const { events } = await scm.poll(contractRepo, cursorBeforeMerge());
  return { pr, events };
}

/** What both the live observation and its replay must report. */
export function expectedObservation() {
  const x = externalMerge;
  return {
    pr: {
      state: 'merged',
      mergeCommitSha: x.mergeCommitSha,
      headSha: x.headSha,
      base: 'main',
      mergedBy: x.mergedBy,
    },
    events: [
      {
        type: 'pr.state',
        pr: { repo: contractRepo, number: x.number },
        state: 'merged',
        base: 'main',
        head: x.head,
        headSha: x.headSha,
        mergeable: null,
        mergedBy: x.mergedBy,
        mergeCommitSha: x.mergeCommitSha,
      },
      {
        type: 'branch.head_changed',
        occurredAt: x.now,
        branch: 'main',
        sha: x.mergeCommitSha,
        previousSha: x.baseSha,
      },
    ],
  };
}
