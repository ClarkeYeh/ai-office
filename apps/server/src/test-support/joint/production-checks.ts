/**
 * M5-T12 production checks (M5_PLAN §5 T12 steps 4 and 6, the M3-T17 smoke's
 * identity checks generalized): read-only GitHub (GA) facts about the run,
 * reduced to counts, logins and booleans. Never bodies, never emails (the
 * owner's noreply address is compared, not reported).
 */
import type { Json } from '../orca/t17/checks.js';

/** The read surface these checks need (the T7 harness `GithubApi`). */
export interface GithubReads {
  request(method: 'GET', path: string): Promise<{ status: number; data: Json }>;
  list(path: string): Promise<Json[]>;
}

const of = (log: Json[], type: string) => log.filter((e) => e.type === type);

/** PR numbers the backend opened, split into worker PRs and the final PR (base = default). */
export function runPrs(log: Json[], defaultBranch = 'main') {
  const issued = new Map(
    of(log, 'command.issued').map((e) => [e.payload.commandId, e.payload]),
  );
  const opened = of(log, 'command.succeeded')
    .filter((e) => e.payload.kind === 'scm.openPR')
    .map((e) => ({
      pr: Number(e.payload.result?.pr),
      base: String(issued.get(e.payload.commandId)?.args?.base ?? ''),
    }));
  return {
    workers: opened.filter((p) => p.base !== defaultBranch).map((p) => p.pr),
    final: opened.find((p) => p.base === defaultBranch)?.pr,
    issues: of(log, 'command.succeeded')
      .filter((e) => e.payload.kind === 'scm.createIssue')
      .map((e) => Number(e.payload.result?.issue)),
  };
}

/** Branches of this run: every dispatch branch plus the integration branch. */
export function runBranches(log: Json[]): Set<string> {
  const branches = new Set(
    of(log, 'workitem.dispatched').map((e) => String(e.payload.branch)),
  );
  const integration = of(log, 'workflow.started')[0]?.payload
    .integrationBranch as string | undefined;
  if (integration) branches.add(integration);
  return branches;
}

/**
 * §5 T12 step 6, before the owner merges: every Issue and PR is by the owner,
 * agent commits use the owner's noreply identity, every push to this run's
 * branches is by the owner, and no worker PR touches `.github/`.
 */
export async function identityChecks(
  api: GithubReads,
  log: Json[],
  options: { owner: string; noreplyEmail: string },
) {
  const { workers, final, issues } = runPrs(log);
  const authors = new Set<string>();
  for (const n of [...workers, ...(final ? [final] : []), ...issues]) {
    const { data } = await api.request('GET', `/issues/${n}`);
    authors.add(String((data.user as Json | undefined)?.login));
  }
  let commits = 0,
    authorNoreply = 0,
    committerNoreply = 0,
    githubPaths = 0;
  for (const n of workers) {
    for (const c of await api.list(`/pulls/${n}/commits`)) {
      commits++;
      if (c.commit?.author?.email === options.noreplyEmail) authorNoreply++;
      if (c.commit?.committer?.email === options.noreplyEmail)
        committerNoreply++;
    }
    for (const f of await api.list(`/pulls/${n}/files`))
      if (String(f.filename ?? '').startsWith('.github/')) githubPaths++;
  }
  // The activity API pages by cursor; the latest 100 entries cover one run.
  const branches = runBranches(log);
  const activity = (await api.request('GET', '/activity?per_page=100'))
    .data as unknown as Json[];
  const pushes = (Array.isArray(activity) ? activity : []).filter((a) =>
    branches.has(String(a.ref ?? '').replace(/^refs\/heads\//, '')),
  );
  const actors = [
    ...new Set(pushes.map((p) => String((p.actor as Json)?.login))),
  ];
  return {
    objects: workers.length + (final ? 1 : 0) + issues.length,
    objectAuthors: [...authors],
    agentCommits: { commits, authorNoreply, committerNoreply },
    pushes: { count: pushes.length, actors },
    githubPathsTouched: githubPaths,
    ok:
      authors.size === 1 &&
      authors.has(options.owner) &&
      commits > 0 &&
      authorNoreply === commits &&
      committerNoreply === commits &&
      pushes.length > 0 &&
      actors.every((a) => a === options.owner) &&
      githubPaths === 0,
  };
}

/** Policy hits, reported (never asserted): events carry no command text. */
export function policyHits(log: Json[]) {
  const purpose = new Map(
    of(log, 'seat.spawned').map((e) => [
      e.payload.attemptId,
      `${e.payload.purpose}/${e.payload.agent}`,
    ]),
  );
  return of(log, 'seat.policy_violation').flatMap((e) =>
    ((e.payload.hits ?? []) as Json[]).map((hit) => ({
      rule: String(hit.rule),
      severity: String(hit.severity),
      by: purpose.get(e.payload.attemptId) ?? '?',
    })),
  );
}

/**
 * §5 T12 step 4, after the owner's hand merge: `pr.status merged` by the
 * owner, `gate.closed{merged}`, `workflow.completed`, no anomaly after the
 * merge (the default branch moving is expected), and the automatic cleanup
 * (T3) finished with no `cleanup-failed`.
 */
export function afterMerge(log: Json[], options: { owner: string }) {
  const { final } = runPrs(log);
  const merged = of(log, 'pr.status').find(
    (e) => Number(e.payload.pr) === final && e.payload.state === 'merged',
  );
  const mergedSeq = merged ? Number(merged.seq) : Number.POSITIVE_INFINITY;
  const finalGate = of(log, 'gate.opened').find(
    (e) => e.payload.stageKind === 'final-pr',
  )?.payload.gateId;
  const anomaliesAfter = of(log, 'anomaly.detected').filter(
    (e) => Number(e.seq) > mergedSeq,
  );
  const cleanupFailed = of(log, 'anomaly.detected').filter(
    (e) => e.payload.kind === 'cleanup-failed',
  ).length;
  const result = {
    finalPr: final ?? null,
    merged: merged !== undefined,
    mergedByOwner: merged?.payload.mergedBy === options.owner,
    gateClosedMerged: of(log, 'gate.closed').some(
      (e) => e.payload.gateId === finalGate && e.payload.reason === 'merged',
    ),
    workflowCompleted: of(log, 'workflow.completed').length === 1,
    anomaliesAfterMerge: anomaliesAfter.map((e) => String(e.payload.kind)),
    cleanupFailed,
  };
  return {
    ...result,
    ok:
      result.merged &&
      result.mergedByOwner &&
      result.gateClosedMerged &&
      result.workflowCompleted &&
      anomaliesAfter.length === 0 &&
      cleanupFailed === 0,
  };
}

/** Implement's merges only: drop first-parent commits after the last backend merge. */
export function implementFirstParents(chain: string[], log: Json[]): string[] {
  const merges = new Set(
    of(log, 'workitem.merged').map((e) => String(e.payload.mergeCommitSha)),
  );
  let end = chain.length;
  while (end > 0 && !merges.has(chain[end - 1]!)) end--;
  return chain.slice(0, end);
}

/**
 * The conclusion Issue (§2.2.4 first row): the Issue the conclusion gate's
 * own stage created (commandId `<workflow>/<stage>/<n>/issue`), never simply
 * the first Issue of the run.
 */
export function conclusionIssue(log: Json[]): number | undefined {
  const gate = of(log, 'gate.opened').find(
    (e) => e.payload.content?.type === 'conclusion',
  );
  const stageId = (gate?.payload.stageId ?? gate?.stageId) as
    string | undefined;
  if (!stageId) return undefined;
  const ofStage = new RegExp(
    `/${stageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\d+/issue$`,
  );
  const created = of(log, 'command.succeeded').find(
    (e) =>
      e.payload.kind === 'scm.createIssue' &&
      ofStage.test(String(e.payload.commandId)),
  );
  const issue = Number(created?.payload.result?.issue);
  return Number.isSafeInteger(issue) && issue > 0 ? issue : undefined;
}
