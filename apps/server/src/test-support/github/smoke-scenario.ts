/**
 * M3-T17 real-agent smoke (M3_PLAN §6): production `ai-office start` (T16's
 * isolated home layout, the owner-approved orca-home, built-in template,
 * enforcement off) drives two work items with real Claude and Codex agents on
 * the spike up to the final-PR gate. The owner then merges the final PR by
 * hand on GitHub (Q1); this module never merges and never approves the
 * final-PR gate. It observes the merge, stops the backend, and leaves cleanup
 * to both janitors: production SCM objects are imported into the T7 ledger
 * from the workflow's own issued/succeeded events, Orca effects through the
 * claimed namespace and the adopted run.
 *
 * Owner hand-offs go through two private local files (no bodies or secrets in
 * reports): `AIO_T17_STATUS` is written whenever the run waits for the owner
 * (final PR open, an exception gate, an escalated question), and the owner's
 * answer to an exception or question is read from `<status>.decision.json`.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { OrcaHarness } from '../orca/harness.js';
import { runProductionCli } from '../orca/production-cli.js';
import {
  attempts,
  count,
  duplicatedFacts,
  errorAttempts,
  rateLimitReport,
  repeatedSends,
  spawnStallFalsePositives,
  statesByAgent,
  submittingAgents,
  usageByRole,
} from '../orca/t17/checks.js';
import {
  adoptRun,
  compactTrace,
  decide,
  drive,
  events,
  Expectations,
  registerRepo,
  session,
  startWorkflow,
  type Api,
  type DriveRecord,
  type Json,
} from '../orca/t17/office.js';
import { GithubApi } from './api.js';
import { withHarness } from './harness.js';
import { registerEvents } from './ledger.js';
import {
  OWNER,
  approvedOrcaHome,
  driveSmokeToFinalGate,
  healthFailures,
  ledgerShims,
  noreplyApplied,
  productionConfig,
  registrationFailures,
  resolveBinary,
  smokeRequirement,
} from './production-smoke.js';

export const assertClean = true;

/** API events in the shape the T7 ledger imports (seq-ordered, unchanged). */
const ledgerEvents = (log: Json[]): Parameters<typeof registerEvents>[1] =>
  log.map((e) => ({
    type: String(e.type),
    workflowId: (e.workflowId ?? null) as string | null,
    payload: e.payload as unknown,
  }));

const absolute = (name: string) => {
  const value = process.env[name];
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be absolute`);
  return value;
};

/** Owner's answer for one waiting item, written by the owner beside the status. */
async function ownerDecision(
  statusPath: string,
  status: Json,
  waitMs: number,
): Promise<Json> {
  const decisionPath = `${statusPath}.decision.json`;
  await writeFile(
    statusPath,
    JSON.stringify({ ...status, at: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  );
  console.info(`T17 waiting for the owner: ${statusPath}`);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const text = await readFile(decisionPath, 'utf8').catch(() => undefined);
    if (text) {
      const decision = JSON.parse(text) as Json;
      if (decision.for === status.for) {
        await rm(decisionPath, { force: true });
        return decision;
      }
    }
    await delay(5_000);
  }
  throw new Error(`No owner decision for ${String(status.for)}`);
}

/** Commit identity counts only: emails are compared, never reported. */
function identity(commits: Json[], email: string) {
  return {
    commits: commits.length,
    authorNoreply: commits.filter((c) => c.commit?.author?.email === email)
      .length,
    committerNoreply: commits.filter(
      (c) => c.commit?.committer?.email === email,
    ).length,
    /** Merge commits the backend made through the API (two parents). */
    merges: commits.filter((c) => (c.parents as unknown[])?.length > 1).length,
  };
}

export async function run(h: OrcaHarness): Promise<void> {
  const statusPath = absolute('AIO_T17_STATUS');
  const reportPath = absolute('AIO_T17_REPORT');
  const ownerWaitMs =
    Number(process.env.AIO_T17_OWNER_WAIT_MIN ?? '720') * 60_000;
  const orcaBin = await resolveBinary('orca', process.env.AIO_ORCA_BIN);
  const ghBin = await resolveBinary('gh', process.env.AIO_GH_BIN);
  const orcaHome = approvedOrcaHome();
  const tag = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const home = join(h.ledger.dataDir, 'production');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(
    join(home, 'config.toml'),
    productionConfig({
      orcaBin,
      ghBin,
      orcaHome,
      expectedLogin: OWNER,
      enforcement: 'off',
    }),
    { mode: 0o600 },
  );
  const expect = new Expectations();
  const record: DriveRecord = {
    stageGates: [],
    cliCallsPerMinute: [],
    exceptions: [],
  };
  const report: Json = { tag, template: 'feature-to-pr' };
  const save = () =>
    writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });

  await withHarness(async (github) => {
    // N6: agents commit with the clone's repo-local noreply identity.
    if (!(await noreplyApplied(h.ledger.repoPath, github.gate.email)))
      throw new Error('Repo-local noreply identity is not applied');
    const reader = new GithubApi(github.gate.fetch);
    const effects = await h.composedBackend(home);
    const server = await runProductionCli({ home });
    if (server.kind !== 'ready')
      throw new Error(`production start exited ${server.exitCode}`);
    let workflowId: string | undefined;
    let api: Api | undefined;
    let finished = false;
    try {
      // Production has no testOnly seam: ledger the shim by its marker.
      if (!(await ledgerShims(h, effects)))
        throw new Error('Backend shim not found');
      await effects.settle();
      api = await session(server.url, server.bootstrapUrl);
      const live = api;
      const health = (await live.call('GET', '/api/v1/health')).body;
      expect.that(
        healthFailures(health, orcaHome).length === 0,
        `production health (${healthFailures(health, orcaHome).join(', ')})`,
      );
      report.rateLimit = { start: health?.scm?.rateLimit?.remaining };
      const repoId = await registerRepo(live, h.ledger.repoPath);
      const repo = (
        (await live.call('GET', '/api/v1/repos')).body?.repos as Json[]
      ).find((r) => r.repoId === repoId);
      expect.that(
        registrationFailures(repo).length === 0,
        `spike registration (${registrationFailures(repo).join(', ')})`,
      );
      let shortId = '';
      const started = await startWorkflow(
        h,
        live,
        {
          templateId: 'feature-to-pr',
          repoId,
          requirement: smokeRequirement(tag),
        },
        (id) => {
          shortId = id;
        },
      );
      workflowId = started.workflowId;
      const id = workflowId;
      // The T7 scan and janitor cover the workflow namespace from now on.
      if (!github.ledger.data.claims.includes(shortId)) {
        github.ledger.data.claims.push(shortId);
        await github.ledger.save();
      }
      const startedAt = Date.now();
      report.shortId = shortId;
      await save();

      let orcaRun: string | undefined;
      let imported = 0;
      const answered = new Set<string>();
      // Every drive iteration: adopt the run, import SCM objects, relay
      // escalated questions to the owner.
      const tick = async () => {
        orcaRun ??= await adoptRun(h, live, id);
        if (Date.now() - imported > 30_000) {
          imported = Date.now();
          await registerEvents(
            github.ledger,
            ledgerEvents(await events(live, id)),
            id,
            shortId,
          );
        }
        const questions = ((
          await live.call('GET', '/api/v1/questions?status=escalated')
        ).body?.questions ?? []) as Json[];
        for (const q of questions) {
          if (q.workflowId !== id || answered.has(q.questionId)) continue;
          const answer = await ownerDecision(
            statusPath,
            {
              phase: 'question',
              for: q.questionId,
              role: q.role,
              body: q.body,
            },
            ownerWaitMs,
          );
          const posted = await live.call(
            'POST',
            `/api/v1/questions/${encodeURIComponent(q.questionId)}/answer`,
            { body: String(answer.body) },
          );
          if (posted.status >= 300) throw new Error(`answer ${posted.status}`);
          answered.add(q.questionId);
        }
        return orcaRun;
      };
      const onException = async (gate: Json) => {
        const detail = (
          await live.call(
            'GET',
            `/api/v1/gates/${encodeURIComponent(gate.gateId)}`,
          )
        ).body;
        const decision = await ownerDecision(
          statusPath,
          {
            phase: 'exception',
            for: `${gate.gateId}@${gate.version}`,
            exceptionKind: gate.exceptionKind,
            options: (detail?.options as Json[] | undefined)?.map((o) => ({
              optionId: o.optionId ?? o.id,
              decision: o.decision,
              label: o.label,
            })),
            trace: (await compactTrace(live, id)).slice(-40),
          },
          ownerWaitMs,
        );
        if (decision.stop === true) return false;
        const decided = await decide(live, gate, decision.request as Json);
        if (decided.status >= 300)
          throw new Error(`exception decision ${decided.status}`);
        return true;
      };

      const reached = await driveSmokeToFinalGate(h, live, id, {
        tag,
        run: tick,
        record,
        onException,
      });
      let log = await events(live, id);
      await registerEvents(github.ledger, ledgerEvents(log), id, shortId);
      const issued = new Map(
        log
          .filter((e) => e.type === 'command.issued')
          .map((e) => [e.payload.commandId as string, e.payload as Json]),
      );
      const prs = log
        .filter(
          (e) =>
            e.type === 'command.succeeded' && e.payload.kind === 'scm.openPR',
        )
        .map((e) => ({
          number: e.payload.result?.pr as number,
          base: issued.get(e.payload.commandId)?.args?.base as string,
        }));
      const finalPr = prs.find((p) => p.base === 'main')?.number;
      const workerPrs = prs
        .filter((p) => p.base !== 'main')
        .map((p) => p.number);
      report.reachedFinalGate = reached.finalGate !== undefined;
      report.revisedSplit = reached.revisedSplit;
      report.minutesToFinalGate = Math.round((Date.now() - startedAt) / 60_000);
      report.workerPrs = workerPrs.length;
      report.finalPr = finalPr;
      if (!reached.finalGate || !finalPr)
        throw new Error(
          `final-PR gate not reached (${reached.workflow.status})`,
        );

      // §27 identity checks before the owner merges (counts only). A failed
      // read is a finding, never a reason to abandon the final PR.
      const identityChecks = async () => {
        const authors = new Set<string>();
        const issues = log
          .filter(
            (e) =>
              e.type === 'command.succeeded' &&
              e.payload.kind === 'scm.createIssue',
          )
          .map((e) => e.payload.result?.issue as number);
        for (const n of [...workerPrs, finalPr, ...issues]) {
          const { data } = await reader.request('GET', `/issues/${n}`);
          authors.add(String((data.user as Json | undefined)?.login));
        }
        const workerCommits: Json[] = [];
        for (const n of workerPrs)
          workerCommits.push(...(await reader.list(`/pulls/${n}/commits`)));
        const branches = new Set(
          log
            .filter((e) => e.type === 'workitem.dispatched')
            .map((e) => e.payload.branch as string),
        );
        const integration = log.find((e) => e.type === 'workflow.started')
          ?.payload.integrationBranch as string | undefined;
        if (integration) branches.add(integration);
        const pushes = (await reader.list('/activity')).filter((a) =>
          branches.has(String(a.ref).replace(/^refs\/heads\//, '')),
        );
        Object.assign(report, {
          objectAuthors: [...authors],
          issues: issues.length,
          agentCommits: identity(workerCommits, github.gate.email),
          pushes: {
            count: pushes.length,
            actors: [...new Set(pushes.map((p) => (p.actor as Json)?.login))],
          },
        });
        expect.that(
          authors.size === 1 && authors.has(OWNER),
          'every Issue and PR is by ClarkeYeh',
        );
        expect.that(
          workerCommits.length > 0 &&
            workerCommits.every(
              (c) =>
                c.commit?.author?.email === github.gate.email &&
                c.commit?.committer?.email === github.gate.email,
            ),
          'agent commits use the noreply identity',
        );
        expect.that(
          pushes.length > 0 &&
            pushes.every((p) => (p.actor as Json)?.login === OWNER),
          'every push is by ClarkeYeh',
        );
      };
      await identityChecks().catch((error: unknown) =>
        expect.that(
          false,
          `identity checks threw (${error instanceof Error ? error.message : 'unknown'})`,
        ),
      );
      await save();

      // Q1: the owner merges by hand. Never decide the final-PR gate here.
      await writeFile(
        statusPath,
        JSON.stringify(
          {
            phase: 'final-pr',
            for: reached.finalGate.gateId,
            finalPr,
            url: `https://github.com/ClarkeYeh/ai-office-spike/pull/${finalPr}`,
            at: new Date().toISOString(),
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      console.info(`T17 final PR #${finalPr} is waiting for the owner`);
      const mergeWaitStarted = Date.now();
      const final = await drive(
        h,
        live,
        id,
        (w) => ['completed', 'failed', 'cancelled'].includes(w.status),
        {
          run: tick,
          record,
          onException,
          stallMs: ownerWaitMs,
          onStageGate: async (gate) => gate.stageKind === 'final-pr',
        },
      );
      log = await events(live, id);
      await registerEvents(github.ledger, ledgerEvents(log), id, shortId);
      const merged = log.find(
        (e) =>
          e.type === 'pr.status' &&
          e.payload.pr === finalPr &&
          e.payload.state === 'merged',
      );
      const mergedSeq = (merged?.seq as number) ?? Number.MAX_SAFE_INTEGER;
      const mergeCommit = merged?.payload.mergeCommitSha
        ? (
            await reader.request(
              'GET',
              `/commits/${merged.payload.mergeCommitSha}`,
            )
          ).data
        : undefined;
      const finalCommits = await reader.list(`/pulls/${finalPr}/commits`);
      const anomalies = log.filter((e) => e.type === 'anomaly.detected');
      const info = attempts(log);
      const hits = log
        .filter((e) => e.type === 'seat.policy_violation')
        .flatMap((e) =>
          (e.payload.hits as Json[]).map((hit) => ({
            rule: hit.rule,
            severity: hit.severity,
            purpose: info.get(e.payload.attemptId)?.purpose,
            agent: info.get(e.payload.attemptId)?.agent,
          })),
        );
      const integratorShell = log
        .filter(
          (e) =>
            e.type === 'seat.activity' &&
            info.get(e.payload.attemptId)?.purpose === 'integrator',
        )
        .flatMap((e) => e.payload.activity as Json[])
        .filter(
          (a) => a.category === 'shell' || a.category === 'network',
        ).length;
      const health2 = (await live.call('GET', '/api/v1/health')).body;
      Object.assign(report, {
        status: final.status,
        minutesTotal: Math.round((Date.now() - startedAt) / 60_000),
        minutesWaitingForOwner: Math.round(
          (Date.now() - mergeWaitStarted) / 60_000,
        ),
        merged: merged
          ? {
              mergedByOwner: merged.payload.mergedBy === OWNER,
              mergeCommitAuthorNoreply:
                (mergeCommit?.commit as Json)?.author?.email ===
                github.gate.email,
              mergeCommitCommitterLogin: (mergeCommit?.committer as Json)
                ?.login,
            }
          : null,
        gateClosedMerged: log.some(
          (e) =>
            e.type === 'gate.closed' &&
            e.payload.gateId === reached.finalGate!.gateId &&
            e.payload.reason === 'merged',
        ),
        workflowCompleted: log.some((e) => e.type === 'workflow.completed'),
        anomalies: anomalies.map((e) => ({
          kind: e.payload.kind,
          severity: e.payload.severity,
          afterMerge: (e.seq as number) > mergedSeq,
        })),
        finalPrCommits: identity(finalCommits, github.gate.email),
        policyHits: hits,
        integratorShellOrNetworkActions: integratorShell,
        itemsMerged: log
          .filter((e) => e.type === 'workitem.merged')
          .map((e) => e.payload.itemKey),
        agentsByItem: Object.fromEntries(
          log
            .filter((e) => e.type === 'workitem.dispatched')
            .map((e) => [e.payload.itemKey, e.payload.agent]),
        ),
        questions: count(log, 'message.question'),
        escalations: count(log, 'message.escalated'),
        reworkRequests: count(log, 'workitem.rework_requested'),
        statesByAgent: statesByAgent(log),
        submittingAgents: submittingAgents(log),
        errorAttempts: errorAttempts(log).length,
        duplicatedFacts: duplicatedFacts(log),
        repeatedSends: repeatedSends(log).length,
        spawnStall: spawnStallFalsePositives(log),
        providerRateLimit: rateLimitReport(log),
        budgetEvents: log.filter((e) => e.type.startsWith('budget.')).length,
        exceptions: record.exceptions,
        stageGates: record.stageGates.map((g) => ({
          gate: g.stageKind,
          live: g.live.length,
        })),
        maxCliCallsPerMinute: Math.max(0, ...record.cliCallsPerMinute),
        usage: usageByRole(log),
      });
      (report.rateLimit as Json).end = health2?.scm?.rateLimit?.remaining;
      expect.that(
        final.status === 'completed',
        `workflow completed (${final.status})`,
      );
      expect.that(merged !== undefined, 'pr.status merged observed');
      expect.that(merged?.payload.mergedBy === OWNER, 'mergedBy is the owner');
      expect.that(Boolean(report.gateClosedMerged), 'gate.closed{merged}');
      expect.that(Boolean(report.workflowCompleted), 'workflow.completed');
      expect.that(
        !anomalies.some((e) => (e.seq as number) > mergedSeq),
        'the default branch moving raised no anomaly',
      );
      expect.that(
        (mergeCommit?.commit as Json)?.author?.email === github.gate.email,
        'the merge commit uses the noreply email',
      );
      expect.that(
        record.stageGates.every((g) => g.live.length === 0),
        'no live Orca worker while a stage gate is open',
      );
      // Policy hits are reported, not asserted: events carry no command text,
      // so each hit is triaged against the agent's transcript after the run.
      expect.that(errorAttempts(log).length === 0, 'no attempt in error');
      expect.that(duplicatedFacts(log).length === 0, 'no duplicated ingestion');
      expect.that(
        log.filter((e) => e.type.startsWith('budget.')).length === 0,
        'enforcement off: no budget.* events',
      );
      finished = true;
    } finally {
      if (workflowId && api) {
        if (!finished)
          report.trace = await compactTrace(api, workflowId).catch(() => []);
        await registerEvents(
          github.ledger,
          ledgerEvents(await events(api, workflowId).catch(() => [])),
          workflowId,
          String(report.shortId ?? ''),
        ).catch(() => undefined);
      }
      report.backendStopExit = await server.stop();
      await save().catch(() => undefined);
    }
  });
  report.githubJanitor = 'clean';
  await save();
  console.info(`T17 smoke report: ${reportPath}`);
  expect.assert();
}
