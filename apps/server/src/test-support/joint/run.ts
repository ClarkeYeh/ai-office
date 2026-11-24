/**
 * M5-T7 joint-run harness (M5_PLAN §2.1–§2.3): one control flow, two modes.
 * - `production` (T12): real `ai-office start` on an isolated home, real
 *   GitHub (spike, GitHub live lock + safety gate via `withHarness`), real Orca
 *   and agents; the final PR waits for the owner's hand merge (W2).
 * - `preview` (T11b, `preview/mode.ts`): `--dev --runtime orca` child +
 *   scm-gitremote stand-in in this process (bridged over IPC); the final PR
 *   is merged explicitly by the stand-in; no GitHub API, no owner.
 * - `dry` (`dry-run.ts`): the built CLI in `--dev --fake m5-mainline`.
 * Both: T8's `m5-mainline` text, the scripted owner policy, exactly one
 * `kill -9` (K or K′) with a same-home same-port restart, the 30 s health
 * sampler, restart assertions #1–10 and #12–17, the B4 export (raw only to a
 * private directory) and a private report of counts, booleans and durations.
 * OFFLINE in T7: this module is exercised live only by T11b and T12.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireLiveLock } from '../github/lock.js';
import type { OrcaHarness } from '../orca/harness.js';
import {
  adoptRun,
  events,
  gates,
  liveWorkers,
  registerRepo,
  startWorkflow,
  type Api,
  type Json,
} from '../orca/t17/office.js';
import { alive, checkProcesses } from '../orca/t17/backend-process.js';
import {
  CODE_NAME,
  mainlineTag,
  mainlineTemplates,
  requirement,
  TEMPLATE_ID,
} from './scenario/index.js';
import { restartAssertions, type RestartEvidence } from './assertions.js';
import { freePort, productionHome, productionLauncher } from './backends.js';
import { writeJointExports } from './export-run.js';
import {
  GITHUB_LOCK,
  ORCA_LOCK,
  caffeinateFor,
  holdsLock,
  oldControlTokenStatus,
  openSessionStatus,
  readControlToken,
  runInbox,
} from './observe.js';
import { OwnerPolicyExecutor, type OwnerPort } from './owner-policy.js';
import { RestartControl, RestartTrigger, type TriggerName } from './restart.js';
import { HealthSampler } from './sampler.js';
import { bootstrapCookie, cookieSession, HarnessStream } from './session.js';

const exec = promisify(execFile);

export type JointMode = 'production' | 'preview' | 'dry';

export interface JointPaths {
  /** Private status file for the coordinator / owner hand-offs. */
  status: string;
  /** Private numeric report. */
  report: string;
  /** Private directory for the raw export (outside the repo). */
  privateDir: string;
}

const absoluteEnv = (name: string) => {
  const value = process.env[name];
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be absolute`);
  return value;
};

export function jointPathsFromEnv(): JointPaths {
  return {
    status: absoluteEnv('AIO_JOINT_STATUS'),
    report: absoluteEnv('AIO_JOINT_REPORT'),
    privateDir: absoluteEnv('AIO_JOINT_PRIVATE_DIR'),
  };
}

export function jointModeFromEnv(): JointMode {
  const mode = process.env.AIO_JOINT_MODE ?? 'production';
  if (mode !== 'production' && mode !== 'preview')
    throw new Error('AIO_JOINT_MODE must be production or preview');
  return mode;
}

/** Ensures this process holds a live lock (idempotent; T16 may already hold it). */
export async function holdLock(path: string): Promise<() => Promise<void>> {
  if (await holdsLock(path)) return async () => undefined;
  return acquireLiveLock(path);
}

const TERMINAL = ['completed', 'failed', 'cancelled'];

/**
 * The T10 §24 checker, injected by the caller: joint may not import
 * `acceptance-check` (depcruise), so the acceptance tests pass
 * `(events, facts) => checkAcceptance(events, parseFacts(facts))`. Without
 * one, the facts snapshot is still written for `pnpm acceptance:check`.
 */
export type CheckerFacts = Record<string, unknown>;
export interface CheckerRow {
  id: string;
  verdict: 'pass' | 'fail' | 'na';
}
export type Judge = (
  events: Json[],
  facts: CheckerFacts,
) => { rows: CheckerRow[] };

export interface JudgedRow {
  id: string;
  verdict: 'pass' | 'fail' | 'na';
  /** Why a row is n/a in this mode (the checker's verdict is kept beside it). */
  reason?: string;
  checker?: 'pass' | 'fail' | 'na';
}

/**
 * The checker's rows with this mode's known-unjudgeable rows mapped to n/a
 * (with the reason). A passing row always stays a pass.
 */
export function judgeAcceptance(
  report: { rows: CheckerRow[] },
  na: Record<string, string>,
): { rows: JudgedRow[]; summary: Record<JudgedRow['verdict'], number> } {
  const rows = report.rows.map((r): JudgedRow => {
    const reason = na[r.id];
    if (reason === undefined || r.verdict === 'pass')
      return { id: r.id, verdict: r.verdict };
    return { id: r.id, verdict: 'na', reason, checker: r.verdict };
  });
  const summary = { pass: 0, fail: 0, na: 0 };
  for (const r of rows) summary[r.verdict] += 1;
  return { rows, summary };
}

/** Polls `check` every 2 s until true or `ms` elapsed. */
async function waitFor(
  check: () => Promise<boolean>,
  ms: number,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check().catch(() => false)) return true;
    if (Date.now() > deadline) return false;
    await delay(2_000);
  }
}

/**
 * The Orca side of a run: level-A reads through the M2 harness (live modes),
 * or nothing at all (the dry run has no Orca; those rows become n/a).
 */
export interface Side {
  repoPath: string;
  startWorkflow(
    api: Api,
    request: Json,
    onBound: (shortId: string) => void,
  ): Promise<{ workflowId: string; shortId: string }>;
  adoptRun(api: Api, workflowId: string): Promise<string | undefined>;
  liveAgents(run: string | undefined): Promise<number | undefined>;
  shims(): Promise<string[] | undefined>;
  worktrees(): Promise<string[] | undefined>;
  /** `orca check` process groups of our shim. */
  checkGroups(): Promise<number[] | undefined>;
  inbox(run: string): Promise<{ id: string; sequence: number }[] | undefined>;
  runs(): number | undefined;
}

export function orcaSide(h: OrcaHarness): Side {
  const scan = async (kind: 'shim' | 'worktree') =>
    (await h.scan())
      .filter((r) => r.kind === kind)
      .map((r) => (kind === 'shim' ? r.id : r.name));
  return {
    repoPath: h.ledger.repoPath,
    startWorkflow: (api, request, onBound) =>
      startWorkflow(h, api, request, onBound),
    adoptRun: (api, id) => adoptRun(h, api, id),
    liveAgents: async (run) =>
      run ? (await liveWorkers(h, run)).length : undefined,
    shims: () => scan('shim'),
    worktrees: () => scan('worktree'),
    async checkGroups() {
      const shim = h.ledger.shims.find((s) => !s.done)?.id;
      return shim ? checkProcesses(shim) : [];
    },
    inbox: (run) => runInbox(h, run),
    runs: () => h.ledger.runs.length,
  };
}

export interface Mode {
  kind: JointMode;
  /** The run's directory tag when the mode fixed it (T8 binding). */
  tag?: string;
  side: Side;
  /** Drive-loop interval. */
  pollMs: number;
  /** Live locks are sampled for #16 (the dry run holds none). */
  sampleLocks: boolean;
  /** The backend keeps a prevent-sleep child for #14 (not in the fake runtime). */
  preventSleepChild: boolean;
  /** Mode-specific checker facts (the drill adds first-parent, markers, gates). */
  checkerFacts?: (log: Json[]) => Promise<CheckerFacts>;
  /** Checker rows this mode cannot judge, id → reason (never hides a pass). */
  checkerNa: Record<string, string>;
  /**
   * Dry run only: hold the kill until the fake world's coalesced checkpoint
   * covers what the backend ingested (a kill -9 loses up to the last second
   * of the in-memory stand-in; real Orca keeps no such cache). Returns the
   * milliseconds held.
   */
  beforeKill?: (api: Api, workflowId: string) => Promise<number>;
  /** Dry run only: undo `beforeKill` on the restarted backend. */
  afterRestart?: (api: Api) => Promise<void>;
  /** Dry run: leftover scan of the fake world after cleanup (counts). */
  janitor?: (log: Json[]) => Promise<Json>;
  launcher: () => Promise<import('./restart.js').ControlledBackend>;
  home: string;
  /** Ledgers the shim after the first start (production: by marker). */
  afterFirstStart(): Promise<void>;
  /** Every pass: production SCM objects into the GitHub ledger. */
  importObjects(
    log: Json[],
    workflowId: string,
    shortId: string,
    force?: boolean,
  ): Promise<void>;
  /** A file's content on the integration branch (booleans derive from it). */
  integrationFile(log: Json[], path: string): Promise<string | undefined>;
  onShortId(shortId: string): Promise<void>;
  ownerApproveComment?: (log: Json[]) => Promise<void>;
  finalPr(
    gate: Json,
    log: Json[],
    finalPr: number | undefined,
    api: Api,
  ): Promise<void>;
  /** Integration-branch first parents and marker counts (GA or stand-in). */
  scmFacts(log: Json[]): Promise<NonNullable<RestartEvidence['scm']>>;
  dispose(): Promise<void>;
}

/** Runner scenario entry (`runHarnessCli record <name> --scenario run.ts`). */
export const assertClean = true;

export async function run(h: OrcaHarness): Promise<void> {
  await runJoint(h, jointModeFromEnv(), jointPathsFromEnv());
}

export async function runJoint(
  h: OrcaHarness,
  mode: JointMode,
  paths: JointPaths,
): Promise<Json> {
  if (mode !== 'production')
    throw new Error(
      'runJoint runs production; the T11b preview is joint/preview/scenario.ts',
    );
  const releaseOrca = await holdLock(ORCA_LOCK);
  try {
    const { withHarness } = await import('../github/harness.js');
    return await withHarness(async (github) =>
      drill(await productionMode(h, github), paths),
    );
  } finally {
    await releaseOrca();
  }
}

type Github = Awaited<
  ReturnType<typeof import('../github/harness.js').openHarness>
>;

async function productionMode(h: OrcaHarness, github: Github): Promise<Mode> {
  const smoke = await import('../github/production-smoke.js');
  const { registerEvents } = await import('../github/ledger.js');
  const { githubOwnerActions } = await import('../github/owner-actions.js');
  if (!(await smoke.noreplyApplied(h.ledger.repoPath, github.gate.email)))
    throw new Error('Repo-local noreply identity is not applied');
  const home = join(h.ledger.dataDir, 'production');
  const port = await freePort();
  await productionHome({
    home,
    port,
    config: {
      orcaBin: await smoke.resolveBinary('orca', process.env.AIO_ORCA_BIN),
      ghBin: await smoke.resolveBinary('gh', process.env.AIO_GH_BIN),
      orcaHome: smoke.approvedOrcaHome(),
      expectedLogin: smoke.OWNER,
    },
    templates: await mainlineTemplates(),
  });
  const effects = await h.composedBackend(home);
  const owner = githubOwnerActions(github.api, github.ledger.data.runId);
  let imported = 0;
  return {
    kind: 'production',
    side: orcaSide(h),
    pollMs: 2_000,
    sampleLocks: true,
    preventSleepChild: true,
    checkerNa: {},
    home,
    launcher: productionLauncher({ home, port }),
    async afterFirstStart() {
      if (!(await smoke.ledgerShims(h, effects)))
        throw new Error('Backend shim not found');
      await effects.settle();
    },
    async importObjects(log, workflowId, shortId, force = false) {
      if (!force && Date.now() - imported < 30_000) return;
      imported = Date.now();
      await registerEvents(
        github.ledger,
        log.map((e) => ({
          type: String(e.type),
          workflowId: (e.workflowId ?? null) as string | null,
          payload: e.payload as unknown,
        })),
        workflowId,
        shortId,
      );
    },
    async integrationFile(log, path) {
      const integration = log.find((e) => e.type === 'workflow.started')
        ?.payload.integrationBranch as string | undefined;
      if (!integration) return undefined;
      const { status, data } = await github.api.request(
        'GET',
        `/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(integration)}`,
      );
      return status === 200 && typeof data.content === 'string'
        ? Buffer.from(data.content, 'base64').toString('utf8')
        : undefined;
    },
    async onShortId(shortId) {
      if (!github.ledger.data.claims.includes(shortId)) {
        github.ledger.data.claims.push(shortId);
        await github.ledger.save();
      }
    },
    async ownerApproveComment(log) {
      const issue = log.find(
        (e) =>
          e.type === 'command.succeeded' &&
          e.payload.kind === 'scm.createIssue',
      )?.payload.result?.issue as number | undefined;
      if (issue) await owner.ownerComment(issue, 'approve', '/approve');
    },
    async finalPr() {
      // Q1 / W2: never decided here; the status file says it can be merged.
    },
    async scmFacts(log) {
      const integration = log.find((e) => e.type === 'workflow.started')
        ?.payload.integrationBranch as string | undefined;
      const markerCounts: Record<string, number> = {};
      const shortId = log.find((e) => e.type === 'workflow.started')?.payload
        .shortId as string | undefined;
      try {
        for (const o of await github.api.list('/issues?state=all')) {
          const id = /<!-- ai-office:cmd=(.+?) -->/.exec(
            String(o.body ?? ''),
          )?.[1];
          if (id && shortId && id.includes(shortId))
            markerCounts[id] = (markerCounts[id] ?? 0) + 1;
        }
        const merged = log.filter((e) => e.type === 'workitem.merged');
        const first = merged[0]?.payload.mergeCommitSha as string | undefined;
        if (!integration || !first) return { markerCounts };
        // Walk first parents back from the head until before the first merge.
        const head = (
          await github.api.request(
            'GET',
            `/branches/${encodeURIComponent(integration)}`,
          )
        ).data as Json;
        const chain: string[] = [];
        let sha = head?.commit?.sha as string | undefined;
        for (let i = 0; sha && i < 50; i++) {
          chain.unshift(sha);
          if (sha === first) break;
          const commit = (await github.api.request('GET', `/commits/${sha}`))
            .data as Json;
          sha = (commit.parents as Json[] | undefined)?.[0]?.sha;
        }
        return { markerCounts, integrationFirstParents: chain };
      } catch {
        return { markerCounts };
      }
    },
    dispose: async () => undefined,
  };
}

/** The shared control flow of both modes. */
export async function drill(
  mode: Mode,
  paths: JointPaths,
  judge?: Judge,
): Promise<Json> {
  const side = mode.side;
  const tag = mode.tag ?? mainlineTag(new Date());
  const report: Json = { mode: mode.kind, tag, template: TEMPLATE_ID };
  const save = () =>
    writeFile(paths.report, JSON.stringify(report, null, 2), { mode: 0o600 });
  const status = (body: Json) =>
    writeFile(
      paths.status,
      JSON.stringify({ ...body, at: new Date().toISOString() }, null, 2),
      { mode: 0o600 },
    );
  const control = new RestartControl({ home: mode.home, start: mode.launcher });
  const trigger = new RestartTrigger();
  const locks = { github: [] as boolean[], orca: [] as boolean[] };
  let backend = await control.start();
  let stream: HarnessStream | undefined;
  let sampler: HealthSampler | undefined;
  let workflowId: string | undefined;
  let api: Api | undefined;
  try {
    await mode.afterFirstStart();
    const cookie = await bootstrapCookie(backend.bootstrapUrl);
    const live = cookieSession(backend.url, cookie);
    api = live;
    sampler = new HealthSampler(() => live);
    sampler.start();
    const repoId = await registerRepo(live, side.repoPath);
    let shortId = '';
    const started = await side.startWorkflow(
      live,
      { templateId: TEMPLATE_ID, repoId, requirement: requirement(tag) },
      (id) => (shortId = id),
    );
    const id = started.workflowId;
    workflowId = id;
    await mode.onShortId(shortId);
    report.shortId = shortId;
    const startedAt = Date.now();
    await save();

    let fired: { trigger: TriggerName; seq: number } | undefined;
    let maxSeq = 0;
    const feed = (e: Json) => {
      maxSeq = Math.max(maxSeq, Number(e.seq) || 0);
      const t = trigger.observe(e);
      if (t && !fired) fired = { trigger: t, seq: Number(e.seq) };
    };
    stream = new HarnessStream({
      url: () => control.backend.url,
      cookie,
      workflowId: id,
      onEvent: feed,
    });
    stream.start();

    let log: Json[] = [];
    const port: OwnerPort = {
      openGates: async () =>
        (await gates(live, id)).filter((g) => g.status === 'open'),
      gateDetail: async (gateId) =>
        (await live.call('GET', `/api/v1/gates/${encodeURIComponent(gateId)}`))
          .body,
      async decide(gate, body) {
        const detail = (
          await live.call(
            'GET',
            `/api/v1/gates/${encodeURIComponent(gate.gateId)}`,
          )
        ).body;
        return live.call(
          'POST',
          `/api/v1/gates/${encodeURIComponent(gate.gateId)}/decision`,
          {
            expectedVersion: detail.version,
            ...(detail.conclusion
              ? {
                  githubBodyHash:
                    detail.conclusion.githubBodyHash ??
                    detail.conclusion.renderedHash,
                }
              : {}),
            ...body,
          },
        );
      },
      async questionItem(questionId) {
        const questions = ((await live.call('GET', '/api/v1/questions')).body
          ?.questions ?? []) as Json[];
        const q = questions.find((x) => x.questionId === questionId);
        return typeof q?.itemKey === 'string' ? q.itemKey : undefined;
      },
      answer: (questionId, body) =>
        live.call(
          'POST',
          `/api/v1/questions/${encodeURIComponent(questionId)}/answer`,
          { body },
        ),
      ...(mode.ownerApproveComment
        ? { ownerApproveComment: () => mode.ownerApproveComment!(log) }
        : {}),
      handOff: (body) => status(body),
      async finalPr(gate) {
        // The gate's own content names the PR; the event log can lag behind
        // the gate under load, so it is only the fallback.
        const finalPr = ((gate.content as Json | undefined)?.pr ??
          log.find(
            (e) =>
              e.type === 'command.succeeded' &&
              e.payload.kind === 'scm.openPR' &&
              log.some(
                (i) =>
                  i.type === 'command.issued' &&
                  i.payload.commandId === e.payload.commandId &&
                  i.payload.args?.base === 'main',
              ),
          )?.payload.result?.pr) as number | undefined;
        report.finalPr = finalPr ?? null;
        report.minutesToFinalGate = Math.round(
          (Date.now() - startedAt) / 60_000,
        );
        if (mode.kind === 'production')
          await status({
            phase: 'can-merge',
            for: gate.gateId,
            finalPr,
            url: `https://github.com/ClarkeYeh/ai-office-spike/pull/${finalPr}`,
          });
        await mode.finalPr(gate, log, finalPr, live);
      },
    };
    const owner = new OwnerPolicyExecutor(port, { tag });
    const stageGates: {
      gateId: string;
      stageKind: string;
      live: number | undefined;
    }[] = [];
    const seenStage = new Set<string>();
    let orcaRun: string | undefined;
    let shimsBefore: string[] | undefined;
    let controlTokenBefore: string | undefined;
    const evidence: Partial<RestartEvidence> = {};
    let lastSeq = -1;
    let deadline = Date.now() + 25 * 60_000;
    const ownerWaitMs =
      Number(process.env.AIO_JOINT_OWNER_WAIT_MIN ?? '720') * 60_000;

    for (;;) {
      if (mode.sampleLocks) {
        locks.github.push(await holdsLock(GITHUB_LOCK));
        locks.orca.push(await holdsLock(ORCA_LOCK));
      }
      orcaRun ??= await side.adoptRun(live, id);
      log = await events(live, id);
      for (const e of log) feed(e); // Polling fallback when SSE missed a frame.
      await mode.importObjects(log, id, shortId);

      if (fired && !control.hasKilled) {
        // §2.3: the one kill. Inventory first (counts only), then restart.
        if (mode.beforeKill) {
          report.killHeldMs = await mode.beforeKill(live, id);
          for (const e of await events(live, id)) feed(e);
        }
        const groups = await side.checkGroups();
        shimsBefore = await side.shims();
        controlTokenBefore = await readControlToken(mode.home);
        const caffeinatedBefore = mode.preventSleepChild
          ? await caffeinateFor(backend.pid)
          : undefined;
        evidence.killSeq = maxSeq;
        const record = await control.killAndRestart(fired.trigger, fired.seq);
        backend = control.backend;
        await mode.afterRestart?.(live);
        owner.restartReady(record.readyAt);
        if (groups)
          evidence.orphans = {
            before: groups.length,
            aliveAfterRestart: (await alive(groups)).length,
          };
        evidence.session = {
          oldCookieStatus: (await live.call('GET', `/api/v1/workflows/${id}`))
            .status,
        };
        const open = await openSessionStatus(mode.home, backend.url, id);
        if (open !== undefined) evidence.session.openSessionStatus = open;
        // #14: the restarted backend re-arms its prevent-sleep child once its
        // run is observed again (a few seconds after readiness).
        evidence.files = mode.preventSleepChild
          ? {
              caffeinateForNewPid: await waitFor(
                () => caffeinateFor(backend.pid),
                60_000,
              ),
            }
          : {};
        if (caffeinatedBefore !== undefined)
          report.caffeinatedBeforeKill = caffeinatedBefore;
        const tokenAfter = await readControlToken(mode.home);
        if (controlTokenBefore && tokenAfter) {
          evidence.files.controlTokenRotated =
            tokenAfter !== controlTokenBefore;
          const old = await oldControlTokenStatus(
            backend.url,
            controlTokenBefore,
          );
          if (old !== undefined) evidence.files.oldControlTokenStatus = old;
        }
        report.restart = record;
        await save();
        continue;
      }

      const workflow = (await live.call('GET', `/api/v1/workflows/${id}`)).body
        ?.readModel as Json;
      if (TERMINAL.includes(workflow?.status)) break;
      if (mode.kind === 'preview' && owner.record.finalGate) {
        // Preview stops at the stand-in's merge once the gate closes.
        if (
          log.some(
            (e) =>
              e.type === 'gate.closed' &&
              e.payload.gateId === owner.record.finalGate,
          )
        )
          break;
      }
      if (workflow?.lastSeq !== lastSeq) {
        lastSeq = workflow?.lastSeq;
        deadline =
          Date.now() + (owner.record.finalGate ? ownerWaitMs : 25 * 60_000);
      }
      if (Date.now() > deadline)
        throw new Error(`Joint drive stalled at ${String(workflow?.status)}`);

      for (const gate of await gates(live, id)) {
        if (gate.status !== 'open' || gate.kind !== 'stage') continue;
        const key = `${gate.gateId}@${gate.version}`;
        if (seenStage.has(key)) continue;
        seenStage.add(key);
        stageGates.push({
          gateId: gate.gateId,
          stageKind: gate.stageKind,
          live: await side.liveAgents(orcaRun),
        });
      }
      await owner.step();
      await delay(mode.pollMs);
    }

    // Let in-flight commands settle before the export (T11b live finding:
    // the post-completion auto-cleanup was still running), bounded.
    const settleDeadline = Date.now() + 120_000;
    for (;;) {
      log = await events(live, id);
      const ended = new Set(
        log
          .filter(
            (e) =>
              e.type === 'command.succeeded' || e.type === 'command.failed',
          )
          .map((e) => e.payload.commandId),
      );
      const pending = log.filter(
        (e) => e.type === 'command.issued' && !ended.has(e.payload.commandId),
      ).length;
      report.pendingAtExport = pending;
      if (pending === 0 || Date.now() > settleDeadline) break;
      await delay(1_000);
    }
    const shimsAfter = await side.shims();
    const inbox = orcaRun ? await side.inbox(orcaRun) : undefined;
    const worktrees = await side.worktrees();
    const runs = side.runs();
    // Our dispatches: the agent refs our spawn commands returned.
    const dispatches = log
      .filter(
        (e) =>
          e.type === 'command.succeeded' &&
          e.payload.kind === 'runtime.spawnAgent',
      )
      .map((e) => String(e.payload.result?.agent));
    const held = owner.record.escalation;
    const heldAttempt = held
      ? (log.find(
          (e) =>
            e.type === 'message.escalated' && e.payload.gateId === held.gateId,
        )?.payload.attemptId as string | undefined)
      : undefined;
    const full: RestartEvidence = {
      events: log,
      ...(control.record ? { restart: control.record } : {}),
      ...evidence,
      scm: await mode.scmFacts(log),
      orca: {
        ...(inbox ? { inbox } : {}),
        ...(control.record && shimsBefore && shimsAfter
          ? { shimHandles: { before: shimsBefore, after: shimsAfter } }
          : {}),
        ...(runs === undefined ? {} : { runs }),
        ...(worktrees ? { worktreeNames: worktrees } : {}),
        dispatches,
      },
      sse: { seqs: stream.seqs, reconnects: stream.reconnects },
      locks,
    };
    const assertions = restartAssertions(full, {
      ...(heldAttempt ? { heldQuestionAttempt: heldAttempt } : {}),
    });
    const codeName = await mode
      .integrationFile(log, `m5/${tag}/NAME.md`)
      .catch(() => undefined);
    Object.assign(report, {
      status: (await live.call('GET', `/api/v1/workflows/${id}`)).body
        ?.readModel?.status,
      minutesTotal: Math.round((Date.now() - startedAt) / 60_000),
      killed: control.hasKilled,
      trigger: control.record?.trigger ?? null,
      owner: owner.record,
      // A boolean only: the held answer reached the worker (§2.2.4).
      codeNameIsAnswer:
        codeName === undefined ? null : codeName.trim() === CODE_NAME,
      // The escalated question was answered by the owner (the held answer).
      escalationAnsweredByOwner: log.some(
        (e) => e.type === 'message.answered' && e.payload.by === 'user',
      ),
      stageGates,
      sampler: sampler.stop(),
      assertions: assertions.map((a) => ({
        id: a.id,
        status: a.status,
        detail: a.detail,
      })),
    });
    // B4 export before the home goes away; raw stays private.
    const commit = (
      await exec('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dirname })
    ).stdout.trim();
    const orcaVersion =
      (
        (await live.call('GET', '/api/v1/health')).body?.runtime?.version as
          string | undefined
      )?.match(/\d+\.\d+\.\d+/)?.[0] ?? '0.0.0';
    const exported = await writeJointExports(log, {
      privateDir: paths.privateDir,
      name: `m5-joint-${mode.kind}-${tag}`,
      exportedAt: new Date().toISOString(),
      aiOfficeCommit: commit,
      orcaVersion,
      requirements: [requirement(tag)],
    });
    report.export = { events: exported.events };
    // T10 §24 checker on the masked export (what gets committed), with this
    // mode's facts; rows the mode cannot judge are n/a with their reason.
    const masked = JSON.parse(
      await readFile(exported.maskedPaths[0]!, 'utf8'),
    ) as { events: Json[] };
    const facts: CheckerFacts = {
      ...(await mode.checkerFacts?.(log)),
      ...(full.scm?.integrationFirstParents
        ? { integrationFirstParent: full.scm.integrationFirstParents }
        : {}),
      ...(full.scm?.markerCounts
        ? {
            markerScan: {
              maxObjectsPerCommand: Math.max(
                0,
                ...Object.values(full.scm.markerCounts),
              ),
            },
          }
        : {}),
      ...(stageGates.length && stageGates.every((g) => g.live !== undefined)
        ? {
            workerListAtStageGates: stageGates.map((g) => ({
              gateId: g.gateId,
              liveAgents: g.live!,
            })),
          }
        : {}),
      ...(typeof owner.record.approveCommentNoEffect === 'boolean'
        ? {
            approveCommentNoStateChange: owner.record.approveCommentNoEffect,
          }
        : {}),
    };
    // Facts are ids, SHAs, counts and booleans only (T10 parseFacts shape).
    await writeFile(
      join(paths.privateDir, `m5-joint-${mode.kind}-${tag}.facts.json`),
      JSON.stringify(facts, null, 2),
      { mode: 0o600 },
    );
    report.acceptance = judge
      ? judgeAcceptance(judge(masked.events, facts), mode.checkerNa)
      : 'not run in-process: pnpm acceptance:check <masked export> --github-facts <facts.json>';
    // The owner's cleanup of retained workspaces and branches (M2-T17 D9).
    const cleaned = await live.call(
      'POST',
      `/api/v1/workflows/${encodeURIComponent(id)}/cleanup`,
    );
    report.cleanupStatus = cleaned.status;
    // Commands the cleanup issued and how they ended (kinds and codes only).
    const cleanupFrom = Number(log.at(-1)?.seq ?? 0);
    const cleanupDeadline = Date.now() + 30_000;
    for (;;) {
      const after = (await events(live, id)).filter(
        (e) => Number(e.seq) > cleanupFrom,
      );
      const issued = after.filter((e) => e.type === 'command.issued');
      const ended = new Map(
        after
          .filter(
            (e) =>
              e.type === 'command.succeeded' || e.type === 'command.failed',
          )
          .map((e) => [e.payload.commandId as string, e]),
      );
      const settled = issued.every((e) => ended.has(e.payload.commandId));
      if (settled || Date.now() > cleanupDeadline) {
        report.cleanup = issued.map((e) => ({
          kind: e.payload.kind,
          outcome: ended.get(e.payload.commandId)?.type ?? 'pending',
          ...(ended.get(e.payload.commandId)?.payload.error?.code
            ? { code: ended.get(e.payload.commandId)!.payload.error.code }
            : {}),
        }));
        break;
      }
      await delay(500);
    }
    if (mode.janitor) report.janitor = await mode.janitor(log);
    report.failed = assertions
      .filter((a) => a.status === 'fail')
      .map((a) => a.id);
    await save();
    return report;
  } finally {
    await stream?.stop();
    sampler?.stop();
    if (api && workflowId)
      await mode
        .importObjects(
          await events(api, workflowId).catch(() => []),
          workflowId,
          String(report.shortId ?? ''),
          true,
        )
        .catch(() => undefined);
    report.backendStop = await control.stop().then(
      () => 'ok',
      () => 'failed',
    );
    await mode.dispose().catch(() => undefined);
    await save().catch(() => undefined);
  }
}
