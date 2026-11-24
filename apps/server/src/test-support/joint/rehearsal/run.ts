/**
 * M5-T11 rehearsal (M5_PLAN §2.4): T9's fake-world `m5-mainline` in a killable
 * `--dev --fake` child (`backend-child.ts`) against an SCM that lives in this
 * process (real scm-github on the spike's test namespace live, scm-fake in the
 * CI twin), engine-driven, zero tokens. Two exact kill windows, each followed by
 * `kill -9` of the child and a same-home same-port restart (the fake world
 * survives through its checkpoint):
 * - P1: the first `createIssue` succeeded externally, before `command.succeeded`;
 * - P2: the first `mul`/`sub` `mergePR` succeeded (`POST /merges`), before
 *   `command.succeeded`.
 * Each window is judged on its own (`windows.ts`): exactly one terminal event
 * via reconcile, exactly one Issue / merge, ready incl. reconcile ≤ 60 s. The
 * run stops when the final-PR gate opens: the final PR targets the spike's
 * `main` and is never merged (G-D). The binding owns the adapter, the GitHub
 * gate, lock, ledger and cleanup; this module never sees a token.
 */
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ScmPort } from '../../../ports/scm.js';
import { githubBranches } from '../../github/branch-namespace.js';
import { createGithubWorldBridge } from '../../github/fake-world-bridge.js';
import type { GitPusher } from '../../github/pusher.js';
import { scopeGithubScm } from '../../github/scoped-scm.js';
import { events, type Api, type Json } from '../../orca/t17/office.js';
import { startBackendProcess } from '../../orca/t17/backend-process.js';
import { assertIsolated, freePort, writeTemplates } from '../backends.js';
import { OwnerPolicyExecutor, type OwnerPort } from '../owner-policy.js';
import {
  RestartControl,
  type ControlledBackend,
  type TriggerName,
} from '../restart.js';
import {
  mainlineTag,
  mainlineTemplates,
  requirement,
  RESTART_TRIGGERS,
  TEMPLATE_ID,
} from '../scenario/index.js';
import { serveScm } from '../scm-bridge.js';
import { bootstrapCookie, cookieSession } from '../session.js';
import { PauseGate, type PauseHit } from './pause.js';
import { REHEARSAL_REPO, frozenMarker, type WorldPush } from './protocol.js';
import {
  readyWithReconcileMs,
  segmentSemantics,
  windowAssertions,
  windowCommand,
  type SegmentSemantics,
  type WindowEvidence,
  type WindowRow,
} from './windows.js';

/** Built child entry: the minimal environment cannot run TypeScript sources. */
export const REHEARSAL_CHILD_ENTRY = join(
  import.meta.dirname,
  '../../../../dist/test-support/joint/rehearsal/backend-child.js',
);

/** Everything that differs between the live spike run and its CI twin. */
export interface RehearsalBinding {
  mode: 'live' | 'fake';
  /** The unscoped adapter: scm-github over the guarded transport, or scm-fake. */
  scm: ScmPort;
  runId: string;
  pusher: Pick<GitPusher, 'push'>;
  /** Issues (any state) whose body carries `<!-- ai-office:cmd=<id> -->`. */
  issuesWithMarker(scopedCommandId: string): Promise<number>;
  /** Commits on `branch` (remote name) whose second parent is `head`. */
  mergesOf(branch: string, head: string): Promise<number>;
  /** Most objects sharing one marker in this run's namespace. */
  maxObjectsPerMarker(): Promise<number>;
  /** First parents of `branch` from `first` (inclusive) to its head, oldest first. */
  firstParents(branch: string, first: string): Promise<string[]>;
  /** Called once, right before the first kill: segment 1 is complete. */
  endSegment1?(): void;
  /** Drive-loop interval. */
  pollMs: number;
  /** No new event for this long fails the run. */
  stallMs: number;
}

/** The T10 checker, injected by the acceptance (joint may not import it). */
export type RehearsalJudge = (
  events: Json[],
  facts: Record<string, unknown>,
) => { rows: { id: string; verdict: 'pass' | 'fail' | 'na' }[] };

/** Checker rows the rehearsal cannot judge, with the reason (never hides a pass). */
export const REHEARSAL_NA: Record<string, string> = {
  'nf.cpu': 'no Orca in the rehearsal; the T7 sampler measures it in T11b/T12',
  'nf.fps': 'UI scale: M4 load-10 and T17 e2e:fps',
  'nf.auth': 'request rejection is covered by CI API tests',
  'nf.boundaries': 'covered by the CI DoD',
  'nf.coverage': 'covered by the CI DoD',
  'nf.approve-comment': 'the owner /approve comment is exercised in T12',
  'v01.worker-list':
    'no Orca worker-list; nf.stage-gate-agents judges the same invariant from events',
  'v01.conflict':
    'the fake runtime pushes one new file per commit (GitPusher), so mul/sub never conflict textually; T9 judges the conflict paths',
  'v01.usage': 'the fake runtime reports no token usage in a child backend',
  'x.engine-replay': 'optional; not implemented by T10',
};

export interface RehearsalWindowReport {
  window: PauseHit['window'];
  killSeq: number;
  restart: Omit<WindowEvidence['restart'], 'readyAt'>;
  reconcileMs: number | null;
  readyWithReconcileMs: number | null;
  objects: number | null;
  rows: WindowRow[];
}

export interface RehearsalReport {
  mode: RehearsalBinding['mode'];
  runId: string;
  tag: string;
  status: string | undefined;
  finalGateOpened: boolean;
  finalPr: number | null;
  windows: RehearsalWindowReport[];
  segment1: SegmentSemantics | null;
  owner: OwnerPolicyExecutor['record'];
  /** SCM port calls the backend made, by method. */
  scmCalls: Record<string, number>;
  checker?: {
    rows: { id: string; verdict: string; reason?: string; checker?: string }[];
    summary: Record<string, number>;
  };
  failed: string[];
  minutesTotal: number;
}

const terminalOf = (log: Json[], commandId: string | undefined) =>
  log.find(
    (e) =>
      (e.type === 'command.succeeded' || e.type === 'command.failed') &&
      e.payload.commandId === commandId,
  );

/** Event types, kinds and outcomes only (no bodies) for a stall report. */
const trace = (log: Json[]) =>
  log
    .slice(-60)
    .map((e) =>
      [
        e.seq,
        e.type,
        e.payload?.kind,
        e.payload?.itemKey,
        e.payload?.outcome,
        e.payload?.error?.code,
        e.payload?.reason,
      ]
        .filter((v) => v !== undefined)
        .join(' '),
    )
    .join('\n');

/** Counts calls per method on the served SCM. */
function counted<T extends object>(target: T, calls: Record<string, number>) {
  return new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property, object) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls[String(property)] = (calls[String(property)] ?? 0) + 1;
        return (value as (...a: unknown[]) => unknown).apply(object, args);
      };
    },
  });
}

export async function runRehearsal(
  binding: RehearsalBinding,
  options: { home: string; judge?: RehearsalJudge },
): Promise<RehearsalReport> {
  const { home } = options;
  const port = await freePort();
  assertIsolated(home, port);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(
    join(home, 'config.toml'),
    '[budget]\nenforcement = "off"\n',
    { mode: 0o600, flag: 'wx' },
  );
  await writeTemplates(home, await mainlineTemplates());

  const startedAt = Date.now();
  const tag = mainlineTag(new Date());
  const { runId } = binding;
  // The workflow shortId is the run ID: every name lands in `ai-office/t<runId>`.
  const shortId = runId;
  const branches = githubBranches(runId, shortId);
  const scoped = scopeGithubScm(binding.scm, runId, shortId);
  const bridge = createGithubWorldBridge({
    scm: scoped,
    repo: REHEARSAL_REPO.github,
    runId,
    shortId,
    pusher: binding.pusher,
  });
  const scmCalls: Record<string, number> = {};
  let api: Api | undefined;
  let workflowId: string | undefined;
  const prItem = new Map<number, string>();
  const learn = (log: Json[]) => {
    for (const e of log)
      if (e.type === 'workitem.merge_queued')
        prItem.set(Number(e.payload.pr), String(e.payload.itemKey));
  };
  const gate = new PauseGate({
    async isWindowPr(pr) {
      if (!prItem.has(pr) && api && workflowId)
        learn(await events(api, workflowId).catch(() => []));
      return (RESTART_TRIGGERS.primary.itemKeys as readonly string[]).includes(
        prItem.get(pr) ?? '',
      );
    },
  });
  const served = gate.wrap(
    counted(
      new Proxy(scoped, {
        get(target, property) {
          if (property === 'worldPush')
            return (request: Parameters<WorldPush['worldPush']>[0]) =>
              bridge.onPush(request);
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as ScmPort & WorldPush,
      scmCalls,
    ),
  );
  const serve = serveScm(served);
  let child: ChildProcess | undefined;
  let starts = 0;
  const launch = async (): Promise<ControlledBackend> => {
    starts++;
    const backend = await startBackendProcess({
      home,
      // Unused by the rehearsal child (no Orca); the launcher requires one.
      orcaHome: home,
      logName: `backend-${starts}.log`,
      entry: REHEARSAL_CHILD_ENTRY,
      env: {
        AIO_JOINT_PORT: String(port),
        AIO_REHEARSAL_SHORT_ID: shortId,
      },
      onMessage: (message, from) => {
        // Pause hits come from the child that made the call: the live one.
        child = from;
        serve(message, from);
      },
      serialization: 'advanced',
    });
    return {
      pid: backend.pid,
      url: backend.url,
      bootstrapUrl: backend.bootstrapUrl,
      exited: backend.exited,
      stop: () => backend.stop(),
    };
  };
  // T7's control allows exactly one kill; each window gets its own control,
  // whose first start adopts the running backend.
  const controlFor = (running?: ControlledBackend) => {
    let adopted = running;
    return new RestartControl({
      home,
      start: async () => {
        const next = adopted ?? (await launch());
        adopted = undefined;
        return next;
      },
    });
  };
  let control = controlFor();
  const report: RehearsalReport = {
    mode: binding.mode,
    runId,
    tag,
    status: undefined,
    finalGateOpened: false,
    finalPr: null,
    windows: [],
    segment1: null,
    owner: undefined as never,
    scmCalls,
    failed: [],
    minutesTotal: 0,
  };
  const evidence: WindowEvidence[] = [];
  try {
    await control.start();
    const cookie = await bootstrapCookie(control.backend.bootstrapUrl);
    const live = cookieSession(control.backend.url, cookie);
    api = live;
    const repoId = (await live.call('GET', '/api/v1/repos')).body?.repos?.[0]
      ?.repoId as string | undefined;
    if (!repoId) throw new Error('Rehearsal repo not registered');
    const started = await live.call('POST', '/api/v1/workflows', {
      templateId: TEMPLATE_ID,
      repoId,
      requirement: requirement(tag),
    });
    if (started.status !== 201)
      throw new Error(`Workflow start failed ${started.status}`);
    const id = String(started.body.workflowId);
    workflowId = id;

    let log: Json[] = [];
    const port_: OwnerPort = {
      openGates: async () =>
        (((await live.call('GET', '/api/v1/gates')).body?.gates ??
          []) as Json[]).filter(
          (g) => g.workflowId === id && g.status === 'open',
        ),
      gateDetail: async (gateId) =>
        (await live.call('GET', `/api/v1/gates/${encodeURIComponent(gateId)}`))
          .body,
      async decide(g, body) {
        const detail = (
          await live.call('GET', `/api/v1/gates/${encodeURIComponent(g.gateId)}`)
        ).body;
        return live.call(
          'POST',
          `/api/v1/gates/${encodeURIComponent(g.gateId)}/decision`,
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
      // Hand-offs are recorded in the owner record and fail the run below.
      handOff: async () => undefined,
      async finalPr() {
        // The final PR targets the spike's main: never merged (G-D).
        report.finalGateOpened = true;
        report.finalPr =
          (log.find(
            (e) =>
              e.type === 'command.succeeded' &&
              e.payload.kind === 'scm.openPR' &&
              log.some(
                (i) =>
                  i.type === 'command.issued' &&
                  i.payload.commandId === e.payload.commandId &&
                  i.payload.args?.base === 'main',
              ),
          )?.payload.result?.pr as number | undefined) ?? null;
      },
    };
    const owner = new OwnerPolicyExecutor(port_, { tag });
    report.owner = owner.record;

    const kill = async (hit: PauseHit) => {
      if (hit.window === 'P1') binding.endSegment1?.();
      log = await events(live, id);
      learn(log);
      const killSeq = Math.max(0, ...log.map((e) => Number(e.seq) || 0));
      if (hit.window === 'P1') report.segment1 = segmentSemantics(log, killSeq);
      const commandId = windowCommand(log, hit, killSeq);
      const frozen = frozenMarker(home, hit.window);
      if (!child) throw new Error('No child to freeze');
      child.send({ type: 'freeze', window: hit.window });
      for (let i = 0; !existsSync(frozen); i++) {
        if (i > 500) throw new Error('Rehearsal child never froze');
        await delay(20);
      }
      // Window names are recorded as the trigger (T7 knows only K / K′).
      const record = await control.killAndRestart(
        hit.window as unknown as TriggerName,
        killSeq,
      );
      control = controlFor(control.backend);
      await control.start();
      const restartIssuedAt = record.readyAt - record.readyMs;
      let reconcileMs: number | undefined;
      for (const deadline = Date.now() + 180_000; Date.now() < deadline; ) {
        const after = await events(live, id).catch(() => [] as Json[]);
        if (terminalOf(after, commandId)) {
          reconcileMs = Date.now() - restartIssuedAt;
          break;
        }
        await delay(250);
      }
      if (hit.window === 'P2') owner.restartReady(record.readyAt);
      evidence.push({
        window: hit.window,
        hit,
        killSeq,
        restart: record,
        reconcileMs,
        objects: undefined,
      });
    };

    let lastSeq = -1;
    let deadline = Date.now() + binding.stallMs;
    for (;;) {
      if (gate.hits.length > evidence.length) {
        await kill(gate.hits[evidence.length]!);
        deadline = Date.now() + binding.stallMs;
        continue;
      }
      log = await events(live, id);
      learn(log);
      const workflow = (await live.call('GET', `/api/v1/workflows/${id}`)).body
        ?.readModel as Json | undefined;
      report.status = workflow?.status as string | undefined;
      if (['completed', 'failed', 'cancelled'].includes(String(report.status)))
        break;
      if (report.finalGateOpened) break;
      if (workflow?.lastSeq !== lastSeq) {
        lastSeq = workflow?.lastSeq as number;
        deadline = Date.now() + binding.stallMs;
      }
      if (Date.now() > deadline)
        throw new Error(
          `Rehearsal stalled at ${String(report.status)}\n${trace(log)}`,
        );
      await owner.step();
      await delay(binding.pollMs);
    }

    log = await events(live, id);
    const integration = log.find((e) => e.type === 'workflow.started')
      ?.payload.integrationBranch as string | undefined;
    for (const w of evidence) {
      const commandId = windowCommand(log, w.hit, w.killSeq);
      w.objects =
        w.window === 'P1'
          ? commandId === undefined
            ? undefined
            : await binding.issuesWithMarker(`t${runId}:${commandId}`)
          : integration && w.hit.headSha
            ? await binding.mergesOf(branches.remote(integration), w.hit.headSha)
            : undefined;
      const rows = windowAssertions(log, w);
      const { readyAt: _readyAt, ...restart } = w.restart;
      report.windows.push({
        window: w.window,
        killSeq: w.killSeq,
        restart,
        reconcileMs: w.reconcileMs ?? null,
        readyWithReconcileMs: readyWithReconcileMs(w) ?? null,
        objects: w.objects ?? null,
        rows,
      });
    }
    for (const window of ['P1', 'P2'] as const)
      if (!evidence.some((w) => w.window === window))
        report.failed.push(`${window}.fired`);
    report.failed.push(
      ...report.windows.flatMap((w) =>
        w.rows.filter((r) => r.status === 'fail').map((r) => r.id),
      ),
    );
    if (!report.finalGateOpened) report.failed.push('final-gate');
    if (owner.record.handOffs.length) report.failed.push('owner.hand-off');

    if (options.judge) {
      const first = log.find((e) => e.type === 'workitem.merged')?.payload
        .mergeCommitSha as string | undefined;
      const facts: Record<string, unknown> = {
        markerScan: {
          maxObjectsPerCommand: await binding.maxObjectsPerMarker(),
        },
        ...(integration && first
          ? {
              integrationFirstParent: await binding.firstParents(
                branches.remote(integration),
                first,
              ),
            }
          : {}),
      };
      const rows = options.judge(log, facts).rows.map((r) => {
        const reason = REHEARSAL_NA[r.id];
        return reason === undefined || r.verdict === 'pass'
          ? { id: r.id, verdict: r.verdict }
          : { id: r.id, verdict: 'na' as const, reason, checker: r.verdict };
      });
      const summary: Record<string, number> = { pass: 0, fail: 0, na: 0 };
      for (const r of rows) summary[r.verdict] = (summary[r.verdict] ?? 0) + 1;
      report.checker = { rows, summary };
      report.failed.push(
        ...rows.filter((r) => r.verdict === 'fail').map((r) => `checker.${r.id}`),
      );
    }
    return report;
  } finally {
    report.minutesTotal = Math.round((Date.now() - startedAt) / 60_000);
    await control.stop().catch(() => undefined);
    // A child frozen without its kill (a failure in between) ignores SIGTERM.
    if (child && child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  }
}
