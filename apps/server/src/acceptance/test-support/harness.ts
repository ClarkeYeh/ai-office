import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeRuntime } from '../../adapters/runtime-fake/index.js';
import type { FakeRuntime } from '../../adapters/runtime-fake/index.js';
import type {
  RoleBehavior,
  RuntimeScenario,
} from '../../adapters/runtime-fake/index.js';
import { mainlineScenario } from '../../adapters/runtime-fake/mainline.js';
import { createFakeScm } from '../../adapters/scm-fake/index.js';
import type { FakeScm } from '../../adapters/scm-fake/index.js';
import { createFakeUsage } from '../../adapters/usage-fake/index.js';
import { FsSpecStore, SystemClock } from '../../adapters/system/index.js';
import { FAKE_REPO, startServer } from '../../main.js';
import type { FakeWorld, RunningServer, StartOptions } from '../../main.js';
import { PortError } from '../../ports/errors.js';
import type { AgentRef } from '../../ports/refs.js';

/*
 * Acceptance harness (M1-T34): every scenario runs through the composed
 * backend (`startServer`, fake mode) over real HTTP, with SQLite in a temp
 * AI_OFFICE_HOME and the fake Orca/GitHub/usage world. Tests change only the
 * fake world (agent behavior, SCM state, usage) and act like the browser.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON over HTTP
export type Json = Record<string, any>;

/** The mainline scenario with some roles' behavior replaced. */
export const scenarioWith = (
  overrides: Readonly<Record<string, RoleBehavior>> = {},
): RuntimeScenario => ({
  ...mainlineScenario,
  roles: { ...mainlineScenario.roles, ...overrides },
});

/**
 * The same external world `createFakeWorld` builds, but with a test-chosen
 * agent behavior. It is labelled `mainline` because the composition root only
 * admits registered scenario names; the roles are the mainline ones plus the
 * overrides.
 */
export function acceptanceWorld(
  dataDir: string,
  scenario: RuntimeScenario,
  options: {
    finalMergeMs?: number;
    intercept?: RuntimeIntercept;
    scmIntercept?: RuntimeIntercept;
    mergeDelay?: (ms: number) => Promise<void>;
  } = {},
): FakeWorld {
  const clock = new SystemClock();
  const specStore = new FsSpecStore(`${dataDir}/data`);
  const scm = createFakeScm({
    clock,
    autoMergeIntoDefaultBranchAfterMs: options.finalMergeMs ?? 50,
    ...(options.mergeDelay === undefined ? {} : { delay: options.mergeDelay }),
  });
  scm.addRepo(FAKE_REPO.github);
  const world: FakeWorld = {
    scenario: 'mainline',
    scm,
    usage: createFakeUsage({ clock }),
    backend: undefined,
    runtime: createFakeRuntime({
      clock,
      scenario,
      localRepos: {
        [FAKE_REPO.localPath]: {
          isGitMainWorktree: true,
          originUrl: `https://github.com/${FAKE_REPO.github.owner}/${FAKE_REPO.github.name}.git`,
          runtimeRepoId: FAKE_REPO.runtime.orcaRepoId,
        },
      },
      readSpec: (path, sha256) => specStore.read(path, sha256),
      remoteHead: async (ref) =>
        (await scm.compareBranch(FAKE_REPO.github, ref, ref))?.headSha ?? null,
      onPush: ({ branch, base }) => {
        scm.pushBranch(FAKE_REPO.github, branch, base);
      },
      submitter: (request) => {
        if (!world.backend)
          throw new PortError('transient', 'backend_down', 'Backend down');
        return world.backend.submit(request);
      },
      submitRetryMs: 250,
    }),
  };
  const intercept = options.intercept;
  if (intercept) {
    // The backend reaches the fake Orca through this proxy; test hooks pass through.
    const target = world.runtime;
    (world as { runtime: FakeRuntime }).runtime = new Proxy(target, {
      get(object, property) {
        const value = Reflect.get(object, property, object) as unknown;
        if (typeof value !== 'function') return value;
        const bound = (value as (...a: unknown[]) => unknown).bind(object);
        if (typeof property !== 'string' || !PORT_OPERATIONS.has(property))
          return bound;
        return async (...args: unknown[]) =>
          intercept(property, args, () => bound(...args));
      },
    });
  }
  const scmIntercept = options.scmIntercept;
  if (scmIntercept) {
    const target = world.scm;
    (world as { scm: FakeScm }).scm = new Proxy(target, {
      get(object, property) {
        const value = Reflect.get(object, property, object) as unknown;
        if (typeof value !== 'function') return value;
        const bound = (value as (...a: unknown[]) => unknown).bind(object);
        if (typeof property !== 'string' || !SCM_WRITES.has(property))
          return bound;
        return async (...args: unknown[]) =>
          scmIntercept(property, args, () => bound(...args));
      },
    });
  }
  return world;
}

const SCM_WRITES = new Set([
  'ensureBranch',
  'createIssue',
  'updateIssue',
  'comment',
  'openPR',
  'updatePR',
  'mergePR',
]);

const PORT_OPERATIONS = new Set([
  'openSession',
  'reclaimSession',
  'prepareWorkspace',
  'spawnAgent',
  'send',
  'answer',
  'stop',
  'release',
  'observe',
  'closeSession',
  'disposeWorkspace',
  'findByCorrelation',
  'findCommandByMarker',
  'findWorkspace',
  'inspectRequest',
  'resolveCaller',
  'inspectWorkspace',
]);

/**
 * Wraps every RuntimePort call the backend makes: return `call()` to pass it
 * through, throw to fail it, or never settle to model a crash mid-command.
 */
export type RuntimeIntercept = (
  operation: string,
  args: unknown[],
  call: () => unknown,
) => unknown;

export type Browser = Awaited<ReturnType<typeof browser>>;

/** A logged-in browser session (bootstrap → cookie) against a running server. */
export async function browser(server: RunningServer) {
  const exchange = await fetch(server.bootstrapUrl, { redirect: 'manual' });
  if (exchange.status !== 302)
    throw new Error(`bootstrap failed: ${exchange.status}`);
  const cookie = exchange.headers.get('set-cookie')!.split(';')[0]!;
  let key = 0;
  const call = async (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(`${server.url}${path}`, {
      method,
      headers: {
        cookie,
        origin: server.url,
        ...(method === 'POST'
          ? {
              'content-type': 'application/json',
              'idempotency-key': `acceptance-${++key}-${Date.now()}`,
            }
          : {}),
        ...headers,
      },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: (text ? JSON.parse(text) : null) as Json,
    };
  };
  return { cookie, call, url: server.url };
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `read` until `ok` holds; the failure message carries the last value. */
export async function until<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline)
      throw new Error(
        `Timed out waiting for ${what}: ${JSON.stringify(value).slice(0, 2000)}`,
      );
    await sleep(25);
  }
}

/** Stage-gate decisions a test makes; return undefined to approve. */
export type GatePolicy = (
  gate: Json,
  detail: Json,
) => Json | 'skip' | undefined | Promise<Json | 'skip' | undefined>;

export interface Office {
  readonly server: RunningServer;
  readonly world: FakeWorld;
  readonly dataDir: string;
  ui: Browser;
  repoId: string;
  /** Live agents observed in the fake runtime each time a stage gate was seen open. */
  readonly stageGateChecks: { gateId: string; liveAgents: number }[];
  start(request?: Json): Promise<string>;
  readModel(workflowId: string): Promise<Json>;
  events(workflowId: string): Promise<Json[]>;
  gates(workflowId: string): Promise<Json[]>;
  decide(gate: Json, body: Json): Promise<{ status: number; body: Json }>;
  /**
   * Plays the human: approves stage gates (or applies `policy`) until `done`
   * holds. Exception gates are left to `onException`, or fail the drive.
   * `timeoutMs` bounds a stall (no new event), not the whole drive, so a slow
   * but progressing run under load does not time out.
   */
  drive(
    workflowId: string,
    done: (workflow: Json) => boolean | Promise<boolean>,
    options?: {
      policy?: GatePolicy;
      onException?: (gate: Json) => boolean | Promise<boolean>;
      timeoutMs?: number;
    },
  ): Promise<Json>;
  restart(options?: Partial<StartOptions>): Promise<void>;
  close(): Promise<void>;
}

const opened: Office[] = [];
const homes: string[] = [];

/** Closes every office and removes its home; call from `afterEach`. */
export async function closeAll(): Promise<void> {
  for (const office of opened.splice(0)) await office.close();
  for (const home of homes.splice(0)) {
    if (process.env.AIO_DEBUG_HOME) console.log('kept', home);
    else rmSync(home, { recursive: true, force: true });
  }
}

export function tempHome(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aio-acceptance-'));
  homes.push(directory);
  return directory;
}

const trace = (events: Json[]) =>
  events
    .map((e) => `${e.seq} ${e.type} ${JSON.stringify(e.payload).slice(0, 200)}`)
    .join('\n');

/** Boots the composed backend in fake mode on an ephemeral port. */
export async function office(
  options: {
    scenario?: RuntimeScenario;
    roles?: Readonly<Record<string, RoleBehavior>>;
    home?: string;
    world?: FakeWorld;
    finalMergeMs?: number;
    intercept?: RuntimeIntercept;
    scmIntercept?: RuntimeIntercept;
    mergeDelay?: (ms: number) => Promise<void>;
  } = {},
): Promise<Office> {
  const dataDir = options.home ?? tempHome();
  const world =
    options.world ??
    acceptanceWorld(dataDir, options.scenario ?? scenarioWith(options.roles), {
      ...(options.finalMergeMs === undefined
        ? {}
        : { finalMergeMs: options.finalMergeMs }),
      ...(options.intercept === undefined
        ? {}
        : { intercept: options.intercept }),
      ...(options.mergeDelay === undefined
        ? {}
        : { mergeDelay: options.mergeDelay }),
      ...(options.scmIntercept === undefined
        ? {}
        : { scmIntercept: options.scmIntercept }),
    });
  const boot = (extra: Partial<StartOptions> = {}) =>
    startServer({
      dev: true,
      fake: 'mainline',
      port: 0,
      env: { AI_OFFICE_HOME: dataDir },
      webDist: join(dataDir, 'no-web'),
      fakeWorld: world,
      print: () => undefined,
      ...extra,
    });
  let server = await boot();
  let ui = await browser(server);
  const repoId = (await ui.call('GET', '/api/v1/repos')).body.repos[0]
    .repoId as string;
  const stageGateChecks: Office['stageGateChecks'] = [];
  const self: Office = {
    get server() {
      return server;
    },
    world,
    dataDir,
    get ui() {
      return ui;
    },
    set ui(value) {
      ui = value;
    },
    repoId,
    stageGateChecks,
    async start(request = {}) {
      const started = await ui.call('POST', '/api/v1/workflows', {
        templateId: 'feature-to-pr',
        repoId,
        requirement: 'Add dark mode toggle',
        ...request,
      });
      if (started.status !== 201)
        throw new Error(
          `start failed ${started.status} ${JSON.stringify(started.body)}`,
        );
      return started.body.workflowId as string;
    },
    async readModel(workflowId) {
      return (await ui.call('GET', `/api/v1/workflows/${workflowId}`)).body
        .readModel as Json;
    },
    async events(workflowId) {
      const all: Json[] = [];
      let afterSeq = 0;
      for (;;) {
        const page = await ui.call(
          'GET',
          `/api/v1/workflows/${workflowId}/events?afterSeq=${afterSeq}&limit=1000`,
        );
        const events = page.body.events as Json[];
        all.push(...events);
        if (events.length === 0 || page.body.nextAfterSeq === undefined)
          return all;
        afterSeq = page.body.nextAfterSeq as number;
      }
    },
    async gates(workflowId) {
      const { body } = await ui.call('GET', '/api/v1/gates');
      return (body.gates as Json[]).filter((g) => g.workflowId === workflowId);
    },
    async decide(gate, body) {
      const detail = (
        await ui.call('GET', `/api/v1/gates/${encodeURIComponent(gate.gateId)}`)
      ).body;
      return ui.call(
        'POST',
        `/api/v1/gates/${encodeURIComponent(gate.gateId)}/decision`,
        { expectedVersion: detail.version, ...body },
      );
    },
    async drive(workflowId, done, driveOptions = {}) {
      const stallMs = driveOptions.timeoutMs ?? 30_000;
      let deadline = Date.now() + stallMs;
      let lastSeq = -1;
      const checked = new Set<string>();
      for (;;) {
        const workflow = await self.readModel(workflowId);
        if (await done(workflow)) return workflow;
        if (workflow.lastSeq !== lastSeq) {
          lastSeq = workflow.lastSeq as number;
          deadline = Date.now() + stallMs;
        }
        if (Date.now() > deadline)
          throw new Error(
            `Timed out at ${JSON.stringify(workflow.status)}\n${trace(await self.events(workflowId))}`,
          );
        for (const gate of await self.gates(workflowId)) {
          if (gate.status !== 'open') continue;
          if (gate.kind === 'exception') {
            if (
              driveOptions.onException &&
              (await driveOptions.onException(gate))
            )
              continue;
            throw new Error(
              `Unexpected exception gate: ${JSON.stringify(gate)}\n${trace(await self.events(workflowId))}`,
            );
          }
          // §27: no live agent in the fake runtime while a stage gate is open.
          if (!checked.has(`${gate.gateId}@${gate.version}`)) {
            checked.add(`${gate.gateId}@${gate.version}`);
            stageGateChecks.push({
              gateId: gate.gateId,
              liveAgents: liveAgents(world),
            });
          }
          if (gate.stageKind === 'final-pr') continue; // the fake owner merges it
          const detail = (
            await ui.call(
              'GET',
              `/api/v1/gates/${encodeURIComponent(gate.gateId)}`,
            )
          ).body;
          const chosen = (await driveOptions.policy?.(gate, detail)) ?? {
            decision: 'approve',
          };
          if (chosen === 'skip') continue;
          const decision = await ui.call(
            'POST',
            `/api/v1/gates/${encodeURIComponent(gate.gateId)}/decision`,
            {
              expectedVersion: detail.version,
              ...(detail.conclusion === undefined
                ? {}
                : {
                    githubBodyHash:
                      detail.conclusion.githubBodyHash ??
                      detail.conclusion.renderedHash,
                  }),
              ...chosen,
            },
          );
          // A concurrent content update bumps the version: retry next pass.
          if (decision.status >= 300 && decision.status !== 409)
            throw new Error(
              `decision ${decision.status} ${JSON.stringify(decision.body)}`,
            );
        }
        await sleep(25);
      }
    },
    async restart(extra = {}) {
      await server.close();
      server = await boot(extra);
      ui = await browser(server);
    },
    close: () => server.close(),
  };
  opened.push(self);
  return self;
}

/** Agents the fake Orca still runs (working, waiting or done-but-open). */
export const liveAgents = (world: FakeWorld): number =>
  world.runtime.activeAgents().length;

export const isEnded = (workflow: Json): boolean =>
  ['completed', 'failed', 'cancelled'].includes(workflow.status as string);

export { trace };

/** The fake agent ref (Orca dispatch) behind an attempt, from its spawn command. */
export function agentRefOf(events: Json[], attemptId: string): AgentRef {
  const spawned = events.find(
    (e) => e.type === 'seat.spawned' && e.payload.attemptId === attemptId,
  );
  const result = events.find(
    (e) =>
      e.type === 'command.succeeded' &&
      e.payload.commandId === spawned?.payload.spawnCommandId,
  );
  if (!result) throw new Error(`No spawned agent for ${attemptId}`);
  return result.payload.result.agent as AgentRef;
}

const charged = new Map<string, number>();

/**
 * Reports `tokens` more usage for an attempt through the fake session logs
 * (usage-fake), so the ObservationLoop ingests it like M2's session-log reader.
 * Codex logs carry cumulative totals; Claude logs carry per-message counts.
 */
export async function chargeUsage(
  office: Office,
  workflowId: string,
  attemptId: string,
  tokens: number,
): Promise<void> {
  const events = await office.events(workflowId);
  const spawned = events.find(
    (e) => e.type === 'seat.spawned' && e.payload.attemptId === attemptId,
  )!;
  const usage = office.world.usage;
  const key = `${office.dataDir}:${attemptId}`;
  if (!charged.has(key))
    usage.registerAttempt({
      attemptId,
      agent: spawned.payload.agent,
      dispatchId: agentRefOf(events, attemptId),
    });
  const total = (charged.get(key) ?? 0) + tokens;
  charged.set(key, total);
  usage.append(
    attemptId,
    {
      inputUncached: spawned.payload.agent === 'codex' ? total : tokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    `message-${total}`,
  );
}

/**
 * §27 invariant from the event log: when each STAGE gate opens, every attempt
 * spawned before it has been released or has exited. Exception gates are exempt.
 */
export function liveAttemptsAtStageGates(
  events: Json[],
): { gateId: string; live: string[] }[] {
  const live = new Set<string>();
  const result: { gateId: string; live: string[] }[] = [];
  for (const event of events) {
    if (event.type === 'seat.spawned') live.add(event.payload.attemptId);
    if (event.type === 'seat.released' || event.type === 'seat.exited')
      live.delete(event.payload.attemptId);
    if (event.type === 'gate.opened' && event.payload.kind === 'stage')
      result.push({ gateId: event.payload.gateId, live: [...live] });
  }
  return result;
}

/**
 * The golden view of a workflow log: the domain-significant events, with ids,
 * timestamps and SHAs removed. Observation-paced events (polls, usage, runtime
 * status and exits, command bookkeeping) are excluded because their interleaving
 * depends on wall-clock polling, not on the workflow.
 */
export function golden(events: Json[]): string[] {
  const lines: string[] = [];
  for (const { type, payload: p } of events) {
    const stage = p.stageId === undefined ? '' : ` ${p.stageId}`;
    switch (type) {
      case 'workflow.started':
      case 'workflow.completed':
        lines.push(type);
        break;
      case 'workflow.paused':
      case 'workflow.resumed':
      case 'workflow.failed':
        lines.push(`${type} ${p.reason ?? ''}`.trim());
        break;
      case 'stage.started':
        lines.push(`${type}${stage} ${p.mode}`);
        break;
      case 'stage.completed':
      case 'stage.failed':
      case 'stage.rerun_requested':
        lines.push(`${type}${stage}`);
        break;
      case 'gate.opened':
        lines.push(
          `${type}${stage} ${p.kind}${p.exceptionKind ? ` ${p.exceptionKind}` : ''}`,
        );
        break;
      case 'gate.decided':
        lines.push(
          `${type} ${p.decision}${p.optionId ? ` ${p.optionId}` : ''} by ${p.by}`,
        );
        break;
      case 'gate.closed':
        lines.push(`${type} ${p.reason}`);
        break;
      case 'meeting.round_started':
      case 'meeting.round_completed':
        lines.push(`${type} round ${p.round}`);
        break;
      case 'meeting.statement':
        lines.push(`${type} ${p.role}`);
        break;
      case 'meeting.concluded':
        lines.push(type);
        break;
      case 'submission.accepted':
        lines.push(`${type} ${p.kind}`);
        break;
      case 'workitem.proposed':
      case 'workitem.approved':
        lines.push(
          `${type} ${(p.items as Json[]).map((i) => i.key).join(',')}`,
        );
        break;
      case 'workitem.dispatched':
        lines.push(`${type} ${p.itemKey} attempt ${p.attempt}`);
        break;
      case 'workitem.status':
        lines.push(`${type} ${p.itemKey} ${p.status}`);
        break;
      case 'workitem.merge_queued':
      case 'workitem.merged':
      case 'workitem.rework_requested':
        lines.push(`${type} ${p.itemKey}`);
        break;
      case 'ondemand.started':
      case 'ondemand.stopped':
        lines.push(
          `${type}${stage} ${p.purpose}${p.reason ? ` ${p.reason}` : ''}`,
        );
        break;
      case 'message.question':
      case 'message.forwarded':
      case 'message.answered':
      case 'message.escalated':
        lines.push(type);
        break;
      default:
        break;
    }
  }
  // Participants speak concurrently: order each round's statements by role.
  const sorted: string[] = [];
  let round: string[] = [];
  for (const line of lines) {
    if (/^(meeting\.statement|submission\.accepted statement)/.test(line)) {
      round.push(line);
      continue;
    }
    sorted.push(...round.sort(), line);
    round = [];
  }
  return [...sorted, ...round.sort()];
}
