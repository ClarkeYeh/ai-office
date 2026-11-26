/**
 * M5-T11b: the GitHub-only facts of §2.3.4 and the T10 checker, judged by
 * equivalent reads of the scm-gitremote world (M5_PLAN §2.5). Git reads go
 * to the harness-owned spike clone after a fetch (read-only on the remote);
 * the marker scan asks the stand-in's in-memory model. Values are SHAs,
 * counts and booleans only.
 */
import type { Json } from '../../orca/t17/office.js';
import {
  CONFLICT_KEYS,
  lastLine,
  PENDING_LINE,
  reviewedLine,
} from '../scenario/index.js';

/** One git invocation in the spike clone; rejects on a non-zero exit. */
export type Git = (args: string[]) => Promise<string>;

const of = (log: Json[], type: string) => log.filter((e) => e.type === type);

export const integrationBranch = (log: Json[]): string | undefined =>
  of(log, 'workflow.started')[0]?.payload.integrationBranch as
    string | undefined;

/** Implement's first-parent merges on the integration branch, oldest first. */
export async function firstParents(
  git: Git,
  log: Json[],
): Promise<string[] | undefined> {
  const branch = integrationBranch(log);
  const base = of(log, 'workitem.dispatched').find(
    (e) => e.payload.itemKey === 'core',
  )?.payload.baseSha as string | undefined;
  if (!branch || !base) return undefined;
  const out = await git([
    'rev-list',
    '--first-parent',
    '--reverse',
    `${base}..origin/${branch}`,
  ]).catch(() => undefined);
  if (out === undefined) return undefined;
  // Only implement's merges: wrap-up commits after the last merge are cut.
  const merges = new Set(
    of(log, 'workitem.merged').map((e) => String(e.payload.mergeCommitSha)),
  );
  const shas = out.split('\n').filter(Boolean);
  let end = shas.length;
  while (end > 0 && !merges.has(shas[end - 1]!)) end--;
  return shas.slice(0, end);
}

const isAncestor = (git: Git, commit: string, head: string) =>
  git(['merge-base', '--is-ancestor', commit, head]).then(
    () => true,
    () => false,
  );

/** Each dependency merge against each downstream dispatch base (T10 `ancestry`). */
export async function ancestry(git: Git, log: Json[]) {
  const merges = of(log, 'workitem.merged').map((e) =>
    String(e.payload.mergeCommitSha),
  );
  const out: { baseSha: string; commit: string; isAncestor: boolean }[] = [];
  for (const d of of(log, 'workitem.dispatched'))
    if (typeof d.payload.baseSha === 'string')
      for (const commit of merges)
        out.push({
          baseSha: d.payload.baseSha,
          commit,
          isAncestor: await isAncestor(git, commit, d.payload.baseSha),
        });
  return out;
}

/**
 * §2.2.2 path A: the PR's final head has a two-parent merge commit on the
 * worker branch since its dispatch base (the integrator merged the moved
 * integration branch in). One entry per PR that reported `mergeable:false`.
 */
export async function conflictFacts(git: Git, log: Json[]) {
  const prs = new Set(
    of(log, 'pr.status')
      .filter((e) => e.payload.mergeable === false)
      .map((e) => Number(e.payload.pr)),
  );
  const out: { pr: number; twoParentMerge: boolean }[] = [];
  for (const pr of prs) {
    const queued = of(log, 'workitem.merge_queued').filter(
      (e) => Number(e.payload.pr) === pr,
    );
    const head = queued.at(-1)?.payload.headSha as string | undefined;
    const item = queued.at(-1)?.payload.itemKey as string | undefined;
    const base = of(log, 'workitem.dispatched').find(
      (e) => e.payload.itemKey === item,
    )?.payload.baseSha as string | undefined;
    if (!head || !base) continue;
    const merges = await git([
      'rev-list',
      '--merges',
      `${base}..${head}`,
    ]).catch(() => '');
    out.push({ pr, twoParentMerge: merges.trim().length > 0 });
  }
  return out;
}

/**
 * §2.2.3 `#pending` rework, per reworked PR: the first reviewed head's README
 * ends with `#pending`, the final head's with this PR's number, and the line
 * is the worker's: the backend's merge commit has the worker's last head as
 * its second parent (no reviewer push on top).
 */
export async function reworkFacts(git: Git, log: Json[], tag: string) {
  const out: {
    pr: number;
    firstHeadHasPending: boolean;
    finalHeadHasPrNumber: boolean;
    lineByWorker: boolean;
  }[] = [];
  const readme = `m5/${tag}/README.md`;
  const prs = new Set(
    of(log, 'workitem.rework_requested').map((e) => Number(e.payload.pr)),
  );
  for (const pr of prs) {
    const queued = of(log, 'workitem.merge_queued').filter(
      (e) => Number(e.payload.pr) === pr,
    );
    const first = queued[0]?.payload.headSha as string | undefined;
    const final = queued.at(-1)?.payload.headSha as string | undefined;
    const merged = of(log, 'workitem.merged').find(
      (e) => Number(e.payload.pr) === pr,
    )?.payload.mergeCommitSha as string | undefined;
    if (!first || !final || !merged) continue;
    const show = (sha: string) =>
      git(['show', `${sha}:${readme}`]).catch(() => '');
    const secondParent = await git(['rev-parse', `${merged}^2`]).catch(
      () => '',
    );
    out.push({
      pr,
      firstHeadHasPending: lastLine(await show(first)) === PENDING_LINE,
      finalHeadHasPrNumber: lastLine(await show(final)) === reviewedLine(pr),
      lineByWorker: secondParent.trim() === final,
    });
  }
  return out;
}

/** Marker scan of the stand-in: objects per commandId of our create commands. */
export async function markerCounts(
  findByMarker: (commandId: string) => Promise<{ duplicates?: number } | null>,
  log: Json[],
): Promise<Record<string, number>> {
  const ids = of(log, 'command.issued')
    .filter((e) =>
      ['scm.createIssue', 'scm.openPR'].includes(String(e.payload.kind)),
    )
    .map((e) => String(e.payload.commandId));
  const out: Record<string, number> = {};
  for (const id of ids) {
    const match = await findByMarker(id);
    // The keeper plus any further objects carrying the same marker.
    out[id] = match ? 1 + (match.duplicates ?? 0) : 0;
  }
  return out;
}

/**
 * §2.2.2 in the scm-gitremote world, which never reports `mergeable` (always
 * null; T11b live finding): of mul and sub, the PR merged second either got a
 * two-parent merge of the first merge into its worker branch (path A: the
 * backend merge's second parent has the first merge as a parent) or a
 * rework-request (path B). `null` when neither shows.
 */
export async function conflictEquivalent(
  git: Git,
  log: Json[],
): Promise<{
  pr: number;
  item: string;
  path: 'A' | 'B' | null;
  twoParentMerge: boolean;
} | null> {
  const merged = of(log, 'workitem.merged').filter((e) =>
    (CONFLICT_KEYS as readonly string[]).includes(e.payload.itemKey),
  );
  if (merged.length < 2) return null;
  const [first, second] = merged as [Json, Json];
  const pr = Number(second.payload.pr);
  const finalHead = (
    await git(['rev-parse', `${second.payload.mergeCommitSha}^2`]).catch(
      () => '',
    )
  ).trim();
  const parents = finalHead
    ? (
        await git(['rev-list', '--parents', '-n', '1', finalHead]).catch(
          () => '',
        )
      )
        .trim()
        .split(' ')
        .slice(1)
    : [];
  const twoParentMerge =
    parents.length === 2 &&
    parents.includes(String(first.payload.mergeCommitSha));
  const reworked = of(log, 'workitem.rework_requested').some(
    (e) => Number(e.payload.pr) === pr,
  );
  return {
    pr,
    item: String(second.payload.itemKey),
    path: twoParentMerge ? 'A' : reworked ? 'B' : null,
    twoParentMerge,
  };
}
