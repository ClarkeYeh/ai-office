import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ExternalCommand } from '@ai-office/contracts/events';
import { decide, initialState } from '@ai-office/domain';
import { external, internal } from '@ai-office/engine';
import type { SpawnEffect } from '@ai-office/engine';
import { FakeRuntime } from '../../adapters/runtime-fake/index.js';
import { FakeScm } from '../../adapters/scm-fake/index.js';
import { openSqliteStores } from '../../adapters/store-sqlite/index.js';
import { FsSpecStore } from '../../adapters/system/spec-store.js';
import { SystemIdGen } from '../../adapters/system/identity.js';
import {
  FakeClock,
  ManualScheduler,
  MemoryLogger,
} from '../../test-support/services.js';
import type { EventStore } from '../../ports/stores.js';
import { CommandExecutor, portHandlers } from '../commands/executor.js';
import type { CommandHandlers } from '../commands/executor.js';
import { WorkflowRunners } from '../runner/runners.js';
import { REACTION_CURSOR } from '../runner/workflow-runner.js';
import type { RunnerReact } from '../runner/workflow-runner.js';
import {
  flush,
  lifecycleReact,
  startWorkflow,
  WORKFLOW_ID,
} from '../runner/test-support/harness.js';
import { Reconciler } from './reconciler.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanup
    .splice(0)
    .reverse()
    .forEach((f) => f());
});
const repo = { owner: 'octo', name: 'demo' };
const runtimeRepo = { orcaRepoId: 'orca-repo-1', localPath: '/repos/demo' };
const correlation = (commandId: string) => ({
  workflowId: WORKFLOW_ID,
  commandId,
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'aio-reconcile-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const clock = new FakeClock('2026-11-17T00:00:00.000Z');
  const ids = new SystemIdGen(clock);
  const filename = join(dir, 'events.db');
  const open = () => {
    const stores = openSqliteStores({
      filename,
      clock,
      ids,
      projectionVersion: 1,
    });
    cleanup.push(stores.close);
    return stores;
  };
  let stores = open();
  const specStore = new FsSpecStore(dir);
  const runtime = new FakeRuntime({ clock });
  const scm = new FakeScm({ clock });
  scm.addRepo(repo);
  await scm.ensureBranch(
    repo,
    'ai-office/integration',
    'main',
    correlation('base'),
  );
  await scm.ensureBranch(
    repo,
    'ai-office/worker',
    'ai-office/integration',
    correlation('worker'),
  );
  const session = await runtime.openSession({
    workflowId: WORKFLOW_ID,
    repo: runtimeRepo,
    objective: 'test',
    correlation: correlation('setup-session'),
  });
  const workspace = await runtime.prepareWorkspace({
    session,
    repo: runtimeRepo,
    baseBranch: 'main',
    name: 'setup',
    branch: 'ai-office/setup',
    correlation: correlation('setup-workspace'),
  });
  const handlers = () => portHandlers({ runtime, scm, specStore });
  const build = (
    react: RunnerReact,
    overrides: CommandHandlers = {},
    store: EventStore = stores.events,
  ) => {
    const scheduler = new ManualScheduler(clock, (t) => runners.onTimer(t));
    const executor = new CommandExecutor({
      handlers: { ...handlers(), ...overrides },
      scheduler,
      clock,
      logger: new MemoryLogger(),
    });
    const runners = new WorkflowRunners({
      store,
      executor,
      scheduler,
      clock,
      ids,
      logger: new MemoryLogger(),
      seatTokens: stores.seatTokens,
      specStore,
      cliPath: '/opt/ai-office/apps/cli/dist/main.js',
      react,
    });
    return { runners, scheduler, executor };
  };
  const restart = (react: RunnerReact) => {
    stores.close();
    stores = open();
    const next = build(react);
    next.runners.recover();
    return next;
  };
  const reconciler = () => new Reconciler({ runtime, scm, specStore, clock });
  return {
    dir,
    filename,
    clock,
    ids,
    specStore,
    runtime,
    scm,
    session,
    workspace,
    build,
    restart,
    handlers,
    reconciler,
    get stores() {
      return stores;
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function commandFor(
  f: Fixture,
  kind: 'spawn' | 'issue' | 'pr' | 'merge' | 'workspace',
): Promise<ExternalCommand> {
  switch (kind) {
    case 'spawn': {
      const spec = f.specStore.write('attempt', 'Test spec');
      return {
        kind: 'runtime.spawnAgent',
        args: {
          session: f.session,
          agent: 'codex',
          title: 'aio:recover',
          specPath: spec.path,
          specSha256: spec.sha256,
          workspace: {
            kind: 'existing-worktree',
            workspace: f.workspace.workspace,
            readOnly: false,
          },
          keepOpen: true,
        },
      };
    }
    case 'issue':
      return {
        kind: 'scm.createIssue',
        args: { repo, title: 'Issue', body: 'body', labels: [] },
      };
    case 'pr':
      return {
        kind: 'scm.openPR',
        args: {
          repo,
          title: 'Worker PR',
          body: '',
          base: 'ai-office/integration',
          head: 'ai-office/worker',
        },
      };
    case 'merge': {
      const pr = await f.scm.openPR(
        repo,
        {
          title: 'Merge queue review',
          body: '',
          base: 'ai-office/integration',
          head: 'ai-office/worker',
        },
        correlation('setup-pr'),
      );
      const head = await f.scm.compareBranch(
        repo,
        'ai-office/integration',
        'ai-office/worker',
      );
      return {
        kind: 'scm.mergePR',
        args: { pr, expectedHeadSha: head!.headSha, method: 'merge' },
      };
    }
    case 'workspace': {
      const head = await f.scm.compareBranch(
        repo,
        'ai-office/integration',
        'ai-office/integration',
      );
      f.runtime.setRemoteBranch(
        runtimeRepo,
        'ai-office/integration',
        head!.headSha,
      );
      return {
        kind: 'runtime.prepareWorkspace',
        args: {
          repo: runtimeRepo,
          session: f.session,
          name: 'aio-ab12-item-a1',
          branch: 'ai-office/item',
          fetchBranch: 'ai-office/integration',
          baseBranch: head!.headSha,
        },
      };
    }
  }
}

/** Once the simulated process crashes, it cannot write a failure or checkpoint. */
function crashStore(
  store: EventStore,
  shouldCrash: (events: Parameters<EventStore['append']>[0]) => boolean,
  afterCommit = false,
): EventStore {
  let dead = false;
  return {
    read: (q) => store.read(q),
    readCursor: (s, k) => store.readCursor(s, k),
    lastSeq: () => store.lastSeq(),
    subscribe: (l) => store.subscribe(l),
    append: (events, opts) => {
      if (dead) throw new Error('process stopped');
      if (shouldCrash(events)) {
        dead = true;
        if (afterCommit) store.append(events, opts);
        throw new Error('simulated crash');
      }
      return store.append(events, opts);
    },
  };
}

const onStart =
  (command: ExternalCommand): RunnerReact =>
  (_state, event) =>
    event.type === 'workflow.started'
      ? [
          external('recover', command, {
            stageId: 'implement',
            attemptId: 'attempt',
          }),
        ]
      : [];

describe('SQLite close/reopen outbox crash windows', () => {
  for (const kind of ['spawn', 'issue', 'pr', 'merge', 'workspace'] as const) {
    for (const window of [
      'issued',
      'external-success',
      'before-succeeded',
    ] as const) {
      test(`${kind}: ${window} causes exactly one external mutation`, async () => {
        const f = await fixture();
        const command = await commandFor(f, kind);
        const react = onStart(command);
        const method =
          kind === 'spawn'
            ? 'spawnAgent'
            : kind === 'issue'
              ? 'createIssue'
              : kind === 'pr'
                ? 'openPR'
                : kind === 'merge'
                  ? 'mergePR'
                  : 'prepareWorkspace';
        const spy =
          kind === 'spawn' || kind === 'workspace'
            ? vi.spyOn(f.runtime, method as 'spawnAgent')
            : vi.spyOn(f.scm, method as 'createIssue');
        const store = crashStore(
          f.stores.events,
          (events) =>
            events.some(
              (e) =>
                e.type ===
                (window === 'issued' ? 'command.issued' : 'command.succeeded'),
            ),
          window === 'issued',
        );
        const original = f.handlers()[command.kind]!;
        const overrides: CommandHandlers =
          window === 'external-success'
            ? {
                [command.kind]: async (...args: never[]) => {
                  await (original as (...args: never[]) => Promise<unknown>)(
                    ...args,
                  );
                  return new Promise(() => undefined);
                },
              }
            : {};
        const first = f.build(react, overrides, store);
        await first.runners.start(startWorkflow()).catch(() => undefined);
        await flush();
        const recovered = f.restart(react);
        expect(await f.reconciler().reconcile(recovered.runners)).toEqual({
          pending: 0,
        });
        await recovered.runners.idle();
        expect(spy).toHaveBeenCalledTimes(1);
        expect(
          recovered.runners.get(WORKFLOW_ID)!.state.commands.recover?.status,
        ).toBe('succeeded');
        expect(
          recovered.runners.get(WORKFLOW_ID)!.state.workflow?.shortId,
        ).toBe('ab12');
        const events = f.stores.events.read({});
        expect(
          events.filter(
            (e) =>
              e.type === 'command.succeeded' &&
              e.payload.commandId === 'recover',
          ),
        ).toHaveLength(1);
        if (kind === 'workspace')
          expect(
            recovered.runners.get(WORKFLOW_ID)!.state.commands.recover?.result,
          ).toMatchObject({
            result: {
              baseSha:
                command.kind === 'runtime.prepareWorkspace'
                  ? command.args.baseBranch
                  : '',
            },
          });
        const again = f.restart(react);
        await f.reconciler().reconcile(again.runners);
        expect(spy).toHaveBeenCalledTimes(1);
      });
    }
  }
});

async function pendingCommand(f: Fixture, command: ExternalCommand) {
  const react = onStart(command);
  const store = crashStore(
    f.stores.events,
    (events) => events.some((e) => e.type === 'command.issued'),
    true,
  );
  await f
    .build(react, {}, store)
    .runners.start(startWorkflow())
    .catch(() => undefined);
  return { react, recovered: f.restart(react) };
}

test('pending receipt waits; absent searches marker before any redo, including pruned receipts', async () => {
  const f = await fixture();
  const command = await commandFor(f, 'spawn');
  const { recovered } = await pendingCommand(f, command);
  const receipt = vi
    .spyOn(f.runtime, 'inspectRequest')
    .mockResolvedValueOnce({ status: 'pending' });
  const marker = vi.spyOn(f.runtime, 'findCommandByMarker');
  const spawn = vi.spyOn(f.runtime, 'spawnAgent');
  expect(await f.reconciler().reconcile(recovered.runners)).toEqual({
    pending: 1,
  });
  expect(marker).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  const issued = recovered.runners.get(WORKFLOW_ID)!.issuedCommand('recover')!;
  f.runtime.injectFault('spawnAgent', 'response-lost');
  await expect(
    f.handlers()['runtime.spawnAgent']!(
      command.kind === 'runtime.spawnAgent' ? command.args : never(),
      { issued, correlation: correlation('recover') },
    ),
  ).rejects.toMatchObject({ code: 'response_lost' });
  f.runtime.pruneReceipt('recover');
  await f.reconciler().reconcile(recovered.runners);
  expect(receipt).toHaveBeenCalledTimes(2);
  expect(marker).toHaveBeenCalledWith('recover');
  expect(spawn).toHaveBeenCalledTimes(1);
});
function never(): never {
  throw new Error('unexpected command');
}

test('mismatching workspace marker gives up and atomically opens one anomaly gate', async () => {
  const f = await fixture();
  const command = await commandFor(f, 'workspace');
  if (command.kind !== 'runtime.prepareWorkspace') return never();
  await f.runtime.prepareWorkspace({
    ...command.args,
    session: f.session,
    correlation: correlation('other-owner'),
  });
  const { recovered, react } = await pendingCommand(f, command);
  await f.reconciler().reconcile(recovered.runners);
  const runner = recovered.runners.get(WORKFLOW_ID)!;
  expect(runner.state.commands.recover).toMatchObject({
    status: 'failed',
    reconciled: 'gave_up',
  });
  expect(runner.state.gates['reconcile:recover']).toMatchObject({
    kind: 'exception',
    exceptionKind: 'anomaly',
  });
  expect(runner.state.workflow?.pausedReasons).toContain('anomaly');
  const again = f.restart(react);
  await f.reconciler().reconcile(again.runners);
  expect(
    f.stores.events.read({}).filter((e) => e.type === 'gate.opened'),
  ).toHaveLength(1);
});

test.each(['ai-office/integration', 'main'])(
  'unpinned origin/%s workspace recovers by marker and keeps the fetched sha (W1)',
  async (branch) => {
    const f = await fixture();
    const head = '1'.repeat(40);
    f.runtime.setRemoteBranch(runtimeRepo, branch, head);
    const command: ExternalCommand = {
      kind: 'runtime.prepareWorkspace',
      args: {
        repo: runtimeRepo,
        session: f.session,
        name: 'aio-ab12-merge-1',
        branch: 'ai-office/ab12/merge-1',
        fetchBranch: branch,
        baseBranch: `origin/${branch}`,
      },
    };
    const react = onStart(command);
    const store = crashStore(
      f.stores.events,
      (events) => events.some((e) => e.type === 'command.succeeded'),
      false,
    );
    await f
      .build(react, {}, store)
      .runners.start(startWorkflow())
      .catch(() => undefined);
    await flush();
    const prepare = vi.spyOn(f.runtime, 'prepareWorkspace');
    const recovered = f.restart(react);
    await f.reconciler().reconcile(recovered.runners);
    await recovered.runners.idle();
    expect(prepare).not.toHaveBeenCalled();
    expect(
      recovered.runners.get(WORKFLOW_ID)!.state.commands.recover,
    ).toMatchObject({
      status: 'succeeded',
      reconciled: 'found',
      result: { result: { baseSha: head } },
    });
  },
);

test('missing or tampered issued spec never rotates or spawns', async () => {
  const f = await fixture();
  const command = await commandFor(f, 'spawn');
  const { recovered } = await pendingCommand(f, command);
  if (command.kind !== 'runtime.spawnAgent') return never();
  f.specStore.remove(command.args.specPath);
  const rotate = vi.spyOn(f.stores.seatTokens, 'rotateUnissued');
  const spawn = vi.spyOn(f.runtime, 'spawnAgent');
  await f.reconciler().reconcile(recovered.runners);
  expect(rotate).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  expect(
    recovered.runners.get(WORKFLOW_ID)!.state.commands.recover?.reconciled,
  ).toBe('gave_up');
});

test('event append before react recovers external, internal and timer effects once', async () => {
  const f = await fixture();
  const command = await commandFor(f, 'issue');
  const react: RunnerReact = (_state, event) =>
    event.type === 'workflow.started'
      ? [
          external('recover', command),
          internal({
            type: 'StartStage',
            meta: { source: 'engine', occurredAt: event.occurredAt },
            stageId: 'meeting',
          }),
          {
            kind: 'timer',
            timer: {
              id: 'recovery-timer',
              fireAt: '2026-11-18T00:00:00.000Z',
              payload: {
                purpose: 'stage-timeout',
                stageId: 'meeting',
                attempt: 1,
              },
            },
          },
        ]
      : [];
  const result = decide(initialState(), startWorkflow());
  if (!result.ok) return never();
  f.stores.events.append(result.events);
  const recovered = f.restart(react);
  await recovered.runners.idle();
  expect(f.stores.events.readCursor(REACTION_CURSOR, WORKFLOW_ID)).toBe(
    f.stores.events.lastSeq(),
  );
  expect(
    recovered.runners.get(WORKFLOW_ID)!.state.commands.recover?.status,
  ).toBe('succeeded');
  f.restart(react);
  for (const type of ['command.issued', 'stage.started', 'timer.scheduled'])
    expect(
      f.stores.events.read({}).filter((e) => e.type === type),
    ).toHaveLength(1);
});

for (const crashPoint of ['token-issued', 'spec-written'] as const) {
  test(`unissued spawn rotates a hash-only token after ${crashPoint}, then freezes spec`, async () => {
    const f = await fixture();
    const spawn: SpawnEffect = {
      kind: 'spawn',
      commandId: 'recover-spawn',
      stageId: 'meeting',
      seatId: `${WORKFLOW_ID}/lead`,
      attemptId: 'recover-attempt',
      spec: { purpose: 'facilitator', stageId: 'meeting' },
      agent: 'claude-code',
      workspace: {
        kind: 'existing-worktree',
        workspace: f.workspace.workspace,
        readOnly: true,
      },
      keepOpen: true,
    };
    const react: RunnerReact = (state, event) => [
      ...lifecycleReact(state, event),
      ...(event.type === 'command.succeeded' &&
      event.payload.kind === 'runtime.openSession'
        ? [
            internal({
              type: 'SpawnAttempt',
              meta: {
                source: 'engine',
                occurredAt: event.occurredAt,
                causationId: event.id,
              },
              stageId: 'meeting',
              role: 'lead',
              attemptId: spawn.attemptId,
              purpose: 'facilitator',
              keepOpen: true,
              spawnCommandId: spawn.commandId,
            }),
            spawn,
          ]
        : []),
    ];
    let originalToken = '';
    const issue = f.stores.seatTokens.issue.bind(f.stores.seatTokens);
    vi.spyOn(f.stores.seatTokens, 'issue').mockImplementation((id) => {
      originalToken = issue(id);
      return originalToken;
    });
    const write = f.specStore.write.bind(f.specStore);
    const fault = vi
      .spyOn(f.specStore, 'write')
      .mockImplementationOnce((id, text) => {
        if (crashPoint === 'spec-written') write(id, text);
        throw new Error('process stopped before command.issued');
      });
    const first = f.build(react);
    await first.runners.start(startWorkflow());
    await first.runners.idle();
    expect(
      first.runners.get(WORKFLOW_ID)!.state.commands[spawn.commandId],
    ).toBeUndefined();
    expect(originalToken).toMatch(/^aio_seat_/);
    fault.mockRestore();
    const recovered = f.restart(react);
    await recovered.runners.idle();
    const runner = recovered.runners.get(WORKFLOW_ID)!;
    expect(runner.state.commands[spawn.commandId]?.status).toBe('succeeded');
    expect(f.stores.seatTokens.verify(originalToken)).toBeNull();
    const recorded = runner.issuedCommand(spawn.commandId)!;
    if (recorded.command.kind !== 'runtime.spawnAgent') return never();
    const { specPath, specSha256 } = recorded.command.args;
    const contents = f.specStore.read(specPath, specSha256)!;
    const token = /aio_seat_[0-9a-f]+/.exec(contents)![0];
    expect(token).not.toBe(originalToken);
    expect(f.stores.seatTokens.verify(token)).toBe(spawn.attemptId);
    expect(() => f.stores.seatTokens.rotateUnissued(spawn.attemptId)).toThrow();
    const again = f.restart(react);
    await f.reconciler().reconcile(again.runners);
    expect(f.specStore.read(specPath, specSha256)).toBe(contents);
    expect(
      f.stores.events.read({}).filter((e) => e.type === 'seat.spawned'),
    ).toHaveLength(1);
    expect(JSON.stringify(f.stores.events.read({}))).not.toContain(token);
    f.stores.close();
    expect(readFileSync(f.filename).includes(Buffer.from(token))).toBe(false);
    expect(readFileSync(f.filename).includes(Buffer.from(originalToken))).toBe(
      false,
    );
  });
}

test('completed effect receipts survive an interrupted reaction and preserve timer history', async () => {
  const f = await fixture();
  const command = await commandFor(f, 'issue');
  const react: RunnerReact = (_state, event) =>
    event.type === 'workflow.started'
      ? [
          {
            kind: 'timer',
            timer: {
              id: 'once',
              fireAt: '2026-11-18T00:00:00.000Z',
              payload: {
                purpose: 'stage-timeout',
                stageId: 'meeting',
                attempt: 1,
              },
            },
          },
          external('recover', command),
        ]
      : [];
  const store = crashStore(
    f.stores.events,
    (events) => events.some((e) => e.type === 'command.issued'),
    false,
  );
  await f
    .build(react, {}, store)
    .runners.start(startWorkflow())
    .catch(() => undefined);
  const recovered = f.restart(react);
  await recovered.runners.idle();
  expect(
    f.stores.events.read({}).filter((e) => e.type === 'timer.scheduled'),
  ).toHaveLength(1);
  expect(
    f.stores.events.read({}).filter((e) => e.type === 'command.issued'),
  ).toHaveLength(1);
});

for (const kind of ['issue', 'pr', 'merge'] as const) {
  test(`SCM ${kind} response-lost fault is backfilled without invoking mutation again`, async () => {
    const f = await fixture();
    const command = await commandFor(f, kind);
    const { recovered } = await pendingCommand(f, command);
    const issued = recovered.runners
      .get(WORKFLOW_ID)!
      .issuedCommand('recover')!;
    const operation =
      kind === 'issue' ? 'createIssue' : kind === 'pr' ? 'openPR' : 'mergePR';
    f.scm.injectResponseLost(operation);
    const handler = f.handlers()[command.kind]! as (
      args: unknown,
      ctx: unknown,
    ) => Promise<unknown>;
    await expect(
      handler(command.args, { issued, correlation: correlation('recover') }),
    ).rejects.toMatchObject({ code: 'response_lost' });
    const mutation = vi.spyOn(f.scm, operation);
    await f.reconciler().reconcile(recovered.runners);
    expect(mutation).not.toHaveBeenCalled();
    expect(
      recovered.runners.get(WORKFLOW_ID)!.state.commands.recover,
    ).toMatchObject({ status: 'succeeded', reconciled: 'found' });
  });
}

test('an interrupted redo failure still opens the anomaly gate on the next startup', async () => {
  const f = await fixture();
  const command = await commandFor(f, 'merge');
  if (command.kind !== 'scm.mergePR') return never();
  command.args.expectedHeadSha = 'f'.repeat(40);
  const { recovered, react } = await pendingCommand(f, command);
  const runner = recovered.runners.get(WORKFLOW_ID)!;
  const issued = runner.issuedCommand('recover')!;
  // Reproduce a crash after the redo result but before the reconciler's gate write.
  await runner.append([
    {
      type: 'command.reconciled',
      payload: { commandId: 'recover', kind: command.kind, outcome: 'redone' },
      workflowId: WORKFLOW_ID,
      source: 'system',
      provenance: 'observed',
      occurredAt: f.clock.now().toISOString(),
      schemaVersion: 1,
    },
  ]);
  runner.deliver(issued, {
    ok: false,
    attempts: 1,
    error: {
      category: 'conflict',
      code: 'head_sha_mismatch',
      message: 'Head changed',
      retryable: false,
    },
  });
  const again = f.restart(react);
  await f.reconciler().reconcile(again.runners);
  expect(
    again.runners.get(WORKFLOW_ID)!.state.gates['reconcile:recover'],
  ).toBeDefined();
});

test('a lost redo result write remains pending and is found on the next pass', async () => {
  const f = await fixture();
  const command = await commandFor(f, 'issue');
  const { recovered } = await pendingCommand(f, command);
  const append = f.stores.events.append.bind(f.stores.events);
  let failResult = true;
  vi.spyOn(f.stores.events, 'append').mockImplementation((events, opts) => {
    if (failResult && events.some((e) => e.type === 'command.succeeded')) {
      failResult = false;
      throw new Error('result write failed');
    }
    return append(events, opts);
  });
  const create = vi.spyOn(f.scm, 'createIssue');
  const reconciler = f.reconciler();
  expect(await reconciler.reconcile(recovered.runners)).toEqual({ pending: 1 });
  expect(await reconciler.reconcile(recovered.runners)).toEqual({ pending: 0 });
  expect(create).toHaveBeenCalledTimes(1);
  expect(
    recovered.runners.get(WORKFLOW_ID)!.state.commands.recover?.status,
  ).toBe('succeeded');
});

test('replays an explicitly issued reclaim idempotently after a crash without a request ID', async () => {
  const f = await fixture();
  const reclaim = vi.spyOn(f.runtime, 'reclaimSession');
  const { recovered } = await pendingCommand(f, {
    kind: 'runtime.reclaimSession',
    args: { session: f.session },
  });
  await f.reconciler().reconcile(recovered.runners);
  await recovered.runners.idle();
  expect(reclaim).toHaveBeenCalledExactlyOnceWith(f.session);
  expect(
    recovered.runners.get(WORKFLOW_ID)!.state.commands.recover,
  ).toMatchObject({
    status: 'succeeded',
    reconciled: 'redone',
    result: { kind: 'runtime.reclaimSession', result: { reclaimed: true } },
  });
});
