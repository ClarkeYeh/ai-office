import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  LedgerWorkersSchema,
  LedgerTasksSchema,
} from './adapters/runtime-orca/ledger.js';
import {
  DefaultOrcaCli,
  DefaultGitCli,
  CwdGuard,
  CliScheduler,
  CliMetrics,
  SpawnExec,
  ProcessGroups,
  cleanupOrphanProcesses,
  VersionMonitor,
  DispatchLedger,
  ShimCoordinatorIdentity,
  createOrcaRuntime,
} from './adapters/runtime-orca/index.js';
import type { Exec, OrcaCli } from './adapters/runtime-orca/index.js';
import { OrcaObserver } from './adapters/runtime-orca/observe/index.js';
import {
  parseResult,
  WorktreeListSchema,
} from './adapters/runtime-orca/schemas/index.js';
import { createSessionLogUsage } from './adapters/usage-sessionlog/index.js';
import { resolveRuntimeConfig } from './config/runtime-config.js';
import { registerDevFakeRoutes } from './api/dev-fake/index.js';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { SUBMISSION_HEADER_NAMES } from '@ai-office/contracts/agent-submission';
import { PROJECTION_VERSION } from '@ai-office/projection';
import type { ReadModel } from '@ai-office/projection';
import { mainlineScenario } from './adapters/runtime-fake/mainline.js';
import { createFakeRuntime } from './adapters/runtime-fake/index.js';
import type {
  FakeRuntime,
  FakeSubmission,
  RuntimeScenario,
} from './adapters/runtime-fake/index.js';
import { createFakeScm } from './adapters/scm-fake/index.js';
import type { FakeScm } from './adapters/scm-fake/index.js';
import { createFakeUsage } from './adapters/usage-fake/index.js';
import type { FakeUsage } from './adapters/usage-fake/index.js';
import { createPinoLogger } from './adapters/logger-pino/index.js';
import {
  createRedactor,
  createRedactorFactory,
} from './adapters/redactor/index.js';
import { openSqliteStores } from './adapters/store-sqlite/index.js';
import {
  FsSpecStore,
  SystemClock,
  SystemIdGen,
  TimerScheduler,
} from './adapters/system/index.js';
import { createTemplateFsRepository } from './adapters/template-fs/index.js';
import { registerAgentGateway } from './agent-gateway/index.js';
import { registerApi } from './api/index.js';
import { SessionService } from './application/auth/session.js';
import { toErrorInfo } from './application/commands/errors.js';
import {
  CommandExecutor,
  portHandlers,
} from './application/commands/executor.js';
import { createCommandFacade } from './application/facade.js';
import {
  HEALTH_TIMER_PREFIX,
  HealthMonitor,
} from './application/health/health-monitor.js';
import type { HealthComponent } from './application/health/health-monitor.js';
import {
  OBSERVATION_TIMER_PREFIX,
  ObservationLoop,
} from './application/observation/index.js';
import {
  ProjectionService,
  QueryService,
} from './application/queries/index.js';
import { TemplateQueries } from './application/queries/templates.js';
import { Reconciler } from './application/reconciler/reconciler.js';
import { WorkflowRunners } from './application/runner/runners.js';
import type { WorkflowRunner } from './application/runner/workflow-runner.js';
import { StreamService } from './application/stream/index.js';
import { HandleSubmission } from './application/submissions/handle-submission.js';
import {
  acquireInstanceLock,
  createDataDirectories,
  readSettings,
  resolveDataDir,
} from './config/index.js';
import type { Settings } from './config/index.js';
import { PortError } from './ports/errors.js';
import type { RepoRuntimeRef, RepoScmRef } from './ports/refs.js';
import type { RuntimePort } from './ports/runtime.js';
import type { ScmPort } from './ports/scm.js';
import type { Logger, Redactor, ScheduledTimer } from './ports/services.js';
import type { UsagePort } from './ports/usage.js';

/*
 * The only composition root (§23). Startup order (plan M1-T33):
 *   instance lock → settings → dataDir → SQLite migration (backup first) and
 *   projection version → template-fs → runner restore (re-arms timers) →
 *   health restore → Reconciler (retried while receipts are pending) →
 *   ObservationLoop → Fastify on 127.0.0.1 → runtime.json → bootstrap URL.
 * Nothing accepts requests before reconciliation finishes.
 */

export const FAKE_SCENARIOS: Readonly<Record<string, RuntimeScenario>> = {
  mainline: mainlineScenario,
};

/** The repository the fake world knows; registered automatically in fake mode. */
export const FAKE_REPO = {
  localPath: '/fake/repos/demo',
  runtime: { orcaRepoId: 'fake-repo-demo', localPath: '/fake/repos/demo' },
  github: { owner: 'ai-office-fake', name: 'demo' },
} as const satisfies {
  localPath: string;
  runtime: RepoRuntimeRef;
  github: RepoScmRef;
};

export interface StartOptions {
  dev?: boolean;
  runtime?: 'orca';
  /** Programmatic integration-test seam; never accepted from CLI or config. */
  testOnly?: { scm: ScmPort };
  /** Fake scenario name; refused unless `dev` (Q7). */
  fake?: string;
  /** Overrides `server.port`; 0 picks an ephemeral port. */
  port?: number;
  breakLock?: boolean;
  /** Vite dev server origin admitted by the API in `--dev`. */
  devOrigin?: string;
  env?: NodeJS.ProcessEnv;
  /** `<installDir>/apps/cli/dist/main.js` (Q8). */
  cliPath?: string;
  webDist?: string;
  /** Fake mode: delay before the simulated owner merges the final PR (§7.6). */
  fakeFinalMergeMs?: number;
  /** Fake mode: reuse a surviving simulated external world (in-process restart). */
  fakeWorld?: FakeWorld;
  /** Receives the banner lines; defaults to stdout. */
  print?: (line: string) => void;
}

export interface RunningServer {
  readonly app: FastifyInstance;
  readonly port: number;
  readonly url: string;
  readonly bootstrapUrl: string;
  readonly dataDir: string;
  readonly runtimeMode: 'fake' | 'orca';
  readonly runners: WorkflowRunners;
  readonly fakeWorld?: FakeWorld;
  close(): Promise<void>;
}

export class StartupError extends Error {}

/** Validates flag combinations before any side effect (Q7). */
export function checkStartOptions(options: StartOptions): void {
  if (options.runtime !== undefined && options.runtime !== 'orca')
    throw new StartupError('Unknown runtime');
  if (options.runtime !== undefined && options.fake !== undefined)
    throw new StartupError('--runtime and --fake are mutually exclusive');
  if (
    options.testOnly !== undefined &&
    !(
      options.dev === true &&
      options.runtime === 'orca' &&
      options.fake === undefined
    )
  )
    throw new StartupError('testOnly.scm requires --dev --runtime orca');
  if (options.fake !== undefined && options.dev !== true)
    throw new StartupError(
      `--fake ${options.fake} requires --dev: fake runtime, SCM and usage must never serve production`,
    );
  if (options.fake !== undefined && !(options.fake in FAKE_SCENARIOS))
    throw new StartupError(
      `Unknown fake scenario "${options.fake}" (available: ${Object.keys(FAKE_SCENARIOS).join(', ')})`,
    );
}

/** The running backend as fake agents reach it. */
type FakeBackend = { submit(request: FakeSubmission): Promise<void> };

/**
 * The simulated external world (Orca + GitHub + session logs). Fake mode
 * checkpoints its data to disk; tests may also retain it across in-process restarts.
 */
export interface FakeWorld {
  readonly scenario: string;
  readonly runtime: FakeRuntime;
  readonly scm: FakeScm;
  readonly usage: FakeUsage;
  /** Set while a backend listens; agents retry their submissions meanwhile. */
  backend: FakeBackend | undefined;
}

export function createFakeWorld(
  scenario: string,
  options: {
    readSpec: (path: string, sha256: string) => string | null;
    finalMergeMs?: number;
  },
): FakeWorld {
  const clock = new SystemClock();
  const scm = createFakeScm({
    clock,
    ...(options.finalMergeMs === undefined
      ? {}
      : { autoMergeIntoDefaultBranchAfterMs: options.finalMergeMs }),
  });
  scm.addRepo(FAKE_REPO.github);
  const backendDown = (): never => {
    throw new PortError('transient', 'backend_down', 'Backend not listening');
  };
  const world: FakeWorld = {
    scenario,
    scm,
    usage: createFakeUsage({ clock }),
    backend: undefined,
    runtime: createFakeRuntime({
      clock,
      scenario: FAKE_SCENARIOS[scenario]!,
      localRepos: {
        [FAKE_REPO.localPath]: {
          isGitMainWorktree: true,
          originUrl: `https://github.com/${FAKE_REPO.github.owner}/${FAKE_REPO.github.name}.git`,
          runtimeRepoId: FAKE_REPO.runtime.orcaRepoId,
        },
      },
      readSpec: options.readSpec,
      remoteHead: async (ref) =>
        (await scm.compareBranch(FAKE_REPO.github, ref, ref))?.headSha ?? null,
      onPush: ({ branch, base }) => {
        scm.pushBranch(FAKE_REPO.github, branch, base);
      },
      submitter: (request) => (world.backend ?? backendDown()).submit(request),
      submitRetryMs: 250,
    }),
  };
  return world;
}

type FakeWorldSnapshot = {
  version: 1;
  scenario: string;
  runtime: ReturnType<FakeRuntime['snapshot']>;
  scm: ReturnType<FakeScm['snapshot']>;
  usage: ReturnType<FakeUsage['snapshot']>;
};
const worldDigest = (payload: string) =>
  createHash('sha256').update(payload).digest('hex');

/** An atomic private checkpoint, independent of the backend's event store. */
function persistFakeWorld(world: FakeWorld, dataDir: string, restore: boolean) {
  const path = `${dataDir}/data/fake-world.json`;
  if (existsSync(path)) {
    try {
      const envelope = JSON.parse(readFileSync(path, 'utf8')) as {
        payload: string;
        sha256: string;
      };
      if (
        typeof envelope.payload !== 'string' ||
        worldDigest(envelope.payload) !== envelope.sha256
      )
        throw new Error('Snapshot checksum mismatch');
      const state = JSON.parse(envelope.payload) as FakeWorldSnapshot;
      if (state.version !== 1 || state.scenario !== world.scenario)
        throw new Error('Snapshot scenario or version mismatch');
      if (restore) {
        world.runtime.restore(state.runtime);
        world.scm.restore(state.scm);
        world.usage.restore(state.usage);
      }
    } catch {
      throw new StartupError(
        `Cannot restore fake world: corrupt snapshot, incompatible version, or different scenario; delete ${path} to reset the fake world`,
      );
    }
  }
  let saved: string | undefined;
  const save = () => {
    const state: FakeWorldSnapshot = {
      version: 1,
      scenario: world.scenario,
      runtime: world.runtime.snapshot(),
      scm: world.scm.snapshot(),
      usage: world.usage.snapshot(),
    };
    const payload = JSON.stringify(state);
    if (payload === saved) return;
    const temporary = `${path}.tmp`;
    // Remove any interrupted write before creating a new mode-0600 inode.
    rmSync(temporary, { force: true });
    writeFileSync(
      temporary,
      JSON.stringify({ payload, sha256: worldDigest(payload) }) + '\n',
      { mode: 0o600, flag: 'wx', flush: true },
    );
    renameSync(temporary, path);
    saved = payload;
  };
  return save;
}

/** A fake agent's `ai-office submit`: the real gateway over HTTP. */
async function postSubmission(
  url: string,
  request: FakeSubmission,
): Promise<number> {
  let response: Response;
  try {
    response = await fetch(`${url}/agent/v1/submissions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SUBMISSION_HEADER_NAMES.authorization]: `Bearer ${request.seatToken}`,
        [SUBMISSION_HEADER_NAMES.terminalHandle]: request.terminalHandle,
        [SUBMISSION_HEADER_NAMES.paneKey]: request.paneKey,
      },
      body: JSON.stringify(request.submission),
    });
  } catch {
    throw new PortError('transient', 'backend_unreachable', 'No backend');
  }
  if (response.status >= 500)
    throw new PortError('transient', 'backend_unavailable', 'Backend error');
  return response.status;
}

/** Records each adapter call outside the executor (which records its own). */
function instrument<T extends object>(
  port: T,
  component: HealthComponent,
  health: HealthMonitor,
  clock: { now(): Date },
): T {
  return new Proxy(port, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function' || property === 'health') return value;
      return (...args: unknown[]) => {
        const startedAt = clock.now().getTime();
        const result = (value as (...a: unknown[]) => unknown).apply(
          target,
          args,
        );
        if (!(result instanceof Promise)) return result;
        return result.then(
          async (resolved) => {
            await health.record(component, startedAt);
            return resolved;
          },
          async (error: unknown) => {
            await health.record(
              component,
              startedAt,
              toErrorInfo(error).category,
            );
            throw error;
          },
        );
      };
    },
  });
}

/** §6.3 enforcement points for Orca subprocesses (runtime-orca, M2). */
export function orcaSubprocessPolicy(
  dataDir: string,
  env: NodeJS.ProcessEnv,
): { cwd: string; env: NodeJS.ProcessEnv } {
  const cwd = `${dataDir}/cli-cwd`;
  const orcaHome = `${dataDir}/orca-home`;
  if (cwd === orcaHome || cwd.startsWith(`${orcaHome}${sep}`))
    throw new StartupError('cli-cwd must not be inside orca-home');
  const allowed: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'TMPDIR',
  ])
    if (env[key] !== undefined) allowed[key] = env[key];
  return { cwd, env: allowed };
}

/** The masking half of the Redactor port; policy checks use RedactorFactory.forAttempt. */
function maskingOnly(redactor: Redactor): Redactor {
  return {
    maskSecrets: (value) => redactor.maskSecrets(value),
    toActivity() {
      throw new Error('Policy checks require RedactorFactory.forAttempt');
    },
  };
}

const delay = (ms: number) =>
  new Promise<void>((done) => setTimeout(done, ms).unref());

export async function startServer(
  options: StartOptions = {},
): Promise<RunningServer> {
  checkStartOptions(options);
  const env = options.env ?? process.env;
  const print = options.print ?? ((line: string) => console.log(line));
  const dataDir = resolveDataDir(env);
  const lock = acquireInstanceLock(dataDir, {
    breakLock: options.breakLock === true,
  });
  const cleanup: (() => void | Promise<void>)[] = [() => lock.release()];
  const unwind = async () => {
    for (const step of cleanup.splice(0).reverse()) {
      try {
        await step();
      } catch {
        /* Best effort: later steps still release the lock. */
      }
    }
  };
  try {
    return await compose(options, env, dataDir, print, lock, cleanup, unwind);
  } catch (error) {
    await unwind();
    throw error;
  }
}

function absoluteUsagePaths(paths: string[]): string[] {
  if (paths.some((path) => !isAbsolute(path) || path.includes('\0')))
    throw new StartupError(
      'usage.claudeConfigDirs and usage.codexHomes must be absolute paths',
    );
  return paths.map((path) => resolve(path));
}

/** All process-bound resources share the same budget, identity and durable ledger. */
async function composeOrca(
  settings: Settings,
  config: ReturnType<typeof resolveRuntimeConfig>,
  dataDir: string,
  env: NodeJS.ProcessEnv,
  stores: ReturnType<typeof openSqliteStores<ReadModel>>,
  ids: SystemIdGen,
  logger: Logger,
  cleanup: (() => void | Promise<void>)[],
  dev: boolean,
) {
  absoluteUsagePaths(settings.usage.claudeConfigDirs);
  absoluteUsagePaths(settings.usage.codexHomes);
  if (settings.orca.cliConcurrency < 2)
    throw new StartupError(
      'orca.cliConcurrency must be at least 2 (one slot is reserved for commands)',
    );
  const range = /^>=(\d+\.\d+\.\d+) <(\d+)\.(\d+)(?:\.(\d+))?$/.exec(
    settings.orca.supportedRange,
  );
  if (!range)
    throw new StartupError('orca.supportedRange must use >=x.y.z <x.y[.z]');
  const upper = [Number(range[2]), Number(range[3]), Number(range[4] ?? 0)];
  for (let i = 2; i >= 0; i--) {
    if (upper[i]! > 0) {
      upper[i]!--;
      break;
    }
    upper[i] = Number.MAX_SAFE_INTEGER;
  }
  const policy = orcaSubprocessPolicy(dataDir, env);
  const state = stores.adapterState('runtime-orca');
  const groups = new ProcessGroups(state);
  const processExec = new SpawnExec(groups);
  const abort = new AbortController();
  const active = new Set<Promise<unknown>>();
  const exec: Exec = {
    run(request) {
      const pending = processExec.run({
        ...request,
        signal: request.signal
          ? AbortSignal.any([abort.signal, request.signal])
          : abort.signal,
      });
      active.add(pending);
      void pending.finally(() => active.delete(pending)).catch(() => undefined);
      return pending;
    },
  };
  let pressured = false;
  const scheduler = new CliScheduler(
    settings.orca.maxCallsPerMinute,
    settings.orca.cliConcurrency,
    Date.now,
    (value) => {
      pressured = value;
    },
  );
  // A consuming check holds a slot for its entire long poll. Bound these separately
  // so any number of restored runs still leaves capacity for commands/discovery.
  const polls = new CliScheduler(
    settings.orca.maxCallsPerMinute,
    settings.orca.cliConcurrency - 1,
  );
  const metrics = new CliMetrics();
  const cwdGuard = new CwdGuard(dataDir, () =>
    scheduler.schedule('identity', async () => {
      const started = Date.now();
      let failed = true;
      try {
        // Bootstrap discovery cannot recurse through DefaultOrcaCli's cwd guard.
        const output = await exec.run({
          bin: config.orcaBinPath,
          args: ['worktree', 'list', '--json'],
          cwd: policy.cwd,
          env: config.orcaEnv,
          timeoutMs: 60_000,
        });
        const paths = WorktreeListSchema.parse(
          parseResult(output.stdout),
        ).worktrees.map((w) => w.path);
        failed = false;
        return paths;
      } finally {
        metrics.record('worktree list', Date.now() - started, failed);
      }
    }),
  );
  const cli: DefaultOrcaCli = new DefaultOrcaCli({
    bin: config.orcaBinPath,
    env: config.orcaEnv,
    cwdGuard,
    exec,
    scheduler,
    metrics,
    identity: { argsFor: (...args) => identity.argsFor(...args) },
  });
  const identity: ShimCoordinatorIdentity = new ShimCoordinatorIdentity({
    cli,
    state,
    dataDir,
    shimLocation: settings.orca.shimLocation,
    closeOnExit: settings.orca.shim.closeOnExit,
  });
  const observerCli: OrcaCli = {
    run: (args, options, schema) =>
      options.kind === 'consume'
        ? polls.schedule('consume', () => cli.run(args, options, schema))
        : cli.run(args, options, schema),
  };
  const ledger = new DispatchLedger(state);
  const observer = new OrcaObserver({
    cli: observerCli,
    identity,
    ledger,
    logger,
    pressured: () => pressured,
  });
  const version = new VersionMonitor(cli, {
    min: range[1]!,
    max: upper.join('.'),
  });
  const git = new DefaultGitCli({
    exec,
    cwdGuard,
    env: config.gitFetchEnv,
    passthrough: settings.env.passthrough,
  });
  const base = createOrcaRuntime({
    cli,
    git,
    identity,
    ledger,
    state,
    ids,
    logger,
    dataDir,
    observer,
    version,
    metrics,
    binPath: config.orcaBinPath,
    supportedRange: settings.orca.supportedRange,
  });
  const runtime: RuntimePort = {
    ...base,
    async answer(question, body, correlation) {
      await base.answer(question, body, correlation);
      observer.markAnswered(question);
    },
    async health() {
      const info = await base.health();
      return {
        ...info,
        warnings: [...new Set([...(info.warnings ?? []), ...config.warnings])],
      };
    },
  };
  let sleep: AbortController | undefined;
  let closed = false;
  let identityStarted = false;
  const setActive = (running: boolean) => {
    if (closed || !settings.orca.preventSleep || process.platform !== 'darwin')
      return;
    if (!running) {
      sleep?.abort();
      sleep = undefined;
      return;
    }
    if (sleep) return;
    const controller = (sleep = new AbortController());
    void exec
      .run({
        bin: '/usr/bin/caffeinate',
        args: ['-i', '-w', String(process.pid)],
        cwd: policy.cwd,
        env: config.orcaEnv,
        timeoutMs: 2_147_483_647,
        signal: controller.signal,
      })
      .catch(() => {
        if (!controller.signal.aborted)
          logger.warn({}, 'Sleep prevention unavailable');
      })
      .finally(() => {
        if (sleep === controller) sleep = undefined;
      });
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    observer.close();
    polls.close();
    sleep?.abort();
    try {
      if (identityStarted) await Promise.race([identity.close(), delay(1000)]);
    } finally {
      scheduler.close();
      abort.abort();
      await Promise.allSettled([...active]);
    }
  };
  cleanup.push(close);
  if (!dev) return { runtime, observer, close, setActive };
  await cwdGuard.check();
  await cleanupOrphanProcesses(groups, { exec, cwdGuard, env: config.orcaEnv });
  await version.check();
  identityStarted = true;
  await identity.ensure();
  const sessions = z
    .record(z.string(), z.unknown())
    .parse(state.read('orca:sessions') ?? {});
  for (const run of new Set([
    ...Object.keys(sessions),
    ...ledger.all().map((entry) => entry.run),
  ])) {
    const workers: z.infer<typeof LedgerWorkersSchema>['workers'] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const { result } = await cli.run(
        [
          'orchestration',
          'worker-list',
          '--full',
          '--limit',
          '100',
          ...(cursor ? ['--cursor', cursor] : []),
        ],
        { kind: 'read', priority: 'worker-list', run },
        LedgerWorkersSchema.extend({ nextCursor: z.string().nullish() }),
      );
      workers.push(...result.workers);
      cursor = result.nextCursor ?? undefined;
      if (cursor && seen.has(cursor))
        throw new StartupError(
          'Repeated worker-list cursor during ledger restoration',
        );
      if (cursor) seen.add(cursor);
    } while (cursor);
    const { result: tasks } = await cli.run(
      ['orchestration', 'task-list', '--full'],
      { kind: 'read', priority: 'worker-list', run },
      LedgerTasksSchema,
    );
    ledger.rebuild(run, { workers }, tasks);
  }
  return { runtime, observer, close, setActive };
}

async function compose(
  options: StartOptions,
  env: NodeJS.ProcessEnv,
  dataDir: string,
  print: (line: string) => void,
  lock: ReturnType<typeof acquireInstanceLock>,
  cleanup: (() => void | Promise<void>)[],
  unwind: () => Promise<void>,
): Promise<RunningServer> {
  const settings: Settings = readSettings(dataDir);
  createDataDirectories(dataDir);
  const fake = options.fake !== undefined;
  const runtimeMode = fake ? ('fake' as const) : ('orca' as const);
  const runtimeConfig = fake ? undefined : resolveRuntimeConfig(settings, env);

  const clock = new SystemClock();
  const ids = new SystemIdGen(clock);
  const masking = maskingOnly(createRedactor({ defaultBranch: 'main' }));
  const logger: Logger = createPinoLogger({
    dataDir,
    redactor: masking,
    clock,
  });
  const stores = openSqliteStores<ReadModel>({
    filename: `${dataDir}/data/ai-office.sqlite`,
    clock,
    ids,
    projectionVersion: PROJECTION_VERSION,
  });
  cleanup.push(() => stores.close());
  if (stores.backupPath !== null)
    logger.info({ backupPath: stores.backupPath }, 'database migrated');
  const templates = await createTemplateFsRepository(dataDir);
  const specStore = new FsSpecStore(`${dataDir}/data`);
  const cliPath =
    options.cliPath ?? resolve(import.meta.dirname, '../../cli/dist/main.js');

  let world: FakeWorld | undefined;
  let finalCheckpointError: unknown;
  let runtime: RuntimePort;
  let scm: ScmPort;
  let usage: UsagePort;
  let orca: Awaited<ReturnType<typeof composeOrca>> | undefined;
  if (fake) {
    world =
      options.fakeWorld ??
      createFakeWorld(options.fake!, {
        readSpec: (path, sha256) => specStore.read(path, sha256),
        ...(options.fakeFinalMergeMs === undefined
          ? {}
          : { finalMergeMs: options.fakeFinalMergeMs }),
      });
    if (world.scenario !== options.fake)
      throw new StartupError('The surviving fake world runs another scenario');
    const saveFakeWorld = persistFakeWorld(
      world,
      dataDir,
      options.fakeWorld === undefined,
    );
    saveFakeWorld();
    // Sampling all three adapters also covers scenario/test mutations outside ports.
    // Compare before writing: changes are coalesced to at most one checkpoint/second.
    const checkpoint = setInterval(() => {
      try {
        saveFakeWorld();
      } catch {
        logger.error({}, 'fake world checkpoint failed');
      }
    }, 1000).unref();

    cleanup.push(() => {
      clearInterval(checkpoint);
      // Flush after observation drains, while the data-directory lock is held.
      try {
        saveFakeWorld();
      } catch (error) {
        finalCheckpointError = error;
      }
    });
    runtime = world.runtime;
    scm = world.scm;
    usage = world.usage;
  } else {
    orca = await composeOrca(
      settings,
      runtimeConfig!,
      dataDir,
      env,
      stores,
      ids,
      logger,
      cleanup,
      options.dev === true,
    );
    runtime = orca.runtime;
    if (!options.dev)
      throw new StartupError(
        'Production SCM (scm-github) is available in M3; use --dev --runtime orca',
      );
    scm = options.testOnly?.scm ?? createFakeScm({ clock });
    if (!options.testOnly) {
      const fakeScm = scm as FakeScm;
      const inspect = runtime.inspectLocalRepo.bind(runtime);
      runtime.inspectLocalRepo = async (path) => {
        const local = await inspect(path);
        const match =
          /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
            local.originUrl ?? '',
          );
        if (local.isGitMainWorktree && local.runtimeRepoId && match)
          fakeScm.addRepo({ owner: match[1]!, name: match[2]! });
        return local;
      };
      // The simulated remote must also know repos restored from the event store.
      for (const event of stores.events.read({ workflowId: null }))
        if (event.type === 'repo.registered')
          fakeScm.addRepo(event.payload.github);
    }
    const logs = createSessionLogUsage({
      clock,
      ...(env.HOME ? { homeDir: env.HOME } : {}),
      claudeConfigDirs: absoluteUsagePaths(settings.usage.claudeConfigDirs),
      codexHomes: absoluteUsagePaths(settings.usage.codexHomes),
    });
    const sessions = new Map<string, import('./ports/usage.js').UsageRef>();
    usage = {
      capabilities: () => logs.capabilities(),
      read: (ref, cursor) => logs.read(ref, cursor),
      locate: async (ref) => {
        const cached = sessions.get(ref.attemptId);
        if (cached) return cached;
        const found = await logs.locate(ref);
        if (found) sessions.set(ref.attemptId, found);
        return found;
      },
    };
  }

  // One scheduler for domain, retry, health, observation and submission timers.
  let route: (timer: ScheduledTimer) => void = () => undefined;
  const scheduler = new TimerScheduler((timer) => route(timer), clock);
  cleanup.push(() => scheduler.close());
  const projectionScheduler = new TimerScheduler(
    (timer) => projections.onTimer(timer),
    clock,
  );
  cleanup.push(() => projectionScheduler.close());

  const runtimeMetadata = { mode: runtimeMode, ...(await runtime.health()) };
  const refreshRuntimeHealth = async () => {
    Object.assign(runtimeMetadata, await runtime.health());
    if (!runtimeMetadata.available)
      throw new PortError(
        'transient',
        'runtime_unavailable',
        'Runtime unavailable',
      );
  };
  const health: HealthMonitor = new HealthMonitor({
    clock,
    scheduler,
    store: stores.events,
    workflows: (): readonly WorkflowRunner[] => runners.all(),
    runtime: runtimeMetadata,
    probes: {
      runtime: refreshRuntimeHealth,
      scm: async () => {
        if (!(await scm.health()).available)
          throw new PortError(
            'transient',
            'scm_unavailable',
            'SCM unavailable',
          );
      },
      store: async () => {
        stores.events.lastSeq();
      },
      usage: async () => {
        if (usage.capabilities().source === 'none')
          throw new PortError(
            'transient',
            'usage_unavailable',
            'No usage source',
          );
      },
    },
  });
  const executor: CommandExecutor = new CommandExecutor({
    handlers: portHandlers({ runtime, scm, specStore }),
    health,
    scheduler,
    clock,
    logger,
  });
  const runners: WorkflowRunners = new WorkflowRunners({
    store: stores.events,
    executor,
    scheduler,
    clock,
    ids,
    logger,
    seatTokens: stores.seatTokens,
    specStore,
    cliPath,
  });
  const observedRuntime = instrument(runtime, 'runtime', health, clock);
  const observedScm = instrument(scm, 'scm', health, clock);
  const observedUsage = instrument(usage, 'usage', health, clock);
  const submissions = new HandleSubmission({
    runners,
    runtime: observedRuntime,
    seatTokens: stores.seatTokens,
    store: stores.events,
    redactor: masking,
    clock,
    scheduler,
    ids,
  });
  const observation = new ObservationLoop({
    runtime: observedRuntime,
    scm: observedScm,
    usage: observedUsage,
    store: stores.events,
    redactors: createRedactorFactory(),
    clock,
    scheduler,
    logger,
    workflows: () => runners.all(),
    budgetFormula: settings.usage.budgetFormula,
    // The fake answers instantly; poll fast so a scenario runs in seconds.
    runtimeIntervalMs: fake ? 100 : 2000,
    usageIntervalMs: fake ? 250 : 15_000,
    ...(fake ? { scmIntervalMs: 250 } : {}),
    usageIdentity: (attempt) => ({
      dispatchId: attempt.agentRef!,
      startedAt: attempt.spawnedAt,
    }),
  });
  const warnRejected = (status: number) => {
    if (status >= 300) logger.warn({ status }, 'fake submission not accepted');
  };
  const failed = (what: string) => (error: unknown) =>
    logger.error({ error: toErrorInfo(error) }, `${what} failed`);
  route = (timer) => {
    // Merge waits first: their timers would otherwise reach the runner (T28).
    if (submissions.onTimer(timer)) return;
    if (timer.id.startsWith(HEALTH_TIMER_PREFIX))
      void health.onTimer(timer).catch(failed('health timer'));
    else if (timer.id.startsWith(OBSERVATION_TIMER_PREFIX))
      void observation.onTimer(timer).catch(failed('observation timer'));
    else runners.onTimer(timer);
  };

  // Restore before anything can dispatch: replay, re-arm timers, health, reconcile.
  runners.recover();
  await health.restore();
  const reconciler = new Reconciler({
    runtime: observedRuntime,
    scm: observedScm,
    specStore,
    clock,
  });
  for (let pass = 1; ; pass++) {
    const { pending } = await reconciler.reconcile(runners);
    if (pending === 0) break;
    if (pass >= 30)
      throw new StartupError(
        `${pending} runtime request(s) are still pending after ${pass} reconciliation passes; check the runtime and restart`,
      );
    logger.warn({ pending, pass }, 'reconciliation pending; retrying');
    await delay(Math.min(1000 * pass, 5000));
  }
  await runners.idle();

  const projections = new ProjectionService(
    stores.events,
    stores.projections,
    clock,
    projectionScheduler,
  );
  cleanup.push(() => projections.close());
  const commands = createCommandFacade({
    runners,
    store: stores.events,
    templates,
    runtime: observedRuntime,
    scm: observedScm,
    clock,
    ids,
    idempotency: stores.idempotency,
    redactor: masking,
    limits: {
      globalAgents: settings.limits.globalAgents,
      spawnStallMs: settings.engine.spawnStallMs,
      budgetEnforcement: settings.budget.enforcement,
    },
  });
  if (fake) await commands.registerRepo({ localPath: FAKE_REPO.localPath });

  const refreshSleep = () =>
    orca?.setActive(
      runners.all().some((r) => r.state.workflow?.status === 'running'),
    );
  const unsubscribeSleep = stores.events.subscribe(() =>
    queueMicrotask(refreshSleep),
  );
  cleanup.push(unsubscribeSleep);
  refreshSleep();
  const healthPoll = setInterval(() => {
    void refreshRuntimeHealth().catch(failed('runtime health'));
  }, 60_000).unref();
  cleanup.push(() => clearInterval(healthPoll));
  observation.start();
  cleanup.push(async () => {
    observation.stop();
    await observation.idle();
  });

  // Inbound adapters. The gateway sits outside cookie auth; REST and SSE inside.
  let port = 0;
  // Gate and seat ids embed workflow, stage and attempt ids (e.g. nudge gates
  // run past 100 chars); Fastify's default maxParamLength (100) would 404 them.
  const app = Fastify({ logger: false, maxParamLength: 1024 });
  cleanup.push(() => app.close());
  cleanup.push(() => submissions.close());
  registerAgentGateway(app, { submissions, port: () => port });
  const apiDeps = {
    commands,
    queries: new (class extends QueryService {
      override getHealth() {
        const view = super.getHealth();
        const snapshot = health.snapshot();
        const capabilities = usage.capabilities();
        return {
          ...view,
          ...snapshot,
          runtime: {
            ...view.runtime,
            ...snapshot.runtime,
            version: runtimeMetadata.version,
            verified: runtimeMetadata.verified,
            shim: {
              status:
                runtimeMetadata.shim === 'ready'
                  ? ('ok' as const)
                  : ('missing' as const),
              ...(runtimeMetadata.shimLocation
                ? { location: runtimeMetadata.shimLocation }
                : {}),
            },
            runOwned: runtimeMetadata.ownership === 'owned',
            ...(runtimeMetadata.binPath
              ? { binPath: runtimeMetadata.binPath }
              : {}),
            ...(runtimeMetadata.supportedRange
              ? { supportedRange: runtimeMetadata.supportedRange }
              : {}),
            ...(runtimeMetadata.warnings
              ? { warnings: runtimeMetadata.warnings }
              : {}),
            ...(runtimeMetadata.cliCallsPerMinute !== undefined
              ? { cliCallsPerMinute: runtimeMetadata.cliCallsPerMinute }
              : {}),
            ...(runtimeMetadata.cpuSecondsPerMinute !== undefined
              ? { cpuSecondsPerMinute: runtimeMetadata.cpuSecondsPerMinute }
              : {}),
          },
          scm: {
            ...view.scm,
            ...snapshot.scm,
            ...(runtimeConfig ? { ghBinPath: runtimeConfig.ghBinPath } : {}),
          },
          usage: {
            ...snapshot.usage,
            sources: capabilities.agents.map((agent) => ({
              agent,
              source: capabilities.source,
              available: capabilities.source !== 'none',
              formatVerified: capabilities.formatVerified,
            })),
          },
        };
      }
    })(stores.events, projections, runtimeMode),
    templates: new TemplateQueries(templates),
    sessions: new SessionService(stores.sessions),
    stream: new StreamService(stores.events),
    get port() {
      return port;
    },
    dev: options.dev === true,
    ...(options.devOrigin === undefined
      ? options.dev === true
        ? { devOrigin: 'http://localhost:5173' }
        : {}
      : { devOrigin: options.devOrigin }),
  };
  await registerApi(app, apiDeps);
  if (options.dev === true && world)
    await registerDevFakeRoutes(app, apiDeps, {
      mergeOwner: (number) =>
        world!.scm.mergeOwner({ repo: FAKE_REPO.github, number }),
    });
  const webDist =
    options.webDist ?? resolve(import.meta.dirname, '../../web/dist');
  if (existsSync(`${webDist}/index.html`)) {
    // Same-origin production UI (§13); client-side routes fall back to index.html.
    const index = readFileSync(`${webDist}/index.html`, 'utf8');
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((request, reply) =>
      request.method === 'GET' &&
      !request.url.startsWith('/api/') &&
      !request.url.startsWith('/agent/')
        ? reply.type('text/html; charset=utf-8').send(index)
        : reply.code(404).send({ error: 'not_found' }),
    );
  }
  await app.listen({
    host: '127.0.0.1',
    port: options.port ?? settings.server.port,
  });
  const address = app.server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;

  // Fake agents reach this backend through the gateway once it listens.
  if (world) {
    const fakeWorld = world;
    fakeWorld.backend = {
      submit: (request) => postSubmission(url, request).then(warnRejected),
    };
    const pump = setInterval(
      () => void fakeWorld.runtime.runDue().catch(failed('fake runtime step')),
      25,
    );
    cleanup.push(() => {
      clearInterval(pump);
      fakeWorld.backend = undefined;
    });
  }

  // Briefly drain command results while keeping shutdown below five seconds.
  // Still-pending commands remain in the durable outbox for reconciliation.
  cleanup.push(async () => {
    observation.stop();
    submissions.close();
    orca?.observer.close();
    await Promise.race([runners.idle(), delay(1000)]);
    await orca?.close();
    await observation.idle();
  });
  lock.writeRuntime(port);
  const bootstrapUrl = `${url}/auth/bootstrap?code=${stores.sessions.issueBootstrapCode()}`;
  print(
    `AI Office listening on ${url} (runtime: ${runtimeMode}, ${world ? `scenario: ${world.scenario}` : 'scm: fake (M2)'})`,
  );
  print(`Open ${bootstrapUrl}`);
  logger.info(
    { port, runtime: runtimeMode, dev: options.dev === true },
    'started',
  );

  let closing: Promise<void> | undefined;
  return {
    app,
    port,
    url,
    bootstrapUrl,
    dataDir,
    runtimeMode,
    runners,
    ...(world ? { fakeWorld: world } : {}),
    close: () => {
      observation.stop();
      submissions.close();
      orca?.observer.close();
      return (closing ??= (async () => {
        await unwind();
        if (finalCheckpointError) throw finalCheckpointError;
      })());
    },
  };
}

/** `node apps/server/dist/main.js [--dev] [--fake <scenario>] [--port <n>] [--break-lock]` */
export function parseArgs(argv: readonly string[]): StartOptions {
  const options: StartOptions = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const value = () => {
      const next = argv[++index];
      if (next === undefined || next.startsWith('--'))
        throw new StartupError(`${arg} requires a value`);
      return next;
    };
    switch (arg) {
      case '--dev':
        options.dev = true;
        break;
      case '--runtime': {
        const mode = value();
        if (mode !== 'orca') throw new StartupError('--runtime must be orca');
        options.runtime = mode;
        break;
      }
      case '--fake':
        options.fake = value();
        break;
      case '--port': {
        const port = Number(value());
        if (!Number.isInteger(port) || port < 0 || port > 65535)
          throw new StartupError('--port must be 0-65535');
        options.port = port;
        break;
      }
      case '--break-lock':
        options.breakLock = true;
        break;
      case '--dev-origin':
        options.devOrigin = value();
        break;
      case '--cli-path':
        options.cliPath = value();
        break;
      default:
        throw new StartupError(`Unknown option ${arg}`);
    }
  }
  return options;
}

async function main(argv: readonly string[]): Promise<void> {
  // Listen before starting: the bootstrap URL is printed (and runtime.json
  // written) before startServer resolves, so a stop can arrive mid-startup.
  // It then closes the server once it is up instead of killing it outright.
  const starting = (async () => startServer(parseArgs(argv)))().catch(
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : 'Startup failed');
      process.exitCode = 1;
      return undefined;
    },
  );
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void starting
      .then((server) => server?.close())
      .finally(() => process.exit(process.exitCode ?? 0));
  };
  // `on`, not `once`: a repeated signal must hit the no-op guard above rather
  // than the default action, which would kill us before runtime.json is removed.
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if ((await starting) === undefined) {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main(process.argv.slice(2));
