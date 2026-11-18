import { describe, expect, it } from 'vitest';
import type { WorkItem } from '@ai-office/domain';
import { createReact, DEFAULT_MODULES } from '../react.js';
import { cooperativeWorld, Simulator } from '../test-support/simulator.js';
import { startWorkflow } from '../test-support/fixtures.js';
import { runMeeting } from '../test-support/meeting.js';
import { DEFAULT_SPAWN_STALL_MS, spawnStallGateId } from './spawn-stall.js';

const MIN = 60_000;
const sha = (n: number) => n.toString(16).padStart(40, 'a');
const item = (key: string): WorkItem => ({
  key,
  title: key,
  body: `Implement ${key}`,
  acceptance: ['Works'],
  deps: [],
  role: 'engineer',
  agent: 'codex',
  status: 'approved',
  approvedGateId: 'approved',
  attemptIds: [],
  attempt: 0,
  issue: 10,
});

/** One implement worker under the default policies; the simulated agent stays silent. */
function setup(spawnStallMs: number | null = 10 * MIN) {
  const empty = { react: () => [] };
  const sim = new Simulator({
    react: createReact({
      ...DEFAULT_MODULES,
      stages: {
        ...DEFAULT_MODULES.stages,
        meeting: empty,
        planning: empty,
        integrate: empty,
        ondemand: empty,
      },
    }),
    world: (issued, current) =>
      issued.command.kind === 'scm.compareBranch'
        ? { ok: true, result: { ahead: 1, headSha: sha(1) } }
        : cooperativeWorld(issued, current),
  });
  const start = startWorkflow();
  if (spawnStallMs !== null) start.limits.spawnStallMs = spawnStallMs;
  sim.dispatch(start);
  sim.state.stages.meeting!.status = 'done';
  sim.state.stages.breakdown!.status = 'done';
  sim.state.workItems = { A: item('A') };
  sim.state.workItemOrder = ['A'];
  sim.dispatch({ type: 'StartStage', stageId: 'implement' });
  return sim;
}
const activity = (category: 'read' | 'edit') => ({
  messageId: 'm1',
  category,
  inputLen: 1,
  outputLen: 1,
  inputHash: 'h1',
});
const current = (sim: Simulator) =>
  sim.state.attempts[sim.state.workItems.A!.currentAttemptId!]!;
const stallNudges = (sim: Simulator) =>
  sim
    .eventsOf('message.nudge')
    .filter((e) => e.payload.reason === 'spawn-stall');
const stallGates = (sim: Simulator) =>
  sim
    .eventsOf('gate.opened')
    .filter((e) => e.payload.kind === 'exception')
    .filter(
      (e) =>
        e.payload.kind === 'exception' &&
        e.payload.exceptionKind === 'spawn-stall',
    );
const noErrors = (sim: Simulator) => {
  expect(
    sim.eventsOf('seat.status').filter((e) => e.payload.state === 'error'),
  ).toEqual([]);
  expect(sim.rejections).toEqual([]);
};

describe('spawn stall (§7.1, §8.3)', () => {
  it('nudges exactly once after one period, then stops and opens one spawn-stall gate', () => {
    const sim = setup();
    const a = current(sim);
    sim.advance(10 * MIN - 1);
    expect(stallNudges(sim)).toHaveLength(0);
    sim.advance(1);
    expect(stallNudges(sim)).toHaveLength(1);
    expect(
      sim.issued.filter(
        (c) => c.command.kind === 'runtime.send' && c.attemptId === a.attemptId,
      ),
    ).toHaveLength(1);
    expect(stallGates(sim)).toHaveLength(0);
    expect(
      sim.issued.filter((c) => c.command.kind === 'runtime.stop'),
    ).toHaveLength(0);
    sim.advance(10 * MIN);
    expect(stallNudges(sim)).toHaveLength(1);
    const stop = sim.issued.findIndex(
      (c) => c.command.kind === 'runtime.stop' && c.attemptId === a.attemptId,
    );
    expect(stop).toBeGreaterThanOrEqual(0);
    const gates = stallGates(sim);
    expect(gates).toHaveLength(1);
    expect(gates[0]!.payload).toMatchObject({
      gateId: spawnStallGateId(
        { workflowId: sim.state.workflowId! },
        a.attemptId,
      ),
      stageId: 'implement',
      options: [
        { optionId: 'retry' },
        { optionId: 'reassign', input: 'agent' },
        { optionId: 'abort' },
      ],
      content: { attemptId: a.attemptId, itemKey: 'A' },
    });
    // The stop was issued before the gate opened.
    expect(
      sim.events.findIndex(
        (e) =>
          e.type === 'command.issued' &&
          e.payload.kind === 'runtime.stop' &&
          e.attemptId === a.attemptId,
      ),
    ).toBeLessThan(sim.events.indexOf(gates[0]!));
    // Item timers of the stalled attempt are cancelled; nothing else fires later.
    sim.advance(60 * MIN);
    expect(stallGates(sim)).toHaveLength(1);
    expect(
      sim.eventsOf('gate.opened').filter((e) => e.payload.kind === 'exception'),
    ).toHaveLength(1);
    noErrors(sim);
  });

  it('defaults to 600000 ms when the workflow snapshot has no spawnStallMs', () => {
    const sim = setup(null);
    expect(sim.state.workflow!.limits.spawnStallMs).toBeUndefined();
    sim.advance(DEFAULT_SPAWN_STALL_MS - 1);
    expect(stallNudges(sim)).toHaveLength(0);
    sim.advance(1);
    expect(stallNudges(sim)).toHaveLength(1);
  });

  it.each([
    [
      'activity',
      (sim: Simulator, attemptId: string) =>
        sim.dispatch(
          {
            type: 'RecordAttemptActivity',
            attemptId,
            activity: [activity('read')],
          },
          'runtime',
        ),
    ],
    [
      'an exit',
      (sim: Simulator, attemptId: string) =>
        sim.dispatch(
          {
            type: 'RecordAttemptExited',
            attemptId,
            reason: 'crashed',
            expected: true,
          },
          'runtime',
        ),
    ],
  ])('%s before the first period cancels the timer', (_name, act) => {
    const sim = setup();
    sim.advance(5 * MIN);
    act(sim, current(sim).attemptId);
    expect(
      sim
        .eventsOf('timer.cancelled')
        .filter((e) => e.payload.timerId.includes('/spawn-stall/')),
    ).toHaveLength(1);
    sim.advance(30 * MIN);
    expect(stallNudges(sim)).toHaveLength(0);
    expect(stallGates(sim)).toHaveLength(0);
  });

  it('activity after the nudge cancels the second period', () => {
    const sim = setup();
    sim.advance(15 * MIN);
    expect(stallNudges(sim)).toHaveLength(1);
    sim.dispatch(
      {
        type: 'RecordAttemptActivity',
        attemptId: current(sim).attemptId,
        activity: [activity('edit')],
      },
      'runtime',
    );
    sim.advance(30 * MIN);
    expect(stallGates(sim)).toHaveLength(0);
    expect(
      sim.issued.filter((c) => c.command.kind === 'runtime.stop'),
    ).toHaveLength(0);
    noErrors(sim);
  });

  it('a later send to a keep-open agent never re-arms the rule', () => {
    const sim = setup();
    const a = current(sim);
    sim.dispatch(
      {
        type: 'RecordAttemptActivity',
        attemptId: a.attemptId,
        activity: [activity('read')],
      },
      'runtime',
    );
    const scheduled = () =>
      sim
        .eventsOf('timer.scheduled')
        .filter((e) => e.payload.payload.purpose === 'spawn-stall');
    expect(scheduled()).toHaveLength(1);
    sim.dispatch({
      type: 'ObserveAttemptStatus',
      attemptId: a.attemptId,
      state: 'working',
    });
    sim.advance(30 * MIN);
    expect(scheduled()).toHaveLength(1);
    expect(stallNudges(sim)).toHaveLength(0);
  });

  it.each([
    ['retry', {}, 'codex'],
    ['reassign', { agent: 'claude-code' as const }, 'claude-code'],
  ])('%s dispatches a fresh attempt for the item', (optionId, extra, agent) => {
    const sim = setup();
    const stalled = current(sim);
    sim.advance(20 * MIN);
    sim.dispatch(
      {
        type: 'RecordAttemptExited',
        attemptId: stalled.attemptId,
        reason: 'stopped',
        expected: true,
      },
      'runtime',
    );
    sim.dispatch({
      type: 'DecideGate',
      gateId: stallGates(sim)[0]!.payload.gateId,
      expectedVersion: 1,
      decision: 'option',
      optionId,
      by: 'user',
      ...extra,
    });
    const item = sim.state.workItems.A!;
    expect(item).toMatchObject({ attempt: 2, agent, status: 'in_progress' });
    expect(item.currentAttemptId).not.toBe(stalled.attemptId);
    // The fresh attempt is watched again.
    sim.advance(10 * MIN);
    expect(stallNudges(sim).map((e) => e.payload.attemptId)).toEqual([
      stalled.attemptId,
      item.currentAttemptId,
    ]);
    noErrors(sim);
  });

  it('abort cancels the workflow', () => {
    const sim = setup();
    sim.advance(20 * MIN);
    sim.dispatch({
      type: 'DecideGate',
      gateId: stallGates(sim)[0]!.payload.gateId,
      expectedVersion: 1,
      decision: 'option',
      optionId: 'abort',
      by: 'user',
    });
    expect(sim.state.workflow!.cancelRequested).toBe(true);
    noErrors(sim);
  });

  it('opens no second gate when another exception already covers the item', () => {
    const sim = setup(30 * MIN);
    // The 45-minute item limit opens its gate before the stall gate is due (60).
    sim.advance(60 * MIN);
    const exceptions = sim
      .eventsOf('gate.opened')
      .filter((e) => e.payload.kind === 'exception');
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]!.payload).toMatchObject({
      exceptionKind: 'item-budget-exceeded',
    });
    expect(stallNudges(sim)).toHaveLength(1);
    // The gate that expired first owns the attempt: the stall rule does not stop it.
    expect(
      sim.issued.filter((c) => c.command.kind === 'runtime.stop'),
    ).toHaveLength(0);
    noErrors(sim);
  });

  it('pauses with the workflow and re-checks one period later', () => {
    const sim = setup();
    sim.dispatch({ type: 'PauseWorkflow', reason: 'runtime_unhealthy' });
    sim.advance(10 * MIN);
    expect(stallNudges(sim)).toHaveLength(0);
    sim.dispatch({ type: 'ResumeWorkflow', reason: 'runtime_unhealthy' });
    sim.advance(10 * MIN);
    expect(stallNudges(sim)).toHaveLength(1);
  });
});

describe('spawn stall for a stage agent', () => {
  const planner = (sim: Simulator) =>
    Object.values(sim.state.attempts).filter((a) => a.purpose === 'planner');

  it('a submission cancels the timer', () => {
    const sim = runMeeting({ planning: true }, true);
    const [lead] = planner(sim);
    expect(lead?.submissions['work-items']).toBeDefined();
    expect(
      sim
        .eventsOf('timer.cancelled')
        .filter(
          (e) =>
            e.payload.timerId.includes('/spawn-stall/') &&
            e.payload.timerId.includes(lead!.attemptId),
        )
        .map((e) => e.payload.reason),
    ).toEqual(['activity']);
    expect(stallNudges(sim)).toHaveLength(0);
  });

  it('retry reruns the stage with a fresh agent; reassign overrides it', () => {
    const sim = runMeeting({}, true).advance(20 * MIN);
    const [stalled] = planner(sim);
    const gate = stallGates(sim)[0]!.payload;
    expect(gate).toMatchObject({
      stageId: 'breakdown',
      content: { attemptId: stalled!.attemptId },
    });
    expect(gate.content).not.toHaveProperty('itemKey');
    sim.dispatch(
      {
        type: 'RecordAttemptExited',
        attemptId: stalled!.attemptId,
        reason: 'stopped',
        expected: true,
      },
      'runtime',
    );
    sim.dispatch({
      type: 'DecideGate',
      gateId: gate.gateId,
      expectedVersion: 1,
      decision: 'option',
      optionId: 'reassign',
      agent: 'codex',
      by: 'user',
    });
    expect(sim.state.stages.breakdown).toMatchObject({
      attempt: 2,
      status: 'running',
      agentOverride: 'codex',
    });
    expect(planner(sim)).toHaveLength(2);
    expect(planner(sim)[1]).toMatchObject({ agent: 'codex' });
    noErrors(sim);
  });
});
