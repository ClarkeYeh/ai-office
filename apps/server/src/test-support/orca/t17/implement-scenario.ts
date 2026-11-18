/**
 * M2-T17 engine-driven implement (plan option d): real Orca + scm-gitremote
 * (testOnly ScmPort). A small test template runs a 1-round meeting and the
 * planning stage; the task-split gate replaces the proposal with exactly two
 * items (B depends on A). A is merged by the merge queue, B starts from the new
 * integration head, B is reworked once through its retained worktree (W1), the
 * wrap-up runs, and the final PR (in-memory) is merged explicitly by the test.
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { startServer } from '../../../main.js';
import type { ScmPort } from '../../../ports/scm.js';
import type { PrRef } from '../../../ports/refs.js';
import type { OrcaHarness } from '../harness.js';
import { composedShimOptions } from '../composed-shim-seam.js';
import { requireValue } from '../contract-live-cli.js';
import { GitRemoteScm } from '../scm-gitremote/index.js';
import {
  count,
  duplicatedFacts,
  errorAttempts,
  rateLimitReport,
  repeatedSends,
  spawnStallFalsePositives,
  statesByAgent,
  submittingAgents,
  usageByRole,
} from './checks.js';
import {
  adoptRun,
  backendHome,
  decide,
  drive,
  events,
  Expectations,
  registerRepo,
  session,
  startWorkflow,
  writeReport,
  compactTrace,
  type DriveRecord,
  type Json,
} from './office.js';

const git = promisify(execFile);
export const assertClean = true;

/** Built-in roles and stage kinds; only the meeting is trimmed (1 round, 2 participants). */
export const TEST_TEMPLATE = `apiVersion: ai-office/v1alpha1
id: aio-test-implement
name: T17 implement acceptance
roles:
  lead: { agent: claude-code, scope: 'Facilitate briefly; split work; answer on-call questions' }
  pm: { agent: claude-code, scope: 'Check scope and acceptance criteria' }
  engineer: { agent: codex, scope: 'Implement the assigned work item exactly as written' }
  integrator: { agent: claude-code, scope: 'Review worker PRs in the merge queue and write the integration report' }
defaults:
  integrationBranch: 'ai-office/{shortId}-{slug}'
  maxReruns: 1
  budget: { hardLimitMultiplier: 2 }
stages:
  - id: meeting
    kind: meeting
    facilitator: lead
    # The meeting stage requires at least two effective speakers.
    participants: [pm, engineer]
    maxRounds: 1
    timeouts: { roundMin: 15, stageMin: 40 }
    budget: { tokens: 300000, maxTurns: 60 }
    conclusion: { requireTechDecisions: false }
    gate: { id: conclusion, title: Conclusion, optional: true }
  - id: breakdown
    kind: planning
    owner: lead
    from: meeting
    timeouts: { stageMin: 30 }
    budget: { tokens: 200000, maxTurns: 40 }
    gate: { id: task-split, title: Task split, optional: true, editable: [title, body, acceptance, role, agent, deps] }
  - id: implement
    kind: implement
    role: engineer
    from: breakdown
    maxParallel: 2
    timeouts: { itemMin: 45 }
    budget: { tokens: 1800000, perItem: { tokens: 400000, maxTurns: 120 } }
    onCall: { role: lead, questionTimeoutMin: 10 }
    mergeQueue: { role: integrator, reviewTimeoutMin: 20, maxRework: 2 }
    escalateOn: [unresolvable-conflict]
  - id: integrate
    kind: integrate
    owner: integrator
    timeouts: { stageMin: 30 }
    budget: { tokens: 200000, maxTurns: 60 }
  - id: final-pr
    kind: final-pr
    maxRevisions: 1
    gate: { id: final-pr, title: Final PR }
`;

const REQUIREMENT =
  'Acceptance test: add two tiny text files under t17/. Item A creates t17/greeting.txt; item B creates t17/farewell.txt after A is merged. Nothing else.';

/** The two items the owner approves at the task-split gate (B depends on A). */
export const ITEMS = [
  {
    key: 'greeting',
    title: 'Add t17/greeting.txt',
    body: 'Create the file t17/greeting.txt containing exactly one line: `hello from item A`. Before writing it, ask your on-call lead exactly one short question using the AI Office question mechanism from your instructions: "Should the greeting line end with a period? Answer yes or no." Follow the answer. Change no other file.',
    acceptance: ['t17/greeting.txt exists and contains only the greeting line'],
    role: 'engineer',
    agent: 'codex',
    deps: [],
  },
  {
    key: 'farewell',
    title: 'Add t17/farewell.txt',
    body: 'Create the file t17/farewell.txt containing exactly one line: `goodbye from item B`. Item A (t17/greeting.txt) is already merged into your base; do not modify it. Do not add any other line unless a merge-queue reviewer asks for it. While your merge request is being processed, do not push.',
    acceptance: [
      't17/farewell.txt exists and t17/greeting.txt from item A is present in the branch',
      'Merge-queue reviewer: on the FIRST review of this item you MUST request rework, asking the worker to append a second line `reviewed` to t17/farewell.txt. Approve and merge the next submission once that line is present.',
    ],
    role: 'engineer',
    agent: 'codex',
    deps: ['greeting'],
  },
];

/** Git-writing SCM calls; issues, labels and PRs live in memory. */
const SCM_WRITES = new Set(['ensureBranch', 'deleteBranch', 'mergePR']);

/** Holds every SCM write until the workflow namespace claim is journaled. */
function gatedScm(
  inner: GitRemoteScm,
  claimed: Promise<void>,
  onFinalPr: (ref: PrRef) => void,
): ScmPort {
  return new Proxy(inner, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      const bound = (value as (...a: unknown[]) => unknown).bind(target);
      if (property !== 'openPR' && !SCM_WRITES.has(String(property)))
        return bound;
      return async (...args: unknown[]) => {
        if (SCM_WRITES.has(String(property))) await claimed;
        const result = await bound(...args);
        if (
          property === 'openPR' &&
          (args[1] as { base?: string }).base === 'main'
        )
          onFinalPr(result as PrRef);
        return result;
      };
    },
  }) as unknown as ScmPort;
}

export async function run(h: OrcaHarness): Promise<void> {
  const home = process.env.HOME;
  requireValue(home, 'HOME required');
  const dir = await backendHome(h, {
    enforcement: 'off',
    templates: { 'aio-test-implement.yaml': TEST_TEMPLATE },
  });
  const inner = await GitRemoteScm.create({
    remote: h.ledger.repoPath,
    harness: h,
  });
  let bound!: () => void;
  const claimed = new Promise<void>((r) => (bound = r));
  let finalPr: PrRef | undefined;
  const scm = gatedScm(inner, claimed, (ref) => (finalPr = ref));
  const effects = await h.composedBackend(dir);
  const { testOnly, ...seam } = composedShimOptions({
    orcaHome: join(home, '.ai-office', 'orca-home'),
    onShimCreated: effects.shim,
  });
  const server = await startServer({
    dev: true,
    runtime: 'orca',
    port: 0,
    env: { ...process.env, AI_OFFICE_HOME: dir },
    webDist: join(dir, 'no-web'),
    print: () => undefined,
    ...seam,
    testOnly: { ...testOnly, scm },
  });
  await effects.settle();
  const expect = new Expectations();
  const record: DriveRecord = {
    stageGates: [],
    cliCallsPerMinute: [],
    exceptions: [],
  };
  const report: Record<string, unknown> = {};
  let workflowId: string | undefined;
  let api: Awaited<ReturnType<typeof session>> | undefined;
  let finished = false;
  try {
    api = await session(server.url, server.bootstrapUrl);
    const repoId = await registerRepo(api, h.ledger.repoPath);
    const started = await startWorkflow(
      h,
      api,
      { templateId: 'aio-test-implement', repoId, requirement: REQUIREMENT },
      () => bound(),
    );
    workflowId = started.workflowId;
    const id = workflowId;
    const live = api;
    const startedAt = Date.now();
    let orcaRun: string | undefined;
    let merged = false;
    const final = await drive(
      h,
      live,
      id,
      (w) => ['completed', 'failed', 'cancelled'].includes(w.status),
      {
        run: async () => (orcaRun ??= await adoptRun(h, live, id)),
        record,
        onStageGate: async (gate) => {
          orcaRun ??= await adoptRun(h, live, id);
          if (gate.stageKind === 'planning') {
            const decided = await decide(live, gate, {
              edits: { type: 'work-items', items: ITEMS },
            });
            if (decided.status >= 300 && decided.status !== 409)
              throw new Error(`task-split edit ${decided.status}`);
            return true;
          }
          if (gate.stageKind === 'final-pr') {
            // The explicit fake owner merge: in memory only, main is never pushed.
            if (finalPr && !merged) {
              inner.simulateOwnerMerge(finalPr);
              merged = true;
            }
            return true;
          }
          return false;
        },
      },
    );
    const log = await events(live, id);
    const dispatched = log.filter((e) => e.type === 'workitem.dispatched');
    const a = log.find(
      (e) => e.type === 'workitem.merged' && e.payload.itemKey === 'greeting',
    );
    const bFirst = dispatched.find(
      (e) => e.payload.itemKey === 'farewell' && !e.payload.reworkOf,
    );
    const bRework = dispatched.find(
      (e) => e.payload.itemKey === 'farewell' && e.payload.reworkOf,
    );
    let ancestor = false;
    if (a && bFirst?.payload.baseSha) {
      ancestor = await git('/usr/bin/git', [
        '-C',
        h.ledger.repoPath,
        'merge-base',
        '--is-ancestor',
        a.payload.mergeCommitSha,
        bFirst.payload.baseSha,
      ]).then(
        () => true,
        () => false,
      );
    }
    const farewellWorkspaces = log.filter(
      (e) =>
        e.type === 'command.issued' &&
        e.payload.kind === 'runtime.prepareWorkspace' &&
        e.payload.args?.branch === bFirst?.payload.branch,
    ).length;
    const prsFor = (key: string) => [
      ...new Set(
        log
          .filter(
            (e) =>
              (e.type === 'workitem.merged' ||
                e.type === 'workitem.rework_requested' ||
                e.type === 'workitem.merge_queued') &&
              e.payload.itemKey === key,
          )
          .map((e) => e.payload.pr as number),
      ),
    ];
    const stall = spawnStallFalsePositives(log);
    Object.assign(report, {
      status: final.status,
      minutes: Math.round((Date.now() - startedAt) / 60_000),
      itemsMerged: log
        .filter((e) => e.type === 'workitem.merged')
        .map((e) => e.payload.itemKey),
      bBaseContainsAMerge: ancestor,
      reworkRequests: count(log, 'workitem.rework_requested'),
      reworkSameBranch: bRework?.payload.branch === bFirst?.payload.branch,
      reworkSameWorkspace:
        bRework?.payload.workspaceName === bFirst?.payload.workspaceName,
      farewellWorkspacesPrepared: farewellWorkspaces,
      farewellPrs: prsFor('farewell').length,
      questions: count(log, 'message.question'),
      answers: log
        .filter((e) => e.type === 'message.answered')
        .map((e) => e.payload.by),
      escalations: count(log, 'message.escalated'),
      statesByAgent: statesByAgent(log),
      submittingAgents: submittingAgents(log),
      integrationReport: log.some(
        (e) =>
          e.type === 'submission.accepted' &&
          e.payload.kind === 'integration-report',
      ),
      finalPrMerged: merged,
      errorAttempts: errorAttempts(log).length,
      duplicatedFacts: duplicatedFacts(log),
      repeatedSends: repeatedSends(log).length,
      spawnStall: stall,
      rateLimit: rateLimitReport(log),
      exceptions: record.exceptions,
      budgetEvents: log.filter((e) => e.type.startsWith('budget.')).length,
      stageGates: record.stageGates.map((g) => ({
        gate: g.stageKind,
        live: g.live.length,
      })),
      maxCliCallsPerMinute: Math.max(0, ...record.cliCallsPerMinute),
      usage: usageByRole(log),
    });
    expect.that(
      final.status === 'completed',
      `workflow completed (${final.status})`,
    );
    expect.that(
      ['greeting', 'farewell'].every((k) =>
        (report.itemsMerged as string[]).includes(k),
      ),
      'both items merged through the merge queue',
    );
    expect.that(ancestor, "B's baseSha contains A's merge commit (§27)");
    expect.that(
      count(log, 'workitem.rework_requested') >= 1,
      'B reworked once',
    );
    expect.that(
      bRework !== undefined &&
        bRework.payload.branch === bFirst?.payload.branch &&
        bRework.payload.workspaceName === bFirst?.payload.workspaceName &&
        farewellWorkspaces === 1,
      'rework reused the retained worktree on the same branch (W1)',
    );
    expect.that(prsFor('farewell').length === 1, 'rework kept the same PR');
    expect.that(
      count(log, 'message.question') >= 1 &&
        count(log, 'message.answered') >= 1,
      'question asked and answered',
    );
    expect.that(merged, 'final PR opened and merged by the simulated owner');
    expect.that(errorAttempts(log).length === 0, 'no attempt in error');
    expect.that(duplicatedFacts(log).length === 0, 'no duplicated ingestion');
    expect.that(repeatedSends(log).length === 0, 'no repeated follow-up send');
    expect.that(
      stall.nudges === 0 && stall.gates === 0,
      'no spawn-stall false positive at the default 10 minutes',
    );
    expect.that(
      log.filter((e) => e.type.startsWith('budget.')).length === 0,
      'enforcement off: no budget.* events',
    );
    expect.that(
      record.stageGates.every((g) => g.live.length === 0),
      'no live Orca worker while a stage gate is open',
    );
    expect.that(
      record.cliCallsPerMinute.every((n) => n <= 120),
      'CLI calls per minute ≤ 120',
    );
    finished = true;
  } finally {
    if (workflowId && api && !finished)
      report.trace = await compactTrace(api, workflowId).catch(() => []);
    if (workflowId)
      await writeReport(h, 'implement', report).catch(() => undefined);
    await server.close();
    await inner.dispose();
  }
  expect.assert();
}

export type { Json };
