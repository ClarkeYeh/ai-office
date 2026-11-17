import { describe, expect, test, vi } from 'vitest';
import type { DomainEvent, EventPayload } from '@ai-office/contracts/events';
import { evolve, replay } from '@ai-office/domain';
import type { WorkflowState } from '@ai-office/domain';
import { internal, react as engineReact } from '@ai-office/engine';
import { PortError } from '../../ports/errors.js';
import { AIO_NAMESPACE } from '../../ports/services.js';
import { spawnPrompt } from '../commands/executor.js';
import type { SpawnEffect } from '@ai-office/engine';
import {
  lifecycleReact,
  CLI_PATH,
  flush,
  harness,
  START,
  startWorkflow,
  StubWorld,
  WORKFLOW_ID,
} from './test-support/harness.js';
import type { RunnerEffect, RunnerReact } from './workflow-runner.js';
import { InMemorySeatTokenStore } from '../../test-support/index.js';

const transient = () =>
  new PortError('transient', 'runtime_unavailable', 'Orca is down', true);

const payloadsOf = <T extends DomainEvent['type']>(
  events: DomainEvent[],
  type: T,
): EventPayload<T>[] =>
  events
    .filter((event) => event.type === type)
    .map((event) => event.payload as EventPayload<T>);

/** Engine react plus extra test effects computed from the post-event state. */
const withExtra =
  (
    extra: (after: WorkflowState, event: DomainEvent) => RunnerEffect[],
  ): RunnerReact =>
  (state, event) => [
    ...lifecycleReact(state, event),
    ...extra(evolve(state, event), event),
  ];

const SPAWN_ID = `${WORKFLOW_ID}/spawn/att-1`;

/** Spawns the meeting facilitator once the Orca session is open. */
const spawnFacilitator = withExtra((_after, event) => {
  if (
    event.type !== 'command.succeeded' ||
    event.payload.kind !== 'runtime.openSession'
  )
    return [];
  const meta = {
    occurredAt: event.occurredAt,
    source: 'engine' as const,
    causationId: event.id,
  };
  const spawn: SpawnEffect = {
    kind: 'spawn',
    commandId: SPAWN_ID,
    stageId: 'meeting',
    seatId: `${WORKFLOW_ID}/lead`,
    attemptId: 'att-1',
    spec: { purpose: 'facilitator', stageId: 'meeting' },
    agent: 'claude-code',
    effort: 'high',
    workspace: { kind: 'existing-worktree', workspace: 'ws-1', readOnly: true },
    keepOpen: true,
  };
  return [
    internal({
      type: 'SpawnAttempt',
      meta,
      stageId: 'meeting',
      role: 'lead',
      attemptId: 'att-1',
      purpose: 'facilitator',
      keepOpen: true,
      spawnCommandId: SPAWN_ID,
    }),
    spawn,
  ];
});

const spawned = async (options: Parameters<typeof harness>[0] = {}) => {
  const h = harness({ react: spawnFacilitator, ...options });
  await h.runners.start(startWorkflow());
  await flush();
  return h;
};

const spawnIssued = (events: DomainEvent[]) => {
  const issued = payloadsOf(events, 'command.issued').find(
    (payload) => payload.kind === 'runtime.spawnAgent',
  );
  if (issued?.kind !== 'runtime.spawnAgent') throw new Error('no spawn issued');
  return issued;
};

describe('golden sequence against the engine simulator', () => {
  // Captured from packages/engine Simulator with the same StartWorkflow.
  const SIMULATOR_HUNG = [
    `${START} workflow.started`,
    `${START} command.issued runtime.openSession wf-1/open-session`,
    `${START} command.issued scm.ensureBranch wf-1/ensure-branch`,
    `${START} stage.started meeting#1`,
  ];
  const SIMULATOR_COOPERATIVE = [
    `${START} workflow.started`,
    `${START} command.issued runtime.openSession wf-1/open-session`,
    `${START} command.issued scm.ensureBranch wf-1/ensure-branch`,
    `${START} command.succeeded runtime.openSession wf-1/open-session`,
    `${START} command.succeeded scm.ensureBranch wf-1/ensure-branch`,
    `${START} stage.started meeting#1`,
  ];

  test('identical while no command has answered', async () => {
    const h = harness({ world: new StubWorld().hang('*') });
    const result = await h.runners.start(startWorkflow());
    expect(result.ok).toBe(true);
    await flush();
    expect(h.trace()).toEqual(SIMULATOR_HUNG);
  });

  test('same events and state once results arrive; results queue behind internal commands', async () => {
    const h = harness();
    await h.runners.start(startWorkflow());
    await h.runners.idle();
    // The simulator answers synchronously; the runner never blocks its queue
    // on a port call, so StartStage is processed before the results return.
    expect(h.trace()).toEqual([
      SIMULATOR_COOPERATIVE[0],
      SIMULATOR_COOPERATIVE[1],
      SIMULATOR_COOPERATIVE[2],
      SIMULATOR_COOPERATIVE[5],
      SIMULATOR_COOPERATIVE[3],
      SIMULATOR_COOPERATIVE[4],
    ]);
    const state = h.runners.get(WORKFLOW_ID)?.state;
    expect(state?.stages.meeting?.status).toBe('running');
    expect(state?.commands[`${WORKFLOW_ID}/open-session`]?.status).toBe(
      'succeeded',
    );
  });
});

describe('outbox', () => {
  test('command.issued carries orcaRequestId = UUIDv5(commandId) only for Orca mutations', async () => {
    const h = harness();
    await h.runners.start(startWorkflow());
    await h.runners.idle();
    const issued = payloadsOf(h.events(), 'command.issued');
    expect(issued.map((p) => [p.kind, p.orcaRequestId])).toEqual([
      [
        'runtime.openSession',
        h.ids.orcaRequestId(`${WORKFLOW_ID}/open-session`),
      ],
      ['scm.ensureBranch', undefined],
    ]);
    expect(AIO_NAMESPACE).toBe('de8da250-5d38-5e9f-9709-4f139d21cbf3');
    expect(h.world.callsOf('openSession')[0]?.[0]).toMatchObject({
      workflowId: WORKFLOW_ID,
      correlation: {
        workflowId: WORKFLOW_ID,
        commandId: `${WORKFLOW_ID}/open-session`,
      },
    });
  });

  test('the same input sequence yields the same event log', async () => {
    const run = async () => {
      const h = harness({ react: spawnFacilitator });
      await h.runners.start(startWorkflow());
      await h.runners.idle();
      await h.runners.dispatch(WORKFLOW_ID, {
        type: 'PauseWorkflow',
        meta: { occurredAt: START, source: 'user' },
        reason: 'anomaly',
      });
      await h.runners.idle();
      // Seat tokens are random by design; the spec hash embeds one.
      return h.events().map((event) =>
        event.type === 'command.issued' &&
        event.payload.kind === 'runtime.spawnAgent'
          ? {
              ...event,
              payload: {
                ...event.payload,
                args: { ...event.payload.args, specSha256: '-' },
              },
            }
          : event,
      );
    };
    const [a, b] = [await run(), await run()];
    expect(a.length).toBeGreaterThan(6);
    expect(a).toEqual(b);
  });

  test('two inputs arriving together are processed in order', async () => {
    const h = harness({ world: new StubWorld().hang('*') });
    await h.runners.start(startWorkflow());
    const meta = { occurredAt: START, source: 'user' as const };
    const [paused, resumed] = await Promise.all([
      h.runners.dispatch(WORKFLOW_ID, {
        type: 'PauseWorkflow',
        meta,
        reason: 'anomaly',
      }),
      h.runners.dispatch(WORKFLOW_ID, {
        type: 'ResumeWorkflow',
        meta,
        reason: 'anomaly',
      }),
    ]);
    expect(paused.ok && resumed.ok).toBe(true);
    expect(h.trace().slice(-2)).toEqual([
      `${START} workflow.paused anomaly`,
      `${START} workflow.resumed anomaly`,
    ]);
  });

  test('a rejected command writes nothing and reports the domain error', async () => {
    const h = harness({ world: new StubWorld().hang('*') });
    await h.runners.start(startWorkflow());
    const before = h.events().length;
    const result = await h.runners.dispatch(WORKFLOW_ID, {
      type: 'StartStage',
      meta: { occurredAt: START, source: 'user' },
      stageId: 'nope',
    });
    expect(result.ok).toBe(false);
    expect(h.events()).toHaveLength(before);
  });
});

describe('retries (§15)', () => {
  test('transient failures back off 1s/2s on the Scheduler with identical args', async () => {
    const world = new StubWorld().script(
      'openSession',
      transient(),
      transient(),
    );
    const h = harness({ world });
    await h.runners.start(startWorkflow());
    await flush();
    expect(world.callsOf('openSession')).toHaveLength(1);
    await h.advance(1_000); // 1s + 10% jitter not reached yet
    expect(world.callsOf('openSession')).toHaveLength(1);
    await h.advance(100);
    expect(world.callsOf('openSession')).toHaveLength(2);
    await h.advance(2_200);
    await h.runners.idle();
    const calls = world.callsOf('openSession');
    expect(calls).toHaveLength(3);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[2]).toEqual(calls[0]);
    const kinds = payloadsOf(h.events(), 'command.issued').map((p) => p.kind);
    expect(kinds.filter((k) => k === 'runtime.openSession')).toHaveLength(1);
    expect(payloadsOf(h.events(), 'command.succeeded')).toHaveLength(2);
  });

  test('a fourth transient failure is recorded as command.failed without pausing', async () => {
    const world = new StubWorld().script(
      'ensureBranch',
      transient(),
      transient(),
      transient(),
      transient(),
    );
    const h = harness({ world });
    await h.runners.start(startWorkflow());
    for (const ms of [1_100, 2_200, 4_400]) await h.advance(ms);
    await h.runners.idle();
    expect(payloadsOf(h.events(), 'command.failed')).toEqual([
      expect.objectContaining({
        kind: 'scm.ensureBranch',
        attempts: 4,
        error: expect.objectContaining({ category: 'transient' }),
      }),
    ]);
    expect(payloadsOf(h.events(), 'workflow.paused')).toEqual([]);
  });

  test.each([
    ['bug', 'bug', true],
    ['auth', 'auth', false],
    ['hijacked', 'hijacked', false],
    ['contract_mismatch', 'contract_mismatch', false],
    ['guard', undefined, true],
    ['permanent', undefined, false],
  ] as const)(
    '%s: no retry, command.failed, pause=%s, error.recorded=%s',
    async (category, pause, recorded) => {
      const world = new StubWorld().script(
        'ensureBranch',
        new PortError(category, 'x', 'failed'),
      );
      const h = harness({ world });
      await h.runners.start(startWorkflow());
      await h.runners.idle();
      expect(world.callsOf('ensureBranch')).toHaveLength(1);
      expect(payloadsOf(h.events(), 'command.failed')).toHaveLength(1);
      expect(
        payloadsOf(h.events(), 'workflow.paused').map((p) => p.reason),
      ).toEqual(pause === undefined ? [] : [pause]);
      expect(payloadsOf(h.events(), 'error.recorded')).toEqual(
        recorded
          ? [
              expect.objectContaining({
                category,
                commandId: `${WORKFLOW_ID}/ensure-branch`,
              }),
            ]
          : [],
      );
    },
  );

  test('identity retries once at once with the same request, then pauses', async () => {
    const identity = () =>
      new PortError('identity', 'stable_pane_required', 'x');
    const world = new StubWorld().script('openSession', identity(), identity());
    const h = harness({ world });
    await h.runners.start(startWorkflow());
    await h.runners.idle();
    const calls = world.callsOf('openSession');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(payloadsOf(h.events(), 'command.failed')[0]?.attempts).toBe(2);
    expect(
      payloadsOf(h.events(), 'workflow.paused').map((p) => p.reason),
    ).toEqual(['identity']);
  });

  test('an unexpected throw is a bug', async () => {
    const world = new StubWorld().script('ensureBranch', new Error('boom'));
    const h = harness({ world });
    await h.runners.start(startWorkflow());
    await h.runners.idle();
    expect(payloadsOf(h.events(), 'command.failed')[0]?.error).toMatchObject({
      category: 'bug',
      code: 'unexpected_error',
    });
  });
});

describe('spawn materialization (N3)', () => {
  test('seat token → spec file → fully concrete command.issued → spawnAgent', async () => {
    const h = await spawned();
    const events = h.events();
    const types = events.map((e) => e.type);
    expect(types.indexOf('seat.spawned')).toBeLessThan(
      events.findIndex(
        (e) =>
          e.type === 'command.issued' &&
          e.payload.kind === 'runtime.spawnAgent',
      ),
    );
    const issued = spawnIssued(events);
    expect(issued.commandId).toBe(SPAWN_ID);
    expect(issued.orcaRequestId).toBe(h.ids.orcaRequestId(SPAWN_ID));
    expect(issued.args).toMatchObject({
      session: 'session-1',
      agent: 'claude-code',
      effort: 'high',
      title: `aio:${SPAWN_ID}`,
      specPath: '/data/specs/att-1.md',
      workspace: {
        kind: 'existing-worktree',
        workspace: 'ws-1',
        readOnly: true,
      },
      keepOpen: true,
    });
    expect(
      h.specStore.verify(issued.args.specPath, issued.args.specSha256),
    ).toBe(true);
    const spec = h.specStore.files.get(issued.args.specPath) ?? '';
    const token = /aio_seat_[0-9a-f]+/.exec(spec)?.[0];
    expect(token).toBeDefined();
    expect(h.seatTokens.verify(token ?? '')).toBe('att-1');
    expect(spec).toContain(CLI_PATH);
    // The token lives only in the spec file, never in events.
    expect(JSON.stringify(events)).not.toContain(token);
    const [req] = h.world.callsOf('spawnAgent')[0] as [Record<string, unknown>];
    expect(req.prompt).toBe(spawnPrompt(issued.args, SPAWN_ID));
    expect(h.runners.get(WORKFLOW_ID)?.state.attempts['att-1']?.agentRef).toBe(
      `agent:aio:${SPAWN_ID}`,
    );
  });

  test('a retried spawn reuses args and spec file; the token is issued once', async () => {
    const seatTokens = new InMemorySeatTokenStore();
    const issue = vi.spyOn(seatTokens, 'issue');
    const world = new StubWorld().script('spawnAgent', transient());
    const h = await spawned({ world, seatTokens });
    await h.advance(1_100);
    await h.runners.idle();
    const calls = world.callsOf('spawnAgent');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(issue).toHaveBeenCalledTimes(1);
    expect(h.specStore.writes).toBe(1);
    expect(
      payloadsOf(h.events(), 'command.succeeded').map((p) => p.kind),
    ).toContain('runtime.spawnAgent');
  });

  test('a spec file changed before a retry is a bug: no call, paused', async () => {
    const world = new StubWorld().script('spawnAgent', transient());
    const h = await spawned({ world });
    const issued = spawnIssued(h.events());
    h.specStore.tamper(issued.args.specPath);
    await h.advance(1_100);
    await h.runners.idle();
    expect(world.callsOf('spawnAgent')).toHaveLength(1);
    expect(payloadsOf(h.events(), 'command.failed')).toEqual([
      expect.objectContaining({
        kind: 'runtime.spawnAgent',
        error: expect.objectContaining({
          category: 'bug',
          code: 'spec_mismatch',
        }),
      }),
    ]);
    expect(
      payloadsOf(h.events(), 'workflow.paused').map((p) => p.reason),
    ).toEqual(['bug']);
  });

  test('a spawn whose SpawnAttempt was refused is dropped with error.recorded', async () => {
    const react = withExtra((_after, event) =>
      event.type === 'command.succeeded' &&
      event.payload.kind === 'runtime.openSession'
        ? [
            {
              kind: 'spawn',
              commandId: SPAWN_ID,
              stageId: 'meeting',
              seatId: `${WORKFLOW_ID}/lead`,
              attemptId: 'att-1',
              spec: { purpose: 'facilitator', stageId: 'meeting' },
              agent: 'claude-code',
              workspace: {
                kind: 'existing-worktree',
                workspace: 'ws-1',
                readOnly: true,
              },
              keepOpen: true,
            },
          ]
        : [],
    );
    const h = harness({ react });
    await h.runners.start(startWorkflow());
    await h.runners.idle();
    expect(h.world.callsOf('spawnAgent')).toEqual([]);
    expect(payloadsOf(h.events(), 'error.recorded')).toEqual([
      expect.objectContaining({
        category: 'bug',
        code: 'spawn_without_attempt',
        commandId: SPAWN_ID,
      }),
    ]);
    expect(payloadsOf(h.events(), 'workflow.paused')).toEqual([]);
  });

  test('a token that was already issued is never minted again', async () => {
    const seatTokens = new InMemorySeatTokenStore();
    seatTokens.issue('att-1');
    const h = await spawned({ seatTokens });
    await h.runners.idle();
    expect(h.world.callsOf('spawnAgent')).toEqual([]);
    expect(payloadsOf(h.events(), 'error.recorded')[0]?.code).toBe(
      'seat_token_reissue',
    );
    expect(
      payloadsOf(h.events(), 'workflow.paused').map((p) => p.reason),
    ).toEqual(['bug']);
  });

  test('an ended attempt loses its seat token and spec file', async () => {
    const h = await spawned();
    const issued = spawnIssued(h.events());
    const token =
      /aio_seat_[0-9a-f]+/.exec(
        h.specStore.files.get(issued.args.specPath) ?? '',
      )?.[0] ?? '';
    await h.runners.dispatch(WORKFLOW_ID, {
      type: 'RecordAttemptExited',
      meta: { occurredAt: START, source: 'runtime' },
      attemptId: 'att-1',
      reason: 'done',
      expected: true,
    });
    expect(h.seatTokens.verify(token)).toBeNull();
    expect(h.specStore.files.has(issued.args.specPath)).toBe(false);
  });
});

describe('timers', () => {
  const TIMER = `${WORKFLOW_ID}/timer/test`;
  const scheduleOnStart = (event: DomainEvent): RunnerEffect[] =>
    event.type === 'workflow.started'
      ? [
          {
            kind: 'timer',
            timer: {
              id: TIMER,
              fireAt: '2026-11-17T00:05:00.000Z',
              payload: {
                purpose: 'stage-timeout',
                stageId: 'meeting',
                attempt: 1,
              },
            },
          },
        ]
      : [];
  const timerReact = withExtra((_after, event) => scheduleOnStart(event));

  test('timer.scheduled goes to the Scheduler and fires once as timer.fired', async () => {
    const h = harness({ react: timerReact, world: new StubWorld().hang('*') });
    await h.runners.start(startWorkflow());
    expect(
      payloadsOf(h.events(), 'timer.scheduled').map((p) => p.timerId),
    ).toEqual([TIMER]);
    await h.advance(4 * 60_000);
    expect(payloadsOf(h.events(), 'timer.fired')).toEqual([]);
    await h.advance(60_000);
    await h.advance(60_000);
    expect(payloadsOf(h.events(), 'timer.fired')).toEqual([{ timerId: TIMER }]);
  });

  test('cancelTimer writes timer.cancelled only while pending', async () => {
    const both = withExtra((_after, event) => [
      ...scheduleOnStart(event),
      ...(event.type === 'workflow.paused'
        ? [{ kind: 'cancelTimer' as const, id: TIMER, reason: 'paused' }]
        : []),
    ]);
    const h = harness({ react: both, world: new StubWorld().hang('*') });
    await h.runners.start(startWorkflow());
    const meta = { occurredAt: START, source: 'user' as const };
    await h.runners.dispatch(WORKFLOW_ID, {
      type: 'PauseWorkflow',
      meta,
      reason: 'anomaly',
    });
    await h.runners.dispatch(WORKFLOW_ID, {
      type: 'PauseWorkflow',
      meta,
      reason: 'budget',
    });
    expect(payloadsOf(h.events(), 'timer.cancelled')).toEqual([
      { timerId: TIMER, reason: 'paused' },
    ]);
    await h.advance(10 * 60_000);
    expect(payloadsOf(h.events(), 'timer.fired')).toEqual([]);
  });

  test('after a restart pending timers are re-armed from timer.scheduled', async () => {
    const first = harness({
      react: timerReact,
      world: new StubWorld().hang('*'),
    });
    await first.runners.start(startWorkflow());
    const second = harness({
      react: timerReact,
      store: first.store,
      seatTokens: first.seatTokens,
      specStore: first.specStore,
      world: new StubWorld().hang('*'),
    });
    second.runners.recover();
    await second.advance(5 * 60_000);
    expect(payloadsOf(second.events(), 'timer.fired')).toEqual([
      { timerId: TIMER },
    ]);
  });
});

describe('restart and global slot', () => {
  test('recover rebuilds state from events only', async () => {
    const first = await spawned();
    await first.runners.idle();
    const second = harness({
      store: first.store,
      seatTokens: first.seatTokens,
      specStore: first.specStore,
    });
    second.runners.recover();
    expect(second.runners.get(WORKFLOW_ID)?.state).toEqual(
      first.runners.get(WORKFLOW_ID)?.state,
    );
    expect(second.runners.get(WORKFLOW_ID)?.state).toEqual(
      replay(first.store.read({ workflowId: WORKFLOW_ID })).state,
    );
  });

  test('redo re-executes an issued command with its recorded args', async () => {
    const world = new StubWorld().script('openSession', 'hang');
    const first = harness({ world });
    await first.runners.start(startWorkflow());
    await flush();
    const second = harness({ store: first.store, world });
    second.runners.recover();
    const runner = second.runners.get(WORKFLOW_ID);
    expect(runner?.redo(`${WORKFLOW_ID}/open-session`)).toBe(true);
    expect(runner?.redo(`${WORKFLOW_ID}/ensure-branch`)).toBe(false);
    await second.runners.idle();
    const calls = world.callsOf('openSession');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(runner?.state.commands[`${WORKFLOW_ID}/open-session`]?.status).toBe(
      'succeeded',
    );
  });

  test('only one workflow may run; concurrent starts are serialized', async () => {
    const h = harness({ world: new StubWorld().hang('*') });
    const [a, b] = await Promise.all([
      h.runners.start(startWorkflow('wf-1')),
      h.runners.start(startWorkflow('wf-2')),
    ]);
    expect(a.ok).toBe(true);
    expect(b).toMatchObject({
      ok: false,
      error: { code: 'workflow_slot_busy' },
    });
    expect(h.runners.get('wf-2')).toBeUndefined();
    expect(h.runners.active()?.workflowId).toBe('wf-1');
  });

  test('commands for an unknown workflow are rejected', async () => {
    const h = harness();
    await expect(
      h.runners.dispatch('nope', {
        type: 'PauseWorkflow',
        meta: { occurredAt: START, source: 'user' },
        reason: 'anomaly',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'unknown_workflow' },
    });
  });

  test('observed events can be appended through the queue', async () => {
    const h = harness({ world: new StubWorld().hang('*') });
    await h.runners.start(startWorkflow());
    const runner = h.runners.get(WORKFLOW_ID);
    const stored = await runner?.append(
      [
        {
          type: 'workflow.paused',
          payload: { reason: 'anomaly' },
          occurredAt: START,
          workflowId: WORKFLOW_ID,
          source: 'scm',
          provenance: 'observed',
          schemaVersion: 1,
          externalKey: 'gh:x',
        },
      ],
      [{ source: 'scm', scope: 'repo', value: 'etag-1' }],
    );
    expect(stored).toHaveLength(1);
    expect(h.store.readCursor('scm', 'repo')).toBe('etag-1');
    expect(runner?.state.workflow?.pausedReasons).toEqual(['anomaly']);
  });
});

test('production meeting effects materialize through the runner and close with replayable absence', async () => {
  const h = harness({ react: engineReact });
  await h.runners.start(startWorkflow());
  await h.runners.idle();
  const state = () => h.runners.get(WORKFLOW_ID)!.state;
  const lead = Object.values(state().attempts).find(
    (a) => a.purpose === 'facilitator',
  )!;
  expect(h.world.callsOf('spawnAgent')).toHaveLength(1);
  expect(h.specStore.writes).toBe(1);
  const meta = { occurredAt: START, source: 'runtime' as const };
  await h.runners.dispatch(WORKFLOW_ID, {
    type: 'AcceptSubmission',
    meta,
    attemptId: lead.attemptId,
    submissionId: 'agenda',
    submission: {
      kind: 'agenda',
      payload: { topics: [{ id: 'scope', title: 'Scope', focusByRole: {} }] },
    },
  });
  await h.runners.dispatch(WORKFLOW_ID, {
    type: 'ObserveAttemptStatus',
    meta,
    attemptId: lead.attemptId,
    state: 'done',
  });
  await h.runners.idle();
  const participants = Object.values(state().attempts).filter(
    (a) => a.purpose === 'participant',
  );
  expect(participants).toHaveLength(3);
  expect(h.specStore.writes).toBe(4);
  for (const participant of participants)
    await h.runners.dispatch(WORKFLOW_ID, {
      type: 'ObserveAttemptStatus',
      meta,
      attemptId: participant.attemptId,
      state: 'done',
    });
  await h.runners.idle();
  expect(payloadsOf(h.events(), 'meeting.round_started')).toHaveLength(1);
  for (const participant of participants) {
    if (participant.role !== 'pm')
      await h.runners.dispatch(WORKFLOW_ID, {
        type: 'AcceptSubmission',
        meta,
        attemptId: participant.attemptId,
        submissionId: `statement-${participant.role}`,
        submission: {
          kind: 'statement',
          payload: {
            round: 1,
            position: 'Proceed',
            arguments: [],
            concerns: [],
            readyToConclude: true,
          },
        },
      });
    await h.runners.dispatch(WORKFLOW_ID, {
      type: 'ObserveAttemptStatus',
      meta,
      attemptId: participant.attemptId,
      state: 'done',
    });
  }
  await h.advance(5 * 60_000);
  await h.runners.idle();
  const absent = participants.find((a) => a.role === 'pm')!;
  expect(
    payloadsOf(h.events(), 'meeting.round_completed')[0]?.absentAttemptIds,
  ).toEqual([absent.attemptId]);
  await h.runners.dispatch(WORKFLOW_ID, {
    type: 'AcceptSubmission',
    meta: { ...meta, occurredAt: h.clock.now().toISOString() },
    attemptId: lead.attemptId,
    submissionId: 'conclusion',
    submission: {
      kind: 'conclusion',
      payload: {
        summary: 'Approved direction',
        decisions: [],
        techDecisions: [],
        openQuestions: [],
      },
    },
  });
  await h.runners.dispatch(WORKFLOW_ID, {
    type: 'ObserveAttemptStatus',
    meta: { ...meta, occurredAt: h.clock.now().toISOString() },
    attemptId: lead.attemptId,
    state: 'done',
  });
  await h.runners.idle();
  expect(payloadsOf(h.events(), 'gate.opened').at(-1)).toMatchObject({
    kind: 'stage',
    stageKind: 'meeting',
  });
  expect(Object.values(state().attempts).every((a) => a.released)).toBe(true);
  expect(payloadsOf(h.events(), 'error.recorded')).toEqual([]);
  expect(replay(h.events())).toEqual({ state: state(), warnings: [] });
});
