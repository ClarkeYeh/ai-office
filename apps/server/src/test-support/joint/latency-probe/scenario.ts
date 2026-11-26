/**
 * FX-STATUS-LATENCY live probe (`runHarnessCli record m5-latency-probe
 * --scenario …`): Orca only, no GitHub object, no merge. An isolated
 * `--dev --runtime orca` backend on the approved Orca home composes the
 * production runtime (observer, wake, CLI scheduler); the probe drives it
 * directly: one scratch worktree (local branch `ai-office/<id>/probe`, never
 * pushed; creating it fetches the spike's `main` read-only), one Claude and
 * one Codex keep-open agent, a few tiny turns. It observes on the production
 * cadence (`runtimeDelayMs`, wake) and records each event's `recordedAt` in a
 * private event file, then reports the SPEC §24 state and message latency,
 * Orca CLI calls per minute and the peak `orca` process count.
 *
 * LIVE ONLY, after the coordinator's GO: started by
 * `acceptance/joint/latency-probe.orca.test.ts`. Holds the Orca live lock;
 * the runner then cleans the ledger and asserts ledger 0 / scan 0.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { startServer } from '../../../main.js';
import type {
  AgentRef,
  RuntimeCursor,
  SessionRef,
} from '../../../ports/refs.js';
import type { RuntimeEvent } from '../../../ports/runtime-events.js';
import { runtimeDelayMs, type RuntimePort } from '../../../ports/runtime.js';
import type { OrcaHarness } from '../../orca/harness.js';
import { composedShimOptions } from '../../orca/composed-shim-seam.js';
import { backendHome } from '../../orca/t17/office.js';
import { ORCA_LOCK } from '../observe.js';
import { holdLock } from '../run.js';
import { probeVerdict, type RecordedEvent } from './stats.js';

const exec = promisify(execFile);

export const assertClean = true;

/** 2 by default; 4 (2 Claude + 2 Codex) for the T12-scale probe. */
const AGENTS = Number(process.env.AIO_PROBE_AGENTS ?? '2');
if (![2, 4].includes(AGENTS))
  throw new Error('AIO_PROBE_AGENTS must be 2 or 4');
/** Enough turns for ≥ 60 status changes (about 2.5 per agent and turn). */
const TURNS = Number(process.env.AIO_PROBE_TURNS ?? (AGENTS >= 4 ? '8' : '14'));
const TURN_TIMEOUT_MS = 8 * 60_000;
/** One nudge per agent and turn after this long without output or done. */
const NUDGE_AFTER_MS = 3 * 60_000;
const INTERVAL_MS = 2_000;

const PROMPT = (role: string) =>
  [
    `You are the ${role} seat of an AI Office latency probe.`,
    'Do not read, create or change any file and run no commands other than',
    'your Orca orchestration reporting command. For every message you get,',
    'first write (in your reply, not a file) the first eight prime numbers,',
    'then report worker_done with a one-line body ("turn N ok"), then end',
    'your turn and wait for the next message.',
  ].join(' ');

/** Numbers and enums only: no bodies, transcript blocks or paths. */
const record = (e: RuntimeEvent, recordedAt: string) => ({
  type: e.type,
  agent: 'agent' in e ? e.agent : undefined,
  state: e.type === 'agent.status' ? e.state : undefined,
  occurredAt: e.occurredAt,
  recordedAt,
});

/**
 * Live Orca CLI processes (the CPU proxy next to calls/min). The `orca`
 * launcher is a bash script that execs the app's Electron binary as node
 * with the CLI script, so count processes running from the app bundle with a
 * CLI subcommand, never the launcher path or the app's own GUI processes.
 */
export function countOrcaCli(psCommands: string, bin: string): number {
  const app = bin.includes('/Contents/')
    ? bin.slice(0, bin.indexOf('/Contents/') + '/Contents/'.length)
    : bin;
  return psCommands
    .split('\n')
    .filter(
      (l) =>
        l.includes(app) &&
        /\s(orchestration|terminal|worktree|repo|status)(\s|$)/.test(l),
    ).length;
}
/**
 * Done reports each agent had before a turn started. Turn 0 is the spawn
 * itself, whose done may arrive while the other seats are still spawning:
 * it counts from 0, never from what was already reported (4-agent probe:
 * turn 0 waited 190 s for nudges).
 */
export function turnBaseline<A>(
  turn: number,
  agents: readonly A[],
  done: ReadonlyMap<A, number>,
): Map<A, number> {
  return new Map(agents.map((a) => [a, turn === 0 ? 0 : (done.get(a) ?? 0)]));
}
/**
 * The honest bound for a list-derived transition: it was detected within one
 * list interval of the change; the interval follows from worker-list
 * calls per minute (peak, so the shortest observed interval).
 */
export function listBound(list: { calls: number } | undefined) {
  if (!list || list.calls === 0) return null;
  return {
    worstCaseListIntervalMs: Math.round(60_000 / list.calls),
    meaning:
      'a list-derived transition was detected within this long of the change, plus its recorded lag',
  };
}
async function orcaProcesses(bin: string): Promise<number> {
  const { stdout } = await exec('ps', ['-axo', 'command']);
  return countOrcaCli(stdout, bin);
}

export async function run(h: OrcaHarness): Promise<void> {
  const home = process.env.HOME;
  const bin = process.env.AIO_ORCA_BIN;
  const outDir = process.env.AIO_PROBE_DIR;
  if (!home || !bin || !outDir)
    throw new Error('HOME, AIO_ORCA_BIN and AIO_PROBE_DIR required');
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const eventsPath = join(outDir, 'probe.events.jsonl');
  const releaseOrca = await holdLock(ORCA_LOCK);
  try {
    const shortId = randomBytes(6).toString('hex');
    const bind = await h.claimWorkflowNamespace();
    await bind(shortId);
    const dir = await backendHome(h, { enforcement: 'off' });
    const effects = await h.composedBackend(dir);
    let runtime: RuntimePort | undefined;
    const seam = composedShimOptions({
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
      testOnly: { ...seam.testOnly, onRuntime: (r) => (runtime = r) },
    });
    try {
      await effects.settle();
      if (!runtime) throw new Error('Composed Orca runtime not exposed');
      await probe(h, runtime, shortId, bin, eventsPath, outDir);
    } finally {
      await server.close();
    }
  } finally {
    await releaseOrca();
  }
}

async function probe(
  h: OrcaHarness,
  runtime: RuntimePort,
  shortId: string,
  bin: string,
  eventsPath: string,
  outDir: string,
): Promise<void> {
  const workflowId = `probe-${shortId}`;
  const correlation = (step: string) => ({
    workflowId,
    commandId: `${workflowId}/${step}`,
  });
  const inspected = await runtime.inspectLocalRepo(h.ledger.repoPath);
  if (!inspected.runtimeRepoId) throw new Error('Spike clone not in Orca');
  const repo = {
    orcaRepoId: inspected.runtimeRepoId,
    localPath: h.ledger.repoPath,
  } as Parameters<RuntimePort['openSession']>[0]['repo'];
  const session: SessionRef = await runtime.openSession({
    workflowId,
    repo,
    objective: `aio-test latency probe ${shortId}`,
    correlation: correlation('session'),
  });
  await h.adoptBackendRun(session);

  // The observation pump: the production cadence and wake, nothing else.
  const recorded: RecordedEvent[] = [];
  /** Last time each agent produced any event (output, status, done). */
  const heard = new Map<AgentRef, number>();
  const done = new Map<AgentRef, number>();
  let cursor: RuntimeCursor | null = null;
  let stopped = false;
  let woken = false;
  let kick: (() => void) | undefined;
  const unwake = runtime.onWake?.((s) => {
    if (s !== session) return;
    woken = true;
    kick?.();
  });
  const pump = (async () => {
    while (!stopped) {
      const startedAt = Date.now();
      woken = false;
      const result = await runtime.observe(session, cursor);
      const recordedAt = new Date().toISOString();
      for (const e of result.events) {
        const row = record(e, recordedAt);
        recorded.push(row);
        await appendFile(eventsPath, JSON.stringify(row) + '\n', {
          mode: 0o600,
        });
        if (e.type === 'agent.done')
          done.set(e.agent, (done.get(e.agent) ?? 0) + 1);
        if ('agent' in e) heard.set(e.agent, Date.now());
      }
      cursor = result.cursor;
      const wait = runtimeDelayMs({
        woken,
        intervalMs: INTERVAL_MS,
        startedAt,
        now: Date.now(),
      });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        kick = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      kick = undefined;
    }
  })();

  // CPU proxies, sampled while the probe runs.
  const cli: number[] = [];
  const commands = new Map<string, { calls: number; p95Ms: number }>();
  const procs: number[] = [];
  const sampler = setInterval(() => {
    void runtime.health().then(
      (health) => {
        cli.push(health.cliCallsPerMinute ?? 0);
        // Peak calls/min and CLI p95 per Orca subcommand.
        for (const [command, m] of Object.entries(health.cliCommands ?? {})) {
          const seen = commands.get(command);
          commands.set(command, {
            calls: Math.max(seen?.calls ?? 0, m.calls),
            p95Ms: Math.max(seen?.p95Ms ?? 0, m.p95Ms),
          });
        }
      },
      () => undefined,
    );
    void orcaProcesses(bin).then(
      (n) => procs.push(n),
      () => undefined,
    );
  }, 5_000);

  const agents: AgentRef[] = [];
  let workspace:
    Awaited<ReturnType<RuntimePort['prepareWorkspace']>> | undefined;
  const turns: { turn: number; ok: boolean; ms: number; nudged: number }[] = [];
  const startedAt = Date.now();
  try {
    workspace = await runtime.prepareWorkspace({
      session,
      repo,
      // The runtime takes a SHA or `origin/<fetchBranch>` as the base.
      baseBranch: 'origin/main',
      fetchBranch: 'main',
      name: `aio-${shortId}-probe`,
      branch: `ai-office/${shortId}/probe`,
      correlation: correlation('workspace'),
    });
    const seats = Array.from({ length: AGENTS }, (_, i) =>
      i % 2 === 0
        ? (['claude-code', `claude-${i / 2 + 1}`] as const)
        : (['codex', `codex-${(i + 1) / 2}`] as const),
    );
    for (const [agent, role] of seats)
      agents.push(
        await runtime.spawnAgent({
          session,
          agent,
          title: `aio-test probe ${role}`,
          prompt: PROMPT(role),
          workspace: {
            kind: 'existing-worktree',
            workspace: workspace.workspace,
            readOnly: true,
          },
          keepOpen: true,
          correlation: correlation(`spawn/${role}`),
        }),
      );
    // Turn 0 is the spawn itself; then tiny follow-up turns.
    for (let turn = 0; turn <= TURNS; turn++) {
      const t0 = Date.now();
      // Counted against this turn's start: a nudged agent may report twice.
      const base = turnBaseline(turn, agents, done);
      const finished = (a: AgentRef) => (done.get(a) ?? 0) > base.get(a)!;
      if (turn > 0)
        for (const [i, agent] of agents.entries())
          await runtime.send(agent, {
            subject: `turn ${turn}`,
            body: `Turn ${turn}: report worker_done now ("turn ${turn} ok").`,
            correlation: correlation(`send/${turn}/${i}`),
          });
      const nudged = new Set<AgentRef>();
      while (!agents.every(finished) && Date.now() - t0 < TURN_TIMEOUT_MS) {
        await delay(500);
        // A hung agent gets one short nudge instead of killing the sample.
        for (const [i, agent] of agents.entries())
          if (
            !finished(agent) &&
            !nudged.has(agent) &&
            Date.now() - Math.max(t0, heard.get(agent) ?? 0) >= NUDGE_AFTER_MS
          ) {
            nudged.add(agent);
            await runtime
              .send(agent, {
                subject: 'please finish the turn',
                body: `Please finish turn ${turn}: report worker_done now.`,
                correlation: correlation(`nudge/${turn}/${i}`),
              })
              .catch(() => undefined);
          }
      }
      const ok = agents.every(finished);
      turns.push({ turn, ok, ms: Date.now() - t0, nudged: nudged.size });
      if (!ok) break;
    }
  } finally {
    clearInterval(sampler);
    for (const agent of agents) {
      await runtime.stop(agent).catch(() => undefined);
      await runtime
        .release(agent, { removeWorkspace: false })
        .catch(() => undefined);
    }
    if (workspace)
      await runtime
        .disposeWorkspace(workspace.workspace)
        .catch(() => undefined);
    // A last pass records the exits, then the pump stops.
    await delay(3_000);
    stopped = true;
    kick?.();
    await pump;
    unwake?.();
    await runtime.closeSession(session).catch(() => undefined);
  }
  const verdict = probeVerdict(recorded);
  const report = {
    shortId,
    minutes: Math.round((Date.now() - startedAt) / 6_000) / 10,
    turns,
    events: recorded.length,
    ...verdict,
    agents: AGENTS,
    stateSampleOk: verdict.state.n >= 60,
    cliCallsPerMinute: {
      peak: Math.max(0, ...cli),
      mean: cli.length
        ? Math.round((cli.reduce((a, b) => a + b, 0) / cli.length) * 10) / 10
        : null,
      samples: cli.length,
    },
    // List-derived statuses are stamped at the list call that showed them;
    // the change itself happened at most one list interval earlier.
    listDerivedBound: listBound(commands.get('orchestration worker-list')),
    cliCommands: Object.fromEntries(commands),
    orcaProcesses: { peak: Math.max(0, ...procs), samples: procs.length },
  };
  await writeFile(
    join(outDir, 'probe.report.json'),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.info(`latency probe: ${JSON.stringify(report)}`);
  if (!turns.every((t) => t.ok)) throw new Error('Probe turns did not finish');
}
