/**
 * M2-T17 live helpers: drive an isolated composed backend (`--dev --runtime
 * orca`) over its real HTTP API like the browser does. Every Orca effect goes
 * through the T8 harness ledger; each workflow's branch/worktree namespace is
 * claimed before it is started (coordinator-approved generalization of §1.4).
 * Reports carry numbers, ids and event types only — never bodies.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { OrcaHarness } from '../harness.js';
import type { Json } from './checks.js';

export type { Json };

export interface BackendHomeOptions {
  enforcement: 'on' | 'off';
  /** Extra template files (`<file>.yaml` → YAML) copied beside the built-ins. */
  templates?: Record<string, string>;
}

/** Isolated AI_OFFICE_HOME inside the private dataDir; never `~/.ai-office`. */
export async function backendHome(
  h: OrcaHarness,
  options: BackendHomeOptions,
): Promise<string> {
  const bin = process.env.AIO_ORCA_BIN;
  if (!bin) throw new Error('AIO_ORCA_BIN required');
  const home = join(h.ledger.dataDir, 'backend');
  await mkdir(home, { recursive: true, mode: 0o700 });
  // preventSleep is off: the integrator wraps the whole run in `caffeinate -i`.
  await writeFile(
    join(home, 'config.toml'),
    [
      '[orca]',
      `bin = ${JSON.stringify(bin)}`,
      'preventSleep = false',
      '[budget]',
      `enforcement = ${JSON.stringify(options.enforcement)}`,
      '',
    ].join('\n'),
    { mode: 0o600, flag: 'wx' },
  );
  if (options.templates) {
    await mkdir(join(home, 'templates'), { recursive: true, mode: 0o700 });
    for (const [file, yaml] of Object.entries(options.templates))
      await writeFile(join(home, 'templates', file), yaml, { mode: 0o600 });
  }
  return home;
}

export interface Api {
  call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Json }>;
}

/** A logged-in browser session (bootstrap → cookie). */
export async function session(url: string, bootstrapUrl: string): Promise<Api> {
  const exchange = await fetch(bootstrapUrl, { redirect: 'manual' });
  if (exchange.status !== 302)
    throw new Error(`bootstrap failed: ${exchange.status}`);
  const cookie = exchange.headers.get('set-cookie')!.split(';')[0]!;
  let key = 0;
  return {
    async call(method, path, body) {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: {
          cookie,
          origin: url,
          ...(method === 'POST'
            ? {
                'content-type': 'application/json',
                'idempotency-key': `t17-${++key}-${Date.now()}`,
              }
            : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: (text ? JSON.parse(text) : null) as Json,
      };
    },
  };
}

const must = async (
  pending: Promise<{ status: number; body: Json }>,
  what: string,
) => {
  const r = await pending;
  if (r.status >= 300)
    throw new Error(`${what} failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

export async function registerRepo(api: Api, localPath: string) {
  const listed = (await must(api.call('GET', '/api/v1/repos'), 'list repos'))
    .repos as Json[];
  const known = listed.find((r) => r.localPath === localPath);
  if (known) return known.repoId as string;
  return (
    await must(api.call('POST', '/api/v1/repos', { localPath }), 'register')
  ).repoId as string;
}

/**
 * Journals the namespace intent, starts the workflow, then binds its shortId.
 * `onBound` resolves the gate that held SCM writes until the claim existed.
 */
export async function startWorkflow(
  h: OrcaHarness,
  api: Api,
  request: Json,
  onBound: (shortId: string) => void = () => undefined,
): Promise<{ workflowId: string; shortId: string }> {
  const bind = await h.claimWorkflowNamespace();
  const { workflowId } = await must(
    api.call('POST', '/api/v1/workflows', request),
    'start workflow',
  );
  const shortId = (await readModel(api, workflowId)).shortId as string;
  await bind(shortId);
  onBound(shortId);
  return { workflowId, shortId };
}

export async function readModel(api: Api, workflowId: string): Promise<Json> {
  return (
    await must(api.call('GET', `/api/v1/workflows/${workflowId}`), 'read')
  ).readModel as Json;
}

export async function events(api: Api, workflowId: string): Promise<Json[]> {
  const all: Json[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = await must(
      api.call(
        'GET',
        `/api/v1/workflows/${workflowId}/events?afterSeq=${afterSeq}&limit=1000`,
      ),
      'events',
    );
    all.push(...(page.events as Json[]));
    if (!(page.events as Json[]).length || page.nextAfterSeq === undefined)
      return all;
    afterSeq = page.nextAfterSeq as number;
  }
}

export async function gates(api: Api, workflowId: string): Promise<Json[]> {
  return (
    (await must(api.call('GET', '/api/v1/gates'), 'gates')).gates as Json[]
  ).filter((g) => g.workflowId === workflowId);
}

/** Approves (or edits) a stage gate as the owner would in the UI. */
export async function decide(api: Api, gate: Json, body: Json = {}) {
  const detail = await must(
    api.call('GET', `/api/v1/gates/${encodeURIComponent(gate.gateId)}`),
    'gate detail',
  );
  return api.call(
    'POST',
    `/api/v1/gates/${encodeURIComponent(gate.gateId)}/decision`,
    {
      decision: 'approve',
      expectedVersion: detail.version,
      ...(detail.conclusion === undefined
        ? {}
        : {
            githubBodyHash:
              detail.conclusion.githubBodyHash ??
              detail.conclusion.renderedHash,
          }),
      ...body,
    },
  );
}

/** The backend's Orca run (SessionRef), adopted into the ledger once known. */
export async function adoptRun(
  h: OrcaHarness,
  api: Api,
  workflowId: string,
): Promise<string | undefined> {
  for (const e of await events(api, workflowId)) {
    if (e.type !== 'command.succeeded') continue;
    const p = e.payload as Json;
    if (p.kind !== 'runtime.openSession') continue;
    const run = (p.result?.session ?? p.result?.result?.session) as unknown;
    if (typeof run === 'string') {
      await h.adoptBackendRun(run);
      return run;
    }
  }
  return undefined;
}

/** Orca workers of an adopted run that are not released yet (level A read). */
export async function liveWorkers(h: OrcaHarness, run: string) {
  const { workers } = await h.command([
    'orchestration',
    'worker-list',
    '--run',
    run,
    '--json',
    '--full',
  ]);
  return (workers as Json[])
    .filter((w) => w.terminalState !== 'released')
    .map((w) => ({
      dispatchId: String(w.dispatchId),
      workerState: String(w.workerState),
      terminalState: String(w.terminalState),
    }));
}

export interface DriveRecord {
  /** Stage gates seen open, with the live (unreleased) Orca workers at that moment. */
  stageGates: {
    gateId: string;
    stageKind: string;
    live: { dispatchId: string; workerState: string; terminalState: string }[];
  }[];
  cliCallsPerMinute: number[];
  exceptions: { gateId: string; exceptionKind: string }[];
}

/**
 * Plays the owner until `done`: stage gates go to `onStageGate` (return true
 * when handled), exception gates to `onException` (return true when handled;
 * otherwise the drive fails with the event types). The stall timeout restarts
 * on every new event, so slow real agents never trip it while progressing.
 */
export async function drive(
  h: OrcaHarness,
  api: Api,
  workflowId: string,
  done: (workflow: Json) => boolean,
  options: {
    run: () => string | undefined;
    onStageGate?: (gate: Json) => Promise<boolean>;
    onException?: (gate: Json) => Promise<boolean>;
    stallMs?: number;
    record: DriveRecord;
  },
): Promise<Json> {
  const stallMs = options.stallMs ?? 25 * 60_000;
  let deadline = Date.now() + stallMs;
  let lastSeq = -1;
  let lastHealth = 0;
  const seen = new Set<string>();
  for (;;) {
    const workflow = await readModel(api, workflowId);
    if (done(workflow)) return workflow;
    if (workflow.lastSeq !== lastSeq) {
      lastSeq = workflow.lastSeq as number;
      deadline = Date.now() + stallMs;
    }
    if (Date.now() > deadline)
      throw new Error(
        `T17 drive stalled at ${JSON.stringify(workflow.status)}: ${(
          await events(api, workflowId)
        )
          .slice(-60)
          .map((e) => `${e.seq} ${e.type}`)
          .join(', ')}`,
      );
    if (Date.now() - lastHealth > 15_000) {
      lastHealth = Date.now();
      const health = (await api.call('GET', '/api/v1/health')).body;
      const cpm = health?.runtime?.cliCallsPerMinute;
      if (typeof cpm === 'number') options.record.cliCallsPerMinute.push(cpm);
    }
    for (const gate of await gates(api, workflowId)) {
      if (gate.status !== 'open') continue;
      const key = `${gate.gateId}@${gate.version}`;
      if (gate.kind === 'exception') {
        if (!seen.has(key)) {
          seen.add(key);
          options.record.exceptions.push({
            gateId: gate.gateId,
            exceptionKind: gate.exceptionKind,
          });
        }
        if (await options.onException?.(gate)) continue;
        throw new Error(
          `Unexpected exception gate ${gate.exceptionKind}: ${(
            await events(api, workflowId)
          )
            .slice(-60)
            .map((e) => `${e.seq} ${e.type}`)
            .join(', ')}`,
        );
      }
      if (!seen.has(key)) {
        seen.add(key);
        const run = options.run();
        options.record.stageGates.push({
          gateId: gate.gateId,
          stageKind: gate.stageKind,
          live: run ? await liveWorkers(h, run) : [],
        });
      }
      if (await options.onStageGate?.(gate)) continue;
      const decided = await decide(api, gate);
      if (decided.status >= 300 && decided.status !== 409)
        throw new Error(
          `decision ${decided.status} ${JSON.stringify(decided.body)}`,
        );
    }
    await delay(2_000);
  }
}

/** Private 0600 numeric report next to the ledger; a summary goes to stdout. */
export async function writeReport(
  h: OrcaHarness,
  name: string,
  report: Json,
): Promise<void> {
  const path = join(h.ledger.dataDir, `t17-${name}.json`);
  await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.info(`T17 ${name} report: ${path}\n${JSON.stringify(report)}`);
}

/** Collects failed expectations so the report is always written first. */
export class Expectations {
  readonly failures: string[] = [];
  that(ok: boolean, what: string): void {
    if (!ok) this.failures.push(what);
  }
  assert(): void {
    if (this.failures.length)
      throw new Error(
        `T17 expectations failed:\n- ${this.failures.join('\n- ')}`,
      );
  }
}
