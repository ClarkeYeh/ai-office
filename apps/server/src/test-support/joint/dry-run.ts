/**
 * M5-T7 PART 2: the offline dry run (M5_PLAN §5 T7 acceptance). The joint
 * harness's full control flow against the real CLI in fake mode,
 * `ai-office start --dev --fake m5-mainline`, on an isolated home and fixed
 * port: the scripted owner policy (split revise, held code-name answer), the
 * ONE `kill -9` of the server process (K at the first mul/sub mergePR, K′ at
 * the docs spawn) and the same-home same-port restart — the fake world
 * survives through its private checkpoint — the restart assertions, the B4
 * export to a private directory, the T10 checker on the masked export, the
 * owner cleanup and a leftover scan of the fake world. No GitHub, no Orca.
 *
 * What the fake world cannot judge is n/a with a reason (`DRY_RUN_NA`, plus
 * missing Orca/lock observations in the restart assertions).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FAKE_REPO } from '../../main.js';
import type { Json } from '../orca/t17/office.js';
import { mainlineTemplates } from './scenario/index.js';
import {
  freePort,
  pinPort,
  productionLauncher,
  writeTemplates,
} from './backends.js';
import { drill, type JointPaths, type Mode, type Side } from './run.js';

/** Checker rows the standalone fake world cannot judge, with the reason. */
export const DRY_RUN_NA: Record<string, string> = {
  'nf.cpu': 'no Orca CLI offline; the T7 sampler measures it in T11b/T12',
  'nf.fps': 'UI scale: M4 load-10 and T17 e2e:fps',
  'nf.auth': 'request rejection is covered by CI API tests',
  'nf.boundaries': 'covered by the CI DoD',
  'nf.coverage': 'covered by the CI DoD',
  'nf.approve-comment': 'no GitHub Issue in the fake world (live: T12)',
  'v01.worker-list':
    'no Orca worker-list offline; nf.stage-gate-agents judges the same invariant from events',
  'v01.conflict':
    'the standalone --fake m5-mainline world has no textual-conflict model (scm-fake); the T9 acceptance judges it with its conflict binding',
  'v01.usage':
    'the standalone fake world reports no token usage; the T9 acceptance injects usage samples in-process',
  'x.engine-replay': 'optional; not implemented by T10',
};

interface FakeSnapshot {
  runtime: {
    agents: { state: string }[];
    workspaces: unknown[];
  };
  scm: {
    repos: [
      string,
      {
        branches: [string, string][];
        parents: [string, string[]][];
        objects: [number, { state: string; body: string; kind: string }][];
      },
    ][];
  };
}

/** The backend's private fake-world checkpoint (written at most once a second). */
async function fakeWorld(home: string): Promise<FakeSnapshot> {
  // Let the coalesced checkpoint catch up with the last change.
  await delay(1_500);
  const envelope = JSON.parse(
    await readFile(join(home, 'data', 'fake-world.json'), 'utf8'),
  ) as { payload: string };
  return JSON.parse(envelope.payload) as FakeSnapshot;
}

const repoOf = (world: FakeSnapshot) => world.scm.repos[0]![1];

/**
 * Waits for the next fake-world checkpoint write (at most one a second).
 * With the fake runtime disconnected, observe mints no new cursor, so the
 * next checkpoint holds the cursor the backend last stored.
 */
export async function nextCheckpoint(
  home: string,
  options: { maxMs?: number; pollMs?: number } = {},
): Promise<number> {
  const path = join(home, 'data', 'fake-world.json');
  const started = Date.now();
  const text = await readFile(path, 'utf8').catch(() => '');
  for (;;) {
    if (Date.now() - started > (options.maxMs ?? 10_000))
      throw new Error('No fake-world checkpoint was written');
    await delay(options.pollMs ?? 20);
    if ((await readFile(path, 'utf8').catch(() => '')) !== text)
      return Date.now() - started;
  }
}

/** First-parent merges of implement, oldest first (from the last merge back). */
export function firstParents(log: Json[], world: FakeSnapshot): string[] {
  const parents = new Map(repoOf(world).parents);
  const merged = log.filter((e) => e.type === 'workitem.merged');
  const base = log.find(
    (e) => e.type === 'workitem.dispatched' && e.payload.itemKey === 'core',
  )?.payload.baseSha as string | undefined;
  const chain: string[] = [];
  let head = merged.at(-1)?.payload.mergeCommitSha as string | undefined;
  for (let i = 0; head && head !== base && i < 50; i++) {
    chain.unshift(head);
    head = parents.get(head)?.[0];
  }
  return chain;
}

/** Ancestry of every dependency merge in each downstream dispatch base. */
export function ancestry(log: Json[], world: FakeSnapshot) {
  const parents = new Map(repoOf(world).parents);
  const isAncestor = (sha: string, head: string, depth = 0): boolean =>
    sha === head ||
    (depth < 200 &&
      (parents.get(head) ?? []).some((p) => isAncestor(sha, p, depth + 1)));
  const merges = log
    .filter((e) => e.type === 'workitem.merged')
    .map((e) => String(e.payload.mergeCommitSha));
  return log
    .filter(
      (e) =>
        e.type === 'workitem.dispatched' && e.payload.baseSha !== undefined,
    )
    .flatMap((d) =>
      merges.map((commit) => ({
        baseSha: String(d.payload.baseSha),
        commit,
        isAncestor: isAncestor(commit, String(d.payload.baseSha)),
      })),
    );
}

/**
 * Fake-world leftovers after the owner cleanup (counts only). Workspaces
 * count only when one of our `prepareWorkspace` commands created them; the
 * fake runtime's own scratch worktrees (the planner's) are reported apart.
 */
export function leftovers(world: FakeSnapshot, log: Json[] = []) {
  const repo = repoOf(world);
  const ours = new Set(
    log
      .filter(
        (e) =>
          e.type === 'command.succeeded' &&
          e.payload.kind === 'runtime.prepareWorkspace',
      )
      .map((e) => String(e.payload.result?.workspace)),
  );
  const workspaces = (world.runtime.workspaces as [string, unknown][]).map(
    ([id]) => id,
  );
  return {
    liveAgents: world.runtime.agents.filter((a) =>
      ['working', 'waiting_input', 'done'].includes(a.state),
    ).length,
    workspaces: workspaces.filter((id) => ours.has(id)).length,
    untrackedFakeWorkspaces: workspaces.filter((id) => !ours.has(id)).length,
    openPrs: repo.objects.filter(
      ([, o]) => o.kind === 'pr' && o.state === 'open',
    ).length,
    // Issues stay open by design (SPEC: retained); the live janitors close them.
    openIssues: repo.objects.filter(
      ([, o]) => o.kind === 'issue' && o.state === 'open',
    ).length,
    workerBranches: repo.branches.filter(([name]) =>
      /^ai-office\/[^/]+\/[^/]+$/.test(name),
    ).length,
  };
}

const fakeSide: Side = {
  repoPath: FAKE_REPO.localPath,
  async startWorkflow(api, request, onBound) {
    const started = await api.call('POST', '/api/v1/workflows', request);
    if (started.status !== 201)
      throw new Error(`start workflow ${started.status}`);
    const workflowId = String(started.body.workflowId);
    const shortId = String(
      (await api.call('GET', `/api/v1/workflows/${workflowId}`)).body?.readModel
        ?.shortId,
    );
    onBound(shortId);
    return { workflowId, shortId };
  },
  adoptRun: async () => undefined,
  liveAgents: async () => undefined,
  shims: async () => undefined,
  worktrees: async () => undefined,
  checkGroups: async () => undefined,
  inbox: async () => undefined,
  runs: () => undefined,
};

/**
 * One dry run in `home` (an empty private directory outside the repo).
 * Returns the private report; reports and exports land in `paths`.
 */
export async function runDryRun(
  home: string,
  paths: JointPaths,
): Promise<Json> {
  const port = await freePort();
  await writeFile(
    join(home, 'config.toml'),
    '[budget]\nenforcement = "off"\n',
    { mode: 0o600 },
  );
  await pinPort(home, port);
  await writeTemplates(home, await mainlineTemplates());
  const mode: Mode = {
    kind: 'dry',
    side: fakeSide,
    pollMs: 200,
    sampleLocks: false,
    preventSleepChild: false,
    checkerNa: DRY_RUN_NA,
    home,
    launcher: productionLauncher({
      home,
      port,
      args: ['--dev', '--fake', 'm5-mainline'],
    }),
    afterFirstStart: async () => undefined,
    importObjects: async () => undefined,
    integrationFile: async () => undefined,
    onShortId: async () => undefined,
    async finalPr(_gate, _log, finalPr, api) {
      if (finalPr === undefined) throw new Error('Fake final PR not opened');
      // The fake owner's explicit merge (the dev endpoint), never the backend.
      const merged = await api.call('POST', '/dev/fake/scm/merge-final-pr', {
        number: finalPr,
      });
      if (merged.status >= 300) throw new Error(`fake merge ${merged.status}`);
    },
    async scmFacts(log) {
      const world = await fakeWorld(home);
      const markerCounts: Record<string, number> = {};
      for (const [, o] of repoOf(world).objects) {
        const id = /ai-office:cmd=([^ ]+?) -->/.exec(o.body)?.[1];
        if (id) markerCounts[id] = (markerCounts[id] ?? 0) + 1;
      }
      return {
        integrationFirstParents: firstParents(log, world),
        markerCounts,
      };
    },
    async checkerFacts(log) {
      return { ancestry: ancestry(log, await fakeWorld(home)) };
    },
    // A kill -9 loses up to the last second of the in-memory fake world
    // (coalesced checkpoint), and each observe poll mints a new cursor the
    // backend stores. Disconnecting the fake runtime (dev endpoint) freezes the
    // cursor; the next checkpoint then matches the backend. Real Orca keeps
    // no such cache, so live modes kill without this.
    async beforeKill(api) {
      const off = await api.call('POST', '/dev/fake/runtime/connected', {
        connected: false,
      });
      if (off.status >= 300) throw new Error(`disconnect ${off.status}`);
      return nextCheckpoint(home);
    },
    async afterRestart(api) {
      const on = await api.call('POST', '/dev/fake/runtime/connected', {
        connected: true,
      });
      if (on.status >= 300) throw new Error(`reconnect ${on.status}`);
    },
    async janitor(log) {
      // The owner cleanup disposes asynchronously: give it a few checkpoints.
      const deadline = Date.now() + 15_000;
      for (;;) {
        const counts = leftovers(await fakeWorld(home), log);
        if (
          (counts.workspaces === 0 && counts.liveAgents === 0) ||
          Date.now() > deadline
        )
          return counts;
      }
    },
    dispose: async () => undefined,
  };
  return drill(mode, paths);
}
