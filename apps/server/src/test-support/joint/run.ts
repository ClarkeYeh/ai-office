/**
 * M5-T7 joint-run harness (M5_PLAN §2.1–§2.3): one control flow, two modes.
 * - `production` (T12): real `ai-office start` on an isolated home, real
 *   GitHub (spike, GitHub live lock + safety gate via `withHarness`), real Orca
 *   and agents; the final PR waits for the owner's hand merge (W2).
 * - `preview` (T11b): `--dev --runtime orca` child + scm-gitremote stand-in
 *   in this process (bridged over IPC); the final PR is merged explicitly by
 *   the stand-in; no GitHub API, no owner.
 * Both: T8's `m5-mainline` text, the scripted owner policy, exactly one
 * `kill -9` (K or K′) with a same-home same-port restart, the 30 s health
 * sampler, restart assertions #1–10 and #12–17, the B4 export (raw only to a
 * private directory) and a private report of counts, booleans and durations.
 * OFFLINE in T7: this module is exercised live only by T11b and T12.
 */
import { writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireLiveLock } from '../github/lock.js';
import type { OrcaHarness } from '../orca/harness.js';
import {
  adoptRun,
  backendHome,
  events,
  gates,
  liveWorkers,
  registerRepo,
  startWorkflow,
  type Api,
  type Json,
} from '../orca/t17/office.js';
import { alive, checkProcesses } from '../orca/t17/backend-process.js';
import { GitRemoteScm } from '../orca/scm-gitremote/index.js';
import type { PrRef } from '../../ports/refs.js';
import type { ScmPort } from '../../ports/scm.js';
import {
  CODE_NAME,
  mainlineTag,
  mainlineTemplates,
  requirement,
  TEMPLATE_ID,
} from './scenario/index.js';
import { restartAssertions, type RestartEvidence } from './assertions.js';
import {
  freePort,
  keepPreventSleep,
  pinPort,
  previewLauncher,
  productionHome,
  productionLauncher,
} from './backends.js';
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
  runtimeCursorLastSeq,
} from './observe.js';
import { OwnerPolicyExecutor, type OwnerPort } from './owner-policy.js';
import { RestartControl, RestartTrigger, type TriggerName } from './restart.js';
import { HealthSampler } from './sampler.js';
import { bootstrapCookie, cookieSession, HarnessStream } from './session.js';

const exec = promisify(execFile);

export type JointMode = 'production' | 'preview';

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
async function holdLock(path: string): Promise<() => Promise<void>> {
  if (await holdsLock(path)) return async () => undefined;
  return acquireLiveLock(path);
}

const TERMINAL = ['completed', 'failed', 'cancelled'];

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

interface Mode {
  kind: JointMode;
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
  finalPr(gate: Json, log: Json[]): Promise<void>;
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
  const releaseOrca = await holdLock(ORCA_LOCK);
  try {
    if (mode === 'preview') {
      const releaseGithub = await holdLock(GITHUB_LOCK);
      try {
        return await drill(h, await previewMode(h), paths);
      } finally {
        await releaseGithub();
      }
    }
    const { withHarness } = await import('../github/harness.js');
    return await withHarness(async (github) =>
      drill(h, await productionMode(h, github), paths),
    );
  } finally {
    await releaseOrca();
  }
}

async function previewMode(h: OrcaHarness): Promise<Mode> {
  const home = process.env.HOME;
  if (!home) throw new Error('HOME required');
  const dir = await backendHome(h, {
    enforcement: 'off',
    templates: await mainlineTemplates(),
  });
  const port = await freePort();
  await keepPreventSleep(dir);
  await pinPort(dir, port);
  const inner = await GitRemoteScm.create({
    remote: h.ledger.repoPath,
    harness: h,
  });
  let claimed!: () => void;
  const bound = new Promise<void>((r) => (claimed = r));
  let finalRef: PrRef | undefined;
  // Writes wait for the namespace claim; the final PR (base main) is noted.
  const scm = new Proxy(inner, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      const fn = (value as (...a: unknown[]) => unknown).bind(target);
      if (property === 'health' || String(property).startsWith('get'))
        return fn;
      return async (...args: unknown[]) => {
        if (
          ![
            'poll',
            'inspectRepo',
            'compareBranch',
            'findByMarker',
            'listReviewComments',
          ].includes(String(property))
        )
          await bound;
        const result = await fn(...args);
        if (
          property === 'openPR' &&
          (args[1] as { base?: string }).base === 'main'
        )
          finalRef = result as PrRef;
        return result;
      };
    },
  }) as unknown as ScmPort;
  const effects = await h.composedBackend(dir);
  return {
    kind: 'preview',
    home: dir,
    launcher: previewLauncher({
      home: dir,
      port,
      orcaHome: join(home, '.ai-office', 'orca-home'),
      scm,
      effects,
    }),
    afterFirstStart: () => effects.settle(),
    importObjects: async () => undefined,
    async integrationFile(log, path) {
      const integration = log.find((e) => e.type === 'workflow.started')
        ?.payload.integrationBranch as string | undefined;
      if (!integration) return undefined;
      return exec('git', [
        '-C',
        h.ledger.repoPath,
        'show',
        `origin/${integration}:${path}`,
      ]).then(
        (r) => r.stdout,
        () => undefined,
      );
    },
    onShortId: async () => claimed(),
    async finalPr() {
      if (!finalRef) throw new Error('Stand-in final PR not opened');
      // T11b: the stand-in's explicit merge replaces the owner (§2.2.4).
      inner.simulateOwnerMerge(finalRef);
    },
    async scmFacts(log) {
      const integration = log.find((e) => e.type === 'workflow.started')
        ?.payload.integrationBranch as string | undefined;
      const base = log.find(
        (e) =>
          e.type === 'command.succeeded' &&
          e.payload.kind === 'runtime.prepareWorkspace',
      )?.payload.result?.baseSha as string | undefined;
      if (!integration) return {};
      try {
        const { stdout } = await exec(
          'git',
          [
            '-C',
            h.ledger.repoPath,
            'rev-list',
            '--first-parent',
            '--reverse',
            ...(base
              ? [`${base}..origin/${integration}`]
              : [`origin/${integration}`]),
          ],
          { maxBuffer: 4 * 1024 * 1024 },
        );
        return {
          integrationFirstParents: stdout.split('\n').filter(Boolean),
        };
      } catch {
        return {};
      }
    },
    dispose: () => inner.dispose(),
  };
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
async function drill(
  h: OrcaHarness,
  mode: Mode,
  paths: JointPaths,
): Promise<Json> {
  const tag = mainlineTag(new Date());
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
    const repoId = await registerRepo(live, h.ledger.repoPath);
    let shortId = '';
    const started = await startWorkflow(
      h,
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
        const finalPr = log.find(
          (e) =>
            e.type === 'command.succeeded' &&
            e.payload.kind === 'scm.openPR' &&
            log.some(
              (i) =>
                i.type === 'command.issued' &&
                i.payload.commandId === e.payload.commandId &&
                i.payload.args?.base === 'main',
            ),
        )?.payload.result?.pr as number | undefined;
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
        await mode.finalPr(gate, log);
      },
    };
    const owner = new OwnerPolicyExecutor(port, { tag });
    const stageGates: { stageKind: string; live: number }[] = [];
    const seenStage = new Set<string>();
    let orcaRun: string | undefined;
    let shimsBefore: string[] = [];
    let controlTokenBefore: string | undefined;
    const evidence: Partial<RestartEvidence> = {};
    let lastSeq = -1;
    let deadline = Date.now() + 25 * 60_000;
    const ownerWaitMs =
      Number(process.env.AIO_JOINT_OWNER_WAIT_MIN ?? '720') * 60_000;

    for (;;) {
      locks.github.push(await holdsLock(GITHUB_LOCK));
      locks.orca.push(await holdsLock(ORCA_LOCK));
      orcaRun ??= await adoptRun(h, live, id);
      log = await events(live, id);
      for (const e of log) feed(e); // Polling fallback when SSE missed a frame.
      await mode.importObjects(log, id, shortId);

      if (fired && !control.hasKilled) {
        // §2.3: the one kill. Inventory first (counts only), then restart.
        const shim = h.ledger.shims.find((s) => !s.done)?.id;
        const groups = shim ? await checkProcesses(shim) : [];
        shimsBefore = (await h.scan())
          .filter((r) => r.kind === 'shim')
          .map((r) => r.id);
        controlTokenBefore = await readControlToken(mode.home);
        const caffeinatedBefore = await caffeinateFor(backend.pid);
        evidence.killSeq = maxSeq;
        const record = await control.killAndRestart(fired.trigger, fired.seq);
        backend = control.backend;
        owner.restartReady(record.readyAt);
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
        evidence.files = {
          caffeinateForNewPid: await waitFor(
            () => caffeinateFor(backend.pid),
            60_000,
          ),
        };
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
        report.restart = { ...record, readyAt: undefined };
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
          stageKind: gate.stageKind,
          live: orcaRun ? (await liveWorkers(h, orcaRun)).length : 0,
        });
      }
      await owner.step();
      await delay(2_000);
    }

    log = await events(live, id);
    const shimsAfter = (await h.scan())
      .filter((r) => r.kind === 'shim')
      .map((r) => r.id);
    const inbox = orcaRun ? await runInbox(h, orcaRun) : undefined;
    const cursor = runtimeCursorLastSeq(mode.home);
    const worktrees = (await h.scan())
      .filter((r) => r.kind === 'worktree')
      .map((r) => r.name);
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
        ...(cursor === undefined ? {} : { runtimeCursorLastSeq: cursor }),
        ...(control.record
          ? { shimHandles: { before: shimsBefore, after: shimsAfter } }
          : {}),
        runs: h.ledger.runs.length,
        worktreeNames: worktrees,
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
      codeNameIsAnswer: codeName?.trim() === CODE_NAME,
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
    // The owner's cleanup of retained workspaces and branches (M2-T17 D9).
    const cleaned = await live.call(
      'POST',
      `/api/v1/workflows/${encodeURIComponent(id)}/cleanup`,
    );
    report.cleanupStatus = cleaned.status;
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
