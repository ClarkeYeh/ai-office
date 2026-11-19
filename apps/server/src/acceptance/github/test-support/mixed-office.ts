import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer } from '../../../main.js';
import type { ScmPort } from '../../../ports/scm.js';
import type { GitPusher } from '../../../test-support/github/pusher.js';
import type { OwnerActions } from '../../../test-support/github/owner-actions.js';
import { scopeGithubScm } from '../../../test-support/github/scoped-scm.js';
import { createGithubWorldBridge } from '../../../test-support/github/fake-world-bridge.js';
import {
  browser,
  sleep,
  trace,
  type Browser,
  type Json,
} from '../../test-support/harness.js';

export const SPIKE = { owner: 'ClarkeYeh', name: 'ai-office-spike' } as const;
export const SPIKE_LOCAL = {
  localPath: '/fake/repos/ai-office-spike',
  runtime: {
    orcaRepoId: 'fake-repo-ai-office-spike',
    localPath: '/fake/repos/ai-office-spike',
  },
  github: SPIKE,
} as const;

/** Everything that differs between the live spike run and its CI twin. */
export interface MixedBinding {
  mode: 'live' | 'fake';
  /** The unscoped adapter: scm-github over the T7 transport, or scm-fake. */
  scm: ScmPort;
  runId: string;
  pusher: Pick<GitPusher, 'push'>;
  owner: OwnerActions;
  /** Upper bound for one waiting step (live GitHub polls every 15 s). */
  stepTimeoutMs: number;
  /**
   * Live only: the SPEC §12.2 poll cadence. `--fake` assembly polls the SCM
   * every 250 ms even with an injected scm-github (reported product defect),
   * so the harness answers "no change" with the same cursor in between.
   */
  scmPollIntervalMs?: number;
  /** Step 12 fault injection, below the adapter boundary where possible. */
  faults?: {
    /** The next createIssue succeeds but its response is lost; new rows list late. */
    loseNextCreateIssue(listLagMs: number): void;
    /** Every SCM call fails transiently until restored (opens the breaker). */
    setScmDown(down: boolean): void;
    isScmDown(): boolean;
  };
}

export interface MixedOffice {
  readonly server: RunningServer;
  readonly ui: Browser;
  readonly scm: ScmPort;
  readonly binding: MixedBinding;
  readonly repoId: string;
  start(): Promise<string>;
  readModel(workflowId: string): Promise<Json>;
  events(workflowId: string): Promise<Json[]>;
  gates(workflowId: string): Promise<Json[]>;
  detail(gate: Json): Promise<Json>;
  decision(gate: Json, body: Json): Promise<{ status: number; body: Json }>;
  liveAgents(): number;
  close(): Promise<void>;
}

/**
 * `--dev --fake github-mainline` with `testOnly.scm` (scm-github README
 * "Mixed GitHub scenario assembly"): the shortId is the run ID, so branches,
 * titles and markers land in the T7 test namespace.
 */
export async function mixedOffice(binding: MixedBinding): Promise<MixedOffice> {
  const shortId = binding.runId;
  const scm = scopeGithubScm(
    throttlePoll(
      binding.scm,
      binding.scmPollIntervalMs,
      () => binding.faults?.isScmDown() ?? false,
    ),
    binding.runId,
    shortId,
  );
  const bridge = createGithubWorldBridge({
    scm,
    repo: SPIKE,
    runId: binding.runId,
    shortId,
    pusher: binding.pusher,
  });
  const home = mkdtempSync(join(tmpdir(), 'aio-github-acceptance-'));
  let server: RunningServer;
  try {
    server = await startServer({
      dev: true,
      fake: 'github-mainline',
      port: 0,
      env: { AI_OFFICE_HOME: home },
      webDist: join(home, 'no-web'),
      print: () => undefined,
      testOnly: {
        scm,
        shortId,
        fakeRepo: SPIKE_LOCAL,
        fakeRuntime: {
          onPush: bridge.onPush,
          remoteHead: bridge.remoteHead,
          refreshHeadAfterPush: bridge.refreshHeadAfterPush,
        },
      },
    });
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
  const ui = await browser(server);
  const repoId = (await ui.call('GET', '/api/v1/repos')).body.repos[0]
    .repoId as string;
  const self: MixedOffice = {
    server,
    ui,
    scm,
    binding,
    repoId,
    async start() {
      const started = await ui.call('POST', '/api/v1/workflows', {
        templateId: 'feature-to-pr',
        repoId,
        requirement: 'Add a synthetic dark mode toggle (T15 mixed acceptance)',
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
    async detail(gate) {
      return (
        await ui.call('GET', `/api/v1/gates/${encodeURIComponent(gate.gateId)}`)
      ).body;
    },
    decision: (gate, body) =>
      ui.call(
        'POST',
        `/api/v1/gates/${encodeURIComponent(gate.gateId)}/decision`,
        body,
      ),
    liveAgents: () => server.fakeWorld?.runtime.activeAgents().length ?? 0,
    async close() {
      try {
        await server.close();
      } finally {
        if (process.env.AIO_DEBUG_HOME) console.log('kept', home);
        else rmSync(home, { recursive: true, force: true });
      }
    },
  };
  return self;
}

/** Polls until `ok`; the error carries the workflow trace (no GitHub bodies). */
export async function waitFor<T>(
  o: MixedOffice,
  workflowId: string,
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  what: string,
  timeoutMs = o.binding.stepTimeoutMs,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline)
      throw new Error(
        `Timed out waiting for ${what}\n${trace(await o.events(workflowId))}`,
      );
    await sleep(o.binding.mode === 'live' ? 1000 : 25);
  }
}

/** Real polls at most once per interval; in between, the unchanged cursor. */
// During an injected outage every poll reaches the adapter and fails: a
// throttled "no change" would count as a success and reset the breaker streak.
export function throttlePoll(
  scm: ScmPort,
  intervalMs?: number,
  bypass: () => boolean = () => false,
): ScmPort {
  if (intervalMs === undefined) return scm;
  let last = 0;
  const poll: ScmPort['poll'] = async (repo, cursor) => {
    if (cursor !== null && !bypass() && Date.now() - last < intervalMs)
      return { events: [], cursor };
    last = Date.now();
    return scm.poll(repo, cursor);
  };
  return new Proxy(scm, {
    get(target, key) {
      if (key === 'poll') return poll;
      const value = Reflect.get(target, key) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
