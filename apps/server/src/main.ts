import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { SUBMISSION_HEADER_NAMES } from '@ai-office/contracts/agent-submission';
import type { DomainEvent } from '@ai-office/contracts/events';
import { PROJECTION_VERSION } from '@ai-office/projection';
import type { ReadModel } from '@ai-office/projection';
import { mainlineScenario } from './adapters/runtime-fake/mainline.js';
import {
  agenda,
  conclusion,
  mergeQueue,
  statement,
} from './adapters/runtime-fake/mainline-actions.js';
import { createFakeRuntime } from './adapters/runtime-fake/index.js';
import type {
  FakeRuntime,
  FakePush,
  FakeSubmission,
  RuntimeScenario,
  ScenarioContext,
  SpawnRequest,
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
import type { AgentRef, RepoRuntimeRef, RepoScmRef } from './ports/refs.js';
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

const roundOf = (context: ScenarioContext): number => {
  const body = context.message?.body ?? '';
  try {
    const parsed = JSON.parse(body) as { round?: unknown };
    if (typeof parsed.round === 'number') return parsed.round;
  } catch {
    /* Reminders are prose: "Complete round 2: ..." */
  }
  return Number(/round (\d+)/.exec(body)?.[1] ?? 1);
};

/**
 * The §0.1 mainline behavior, keyed by attempt purpose and answering the
 * engine's actual turns: participants speak when a round's message names the
 * round, the facilitator concludes when asked, and the merge-queue reads the
 * engine's review body (`headSha`).
 */
const mainline: RuntimeScenario = {
  roles: {
    ...mainlineScenario.roles,
    facilitator: {
      spawn: agenda,
      send: (context) =>
        /conclusion/i.test(
          `${context.message?.subject ?? ''} ${context.message?.body ?? ''}`,
        )
          ? conclusion
          : statement(roundOf(context)),
    },
    participant: {
      spawn: [{ type: 'done', afterMs: 20 }],
      send: (context) => statement(roundOf(context)),
    },
    'merge-queue': {
      ...mergeQueue,
      send: (context) => {
        const review = JSON.parse(context.message?.body ?? '{}') as {
          pr?: number;
          headSha?: string;
        };
        const send = mergeQueue.send as Extract<
          typeof mergeQueue.send,
          (context: ScenarioContext) => unknown
        >;
        return send({
          ...context,
          message: {
            subject: context.message?.subject ?? '',
            body: JSON.stringify({
              pr: review.pr,
              expectedHeadSha: review.headSha,
            }),
          },
        });
      },
    },
  },
};

export const FAKE_SCENARIOS: Readonly<Record<string, RuntimeScenario>> = {
  mainline,
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
  /** Fake mode: delay before the simulated human merges the final PR. */
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
  if (options.fake !== undefined && options.dev !== true)
    throw new StartupError(
      `--fake ${options.fake} requires --dev: fake runtime, SCM and usage must never serve production`,
    );
  if (options.fake !== undefined && !(options.fake in FAKE_SCENARIOS))
    throw new StartupError(
      `Unknown fake scenario "${options.fake}" (available: ${Object.keys(FAKE_SCENARIOS).join(', ')})`,
    );
}

/** Agent identity the fake runtime needs but its ports do not carry. */
type FakeBinding = {
  submit(request: FakeSubmission): Promise<void>;
  push(request: FakePush): Promise<void>;
};

/**
 * The simulated external world (Orca + GitHub + session logs). It is in
 * memory, so it survives an in-process restart (tests pass it back through
 * `fakeWorld`) but not a process restart.
 */
export interface FakeWorld {
  readonly scenario: string;
  readonly runtime: FakeRuntime;
  readonly scm: FakeScm;
  readonly usage: FakeUsage;
  /** Spawned agent → its correlation, recorded when the spawn returns. */
  readonly agents: Map<AgentRef, { workflowId: string; attemptId: string }>;
  /** Set by the running backend: role key of a spawn, from its recorded attempt. */
  roleOf: ((request: SpawnRequest) => string | undefined) | undefined;
  /** The running backend's endpoints; `bind(undefined)` while it is down. */
  readonly binding: FakeBinding | undefined;
  bind(binding: FakeBinding | undefined): void;
}

export function createFakeWorld(scenarioName: string): FakeWorld {
  const scenario = FAKE_SCENARIOS[scenarioName];
  if (scenario === undefined)
    throw new StartupError(`Unknown fake scenario "${scenarioName}"`);
  const clock = new SystemClock();
  const scm = createFakeScm({ clock });
  scm.addRepo(FAKE_REPO.github);
  let binding: FakeBinding | undefined;
  let waiting: (() => void)[] = [];
  /**
   * Like an agent whose `ai-office submit` exits 2 and retries: while the
   * backend is down (restart), actions wait for the next backend and retry.
   */
  const act = async (call: (binding: FakeBinding) => Promise<void>) => {
    for (;;) {
      const current = binding;
      if (current === undefined) {
        await new Promise<void>((resolve) => waiting.push(resolve));
        continue;
      }
      try {
        return await call(current);
      } catch (error) {
        if (binding === current) throw error;
      }
    }
  };
  const world: FakeWorld = {
    scenario: scenarioName,
    scm,
    usage: createFakeUsage({ clock }),
    agents: new Map(),
    roleOf: undefined,
    get binding() {
      return binding;
    },
    bind(next) {
      binding = next;
      if (next !== undefined) {
        const resume = waiting;
        waiting = [];
        for (const resolve of resume) resolve();
      }
    },
    runtime: createFakeRuntime({
      clock,
      scenario: {
        ...scenario,
        // Spawn titles are `aio:<commandId>`; the recorded attempt names the role.
        role: (request) => world.roleOf?.(request) ?? request.title,
        roles: scenario.roles,
      },
      submitter: (request) => act((backend) => backend.submit(request)),
      onPush: (request) => act((backend) => backend.push(request)),
      localRepos: {
        [FAKE_REPO.localPath]: {
          isGitMainWorktree: true,
          originUrl: `https://github.com/${FAKE_REPO.github.owner}/${FAKE_REPO.github.name}.git`,
          runtimeRepoId: FAKE_REPO.runtime.orcaRepoId,
        },
      },
    }),
  };
  return world;
}

/** Replaces some methods; every other call still runs on the original object. */
function override<T extends object>(target: T, methods: Partial<T>): T {
  return new Proxy(target, {
    get(object, property) {
      if (Object.hasOwn(methods, property)) return methods[property as keyof T];
      const value = Reflect.get(object, property, object) as unknown;
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
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
  if (!fake) {
    // Real adapters (runtime-orca M2, scm-github M3) do not exist yet. The
    // subprocess policy is computed here so their wiring has one entry point.
    orcaSubprocessPolicy(dataDir, env);
    throw new StartupError(
      'The Orca runtime adapter is not available until M2; start with --dev --fake <scenario>',
    );
  }
  const runtimeMode = 'fake' as const;

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

  const world = options.fakeWorld ?? createFakeWorld(options.fake!);
  if (world.scenario !== options.fake)
    throw new StartupError('The surviving fake world runs another scenario');
  const fakeRuntime = world.runtime;

  // Agent-visible behavior of the fake: it "reads" its spec for the seat
  // token, and Orca's fetch sees the branch heads GitHub reports.
  const runtime: RuntimePort = override<RuntimePort>(fakeRuntime, {
    prepareWorkspace: async (req) => {
      // Orca's fetch sees what GitHub has now.
      if (req.fetchBranch !== undefined) {
        const remote = await world.scm.compareBranch(
          FAKE_REPO.github,
          req.fetchBranch,
          req.fetchBranch,
        );
        if (remote !== null)
          fakeRuntime.setRemoteBranch(
            FAKE_REPO.runtime,
            req.fetchBranch,
            remote.headSha,
          );
      }
      return fakeRuntime.prepareWorkspace(req);
    },
    spawnAgent: async (req: Parameters<RuntimePort['spawnAgent']>[0]) => {
      const spec = /spec at (\S+) \(sha256 ([0-9a-f]{64})\)/.exec(req.prompt);
      const text = spec === null ? null : specStore.read(spec[1]!, spec[2]!);
      const token = text?.match(/\baio_seat_[A-Za-z0-9_-]+\b/)?.[0];
      const agent = await fakeRuntime.spawnAgent(
        token === undefined
          ? req
          : { ...req, prompt: `${req.prompt}\n${token}` },
      );
      if (req.correlation.attemptId !== undefined)
        world.agents.set(agent, {
          workflowId: req.correlation.workflowId,
          attemptId: req.correlation.attemptId,
        });
      return agent;
    },
  });
  world.roleOf = (request) => {
    const c = request.correlation;
    const attempt =
      c.attemptId === undefined
        ? undefined
        : runners.get(c.workflowId)?.state.attempts[c.attemptId];
    if (attempt === undefined) return undefined;
    if (attempt.ondemand?.purpose === 'merge') return 'merge-queue';
    return attempt.purpose;
  };
  const scm: ScmPort = override<ScmPort>(world.scm, {
    compareBranch: async (repo: RepoScmRef, base: string, head: string) => {
      const result = await world.scm.compareBranch(repo, base, head);
      if (result !== null)
        fakeRuntime.setRemoteBranch(FAKE_REPO.runtime, head, result.headSha);
      return result;
    },
  });
  const usage: UsagePort = world.usage;

  // One scheduler for domain, retry, health, observation and submission timers.
  let route: (timer: ScheduledTimer) => void = () => undefined;
  const scheduler = new TimerScheduler((timer) => route(timer), clock);
  cleanup.push(() => scheduler.close());
  const projectionScheduler = new TimerScheduler(
    (timer) => projections.onTimer(timer),
    clock,
  );
  cleanup.push(() => projectionScheduler.close());

  const health: HealthMonitor = new HealthMonitor({
    clock,
    scheduler,
    store: stores.events,
    workflows: (): readonly WorkflowRunner[] => runners.all(),
    runtime: { mode: runtimeMode, verified: true, version: 'fake' },
    probes: {
      runtime: async () => {
        if (!(await runtime.health()).available)
          throw new PortError(
            'transient',
            'runtime_unavailable',
            'Runtime unavailable',
          );
      },
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
    runtimeIntervalMs: 100,
    usageIntervalMs: 250,
  });
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
    limits: { globalAgents: settings.limits.globalAgents },
  });
  await commands.registerRepo({ localPath: FAKE_REPO.localPath });

  observation.start();
  cleanup.push(async () => {
    observation.stop();
    await observation.idle();
  });

  // Inbound adapters. The gateway sits outside cookie auth; REST and SSE inside.
  let port = 0;
  const app = Fastify({ logger: false });
  cleanup.push(() => app.close());
  registerAgentGateway(app, { submissions, port: () => port });
  await registerApi(app, {
    commands,
    queries: new QueryService(stores.events, projections, runtimeMode),
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

  // Fake agents act only once the gateway listens; they submit over HTTP.
  const finalMerges = new Set<ReturnType<typeof setTimeout>>();
  world.bind({
    async submit(request) {
      const response = await fetch(`${url}/agent/v1/submissions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SUBMISSION_HEADER_NAMES.authorization]: `Bearer ${request.seatToken}`,
          [SUBMISSION_HEADER_NAMES.terminalHandle]: request.terminalHandle,
          [SUBMISSION_HEADER_NAMES.paneKey]: request.paneKey,
        },
        body: JSON.stringify(request.submission),
      });
      if (response.status >= 300)
        logger.warn(
          { status: response.status, kind: request.submission.kind },
          'fake submission not accepted',
        );
    },
    async push(request) {
      const owner = world.agents.get(request.agent);
      const state =
        owner === undefined ? undefined : runners.get(owner.workflowId)?.state;
      const attempt = state?.attempts[owner!.attemptId];
      const item =
        attempt?.itemKey === undefined
          ? undefined
          : state?.workItems[attempt.itemKey];
      if (item?.branch === undefined || item.baseSha === undefined)
        throw new PortError('bug', 'fake_push_unknown_item', 'No item branch');
      // The scenario's branch name is illustrative; push the attempt's own.
      if (
        (await world.scm.compareBranch(
          FAKE_REPO.github,
          item.branch,
          item.branch,
        )) === null
      )
        await world.scm.ensureBranch(
          FAKE_REPO.github,
          item.branch,
          item.baseSha,
          {
            workflowId: owner!.workflowId,
            commandId: `fake-push:${owner!.attemptId}`,
          },
        );
      const headSha = world.scm.pushBranch(FAKE_REPO.github, item.branch);
      fakeRuntime.setRemoteBranch(FAKE_REPO.runtime, item.branch, headSha);
    },
  });
  cleanup.push(() => {
    world.bind(undefined);
  });
  // The simulated owner merges the final PR on GitHub (§7.6 is a manual merge).
  const mergeFinalPr = (event: DomainEvent) => {
    if (
      event.type !== 'gate.opened' ||
      event.payload.content.type !== 'final-pr'
    )
      return;
    const pr = event.payload.content.pr;
    if (pr === undefined) return;
    const workflowId = event.workflowId;
    const timer = setTimeout(() => {
      finalMerges.delete(timer);
      void world.scm
        .mergeExternally({ repo: FAKE_REPO.github, number: pr })
        .then(() => {
          const runner =
            workflowId === null ? undefined : runners.get(workflowId);
          return runner === undefined ? undefined : observation.pollScm(runner);
        })
        .catch(failed('fake final merge'));
    }, options.fakeFinalMergeMs ?? 5000);
    finalMerges.add(timer);
  };
  for (const event of stores.events.read({}))
    if (event.type === 'gate.opened') {
      const gate =
        event.workflowId === null
          ? undefined
          : runners.get(event.workflowId)?.state.gates[event.payload.gateId];
      if (gate?.status === 'open') mergeFinalPr(event);
    }
  const unsubscribe = stores.events.subscribe(mergeFinalPr);
  const pump = setInterval(
    () => void fakeRuntime.runDue().catch(failed('fake runtime step')),
    25,
  );
  cleanup.push(() => {
    clearInterval(pump);
    unsubscribe();
    for (const timer of finalMerges) clearTimeout(timer);
  });

  // Let in-flight commands settle so their results are recorded before close.
  cleanup.push(() => Promise.race([runners.idle(), delay(5000)]));
  lock.writeRuntime(port);
  const bootstrapUrl = `${url}/auth/bootstrap?code=${stores.sessions.issueBootstrapCode()}`;
  print(
    `AI Office listening on ${url} (runtime: ${runtimeMode}, scenario: ${world.scenario})`,
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
    fakeWorld: world,
    close: () => (closing ??= unwind()),
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
  let server: RunningServer;
  try {
    server = await startServer(parseArgs(argv));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Startup failed');
    process.exitCode = 1;
    return;
  }
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void server.close().finally(() => process.exit(process.exitCode ?? 0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main(process.argv.slice(2));
