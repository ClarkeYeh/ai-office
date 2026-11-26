import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Recording } from './recording.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractWorld, RUN, SHA, REPO } from './contract-world.js';
import type { RuntimeContractFixture } from '../runtime-port-contract.js';
import {
  CwdGuard,
  DefaultOrcaCli,
  DefaultGitCli,
  DispatchLedger,
  ShimCoordinatorIdentity,
  createOrcaRuntime,
  sessionRef,
  workspaceRef,
} from '../../adapters/runtime-orca/index.js';
import { CliScheduler } from '../../adapters/runtime-orca/cli/scheduler.js';
import {
  OrcaObserver,
  uuidV5,
} from '../../adapters/runtime-orca/observe/index.js';

export async function orcaReplayFixture(
  options: { maxCallsPerMinute?: number; tape?: string } = {},
) {
  if (process.env.CI && process.env.AIO_T9_UPDATE === '1')
    throw new Error('CI must replay committed expectations');
  const world = await ContractWorld.create();
  const tapeUrl = options.tape
    ? new URL(
        '../../../../../fixtures/orca/1.4.259/contract/synthetic/' +
          createHash('sha256').update(options.tape).digest('hex').slice(0, 12) +
          '.json',
        import.meta.url,
      )
    : undefined;
  if (tapeUrl && process.env.AIO_T9_UPDATE !== '1')
    world.loadTape(
      JSON.parse(await readFile(tapeUrl, 'utf8')) as Record<
        string,
        Recording[]
      >,
    );
  const dataDir = await mkdtemp(join(tmpdir(), 'aio-contract-'));
  const data = new Map<string, unknown>();
  const state = {
    read: (k: string) => structuredClone(data.get(k) ?? null),
    write: (k: string, v: unknown) => {
      data.set(k, structuredClone(v));
    },
  };
  state.write('orca:sessions', { [RUN]: REPO });
  state.write('orca:shim', {
    v: 1,
    handle: world.shim,
    incarnationId: null,
    location: REPO.localPath,
    history: [world.shim],
    runs: { [RUN]: { handle: world.shim, generation: 1, hijacked: false } },
  });
  const cwdGuard = new CwdGuard(dataDir, async () => []);
  const scheduler = new CliScheduler(
    options.maxCallsPerMinute ?? 10000,
    4,
    () => world.now,
  );
  const cli: DefaultOrcaCli = new DefaultOrcaCli({
    bin: '/synthetic/orca',
    env: {},
    exec: world,
    cwdGuard,
    scheduler,
    identity: { argsFor: (...args) => identity.argsFor(...args) },
  });
  const identity = new ShimCoordinatorIdentity({
    cli,
    state,
    dataDir,
    shimLocation: 'repo-main-worktree',
    repoMainWorktree: REPO.localPath,
    now: () => world.now,
  });
  const ledger = new DispatchLedger(state);
  const makeObserver = () =>
    new OrcaObserver({
      cli,
      identity,
      ledger,
      now: () => world.now,
      wait: async () => {
        await new Promise<void>((resolve) => {
          if (world.longPoll) setImmediate(resolve);
        });
      },
    });
  let observer = makeObserver();
  const runtime = createOrcaRuntime({
    cli,
    identity,
    ledger,
    state,
    git: new DefaultGitCli({ exec: world, cwdGuard, env: {} }),
    dataDir,
    logger: { info() {} },
    ids: { orcaRequestId: (id) => uuidV5(id) },
    version: { check: async () => ({ version: '1.4.259', verified: true }) },
    now: () => world.now,
    observer: {
      observe: async (session, cursor) => {
        // A contract observation is the next scheduled 2 s poll. Timer stimuli use
        // elapsed time separately so 119999 + 1 ms remains an exact boundary.
        world.now += 2000;
        await world.spawnEntered;
        return observer.observe(session, cursor);
      },
      expectChange: () => observer.expectChange(),
    },
  });
  const session = sessionRef(RUN);
  const fixture: RuntimeContractFixture = {
    runtime,
    session,
    prepareRequest: {
      session,
      repo: REPO,
      baseBranch: SHA,
      baseSha: SHA,
      fetchBranch: 'main',
      name: 'worker',
      branch: 'ai-office/worker',
      correlation: { workflowId: 'wf', commandId: 'prepare' },
    },
    reworkRequest: {
      session,
      repo: REPO,
      baseBranch: SHA,
      fetchBranch: 'ai-office/rework',
      name: 'rework-r1',
      branch: 'ai-office/rework',
      checkoutExisting: true,
      correlation: { workflowId: 'wf', commandId: 'prepare-rework' },
    },
    spawnRequest: {
      session,
      agent: 'codex',
      title: 'Contract',
      prompt: '[synthetic specification]',
      workspace: {
        kind: 'existing-worktree',
        workspace: workspaceRef('wt_existing'),
        readOnly: false,
      },
      keepOpen: true,
      correlation: { workflowId: 'wf', commandId: 'spawn' },
    },
    advance: (ms) => {
      world.switchSegment(`advance:${ms}`);
      world.advance(ms);
    },
    detachWorkspace: (workspace, shape) => {
      world.switchSegment('detach:' + shape);
      const w = world.workspaces.find((w) => w.id === workspace)!;
      const branch = w.branch.replace('refs/heads/', '');
      const tip = 'd'.repeat(40);
      w.branch = '';
      w.head = tip;
      if (shape === 'worker') world.branches.set(branch, tip);
      if (shape !== 'unpushed') world.originTips.add(tip);
    },
    identity: (agent) => ({
      terminalHandle: `term_${agent}`,
      paneKey: 'pane_contract',
    }),
    stimulus: async (agent, action) => {
      world.switchSegment(action);
      if (action === 'identity-lost') {
        world.identityLost = true;
        world.now += 30001;
      }
      if (action === 'hijack') {
        world.owner = 'term_foreign';
        world.generation++;
        world.now += 30001;
      }
      if (action === 'response-lost') world.lost = true;
      if (action === 'spawn-in-flight') world.armSpawn();
      if (action === 'done') world.post(agent, 'worker_done');
      if (action === 'ask-with-false-escalation') {
        world.post(agent, 'question');
        world.post(agent, 'escalation');
      }
      if (action === 'turn-start-unobserved') world.post(agent, 'escalation');
      if (action === 'rate-limited')
        world.workers.find((w) => w.dispatchId === agent)!.wait = {
          kind: 'rate_limit',
        };
      if (action === 'receipt-absent-after-consume') {
        for (const m of world.mail) m.read = true;
        observer.close();
        observer = makeObserver();
      }
      // Timeout after consume: the caller retains its cursor; recovery must use
      // the inbox even though the check response never reached the backend.
      if (action === 'check-timeout') {
        world.checkTimeout = true;
        observer.close();
        observer = makeObserver();
      }
    },
    dispose: async () => {
      if (tapeUrl && process.env.AIO_T9_UPDATE === '1') {
        await mkdir(new URL('.', tapeUrl), { recursive: true });
        await writeFile(
          tapeUrl,
          JSON.stringify(world.segments, null, 2) + '\n',
        );
      }
      try {
        world.assertConsumed();
      } finally {
        world.advance(0);
        observer.close();
        scheduler.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  };
  return { ...fixture, world, observer, scheduler };
}
