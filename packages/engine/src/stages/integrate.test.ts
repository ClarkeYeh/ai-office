import { describe, expect, it } from 'vitest';
import { createReact, DEFAULT_MODULES } from '../react.js';
import { Simulator, cooperativeWorld } from '../test-support/simulator.js';
import type { World } from '../test-support/simulator.js';
import { startWorkflow } from '../test-support/fixtures.js';

const setup = (
  world: World = cooperativeWorld,
  start = true,
  policies = [] as typeof DEFAULT_MODULES.policies,
  spawnStallMs?: number,
) => {
  const empty = { react: () => [] };
  const sim = new Simulator({
    world,
    react: createReact({
      ...DEFAULT_MODULES,
      stages: {
        ...DEFAULT_MODULES.stages,
        meeting: empty,
        planning: empty,
        implement: empty,
        ondemand: empty,
      },
      policies,
    }),
  });
  const command = startWorkflow();
  if (spawnStallMs) command.limits.spawnStallMs = spawnStallMs;
  sim.dispatch(command);
  for (const id of ['meeting', 'breakdown', 'implement'])
    sim.state.stages[id] = {
      ...sim.state.stages[id]!,
      status: 'done',
      attempt: 1,
    };
  if (start) sim.dispatch({ type: 'StartStage', stageId: 'integrate' });
  return sim;
};
const DAY = 24 * 60 * 60_000;
const report = (sim: Simulator) => {
  const attempt = Object.values(sim.state.attempts).at(-1)!;
  sim.dispatch({
    type: 'AcceptSubmission',
    attemptId: attempt.attemptId,
    submissionId: `report-${attempt.stageAttempt}`,
    submission: {
      kind: 'integration-report',
      payload: {
        summary: 'Verified all changes',
        merged: [],
        verification: [{ command: 'pnpm test', ok: true }],
        risks: [],
      },
    },
  });
  return sim;
};
const merge = (sim: Simulator) =>
  sim.inject('pr.status', {
    pr: 2,
    state: 'merged',
    head: sim.state.workflow!.integrationBranch,
    base: 'main',
    headSha: 'abcdef1',
    mergeCommitSha: 'abcdef2',
    mergeable: true,
  });
const finalGate = (sim: Simulator) =>
  Object.values(sim.state.gates)
    .filter((g) => g.kind === 'stage' && g.stageKind === 'final-pr')
    .at(-1)!;

describe('wrap-up and final PR', () => {
  it('prepares the remote integration branch, publishes after stop, and completes only on observed merge', () => {
    const sim = report(setup());
    expect(
      sim.issued.find((e) => e.command.kind === 'runtime.prepareWorkspace')
        ?.command,
    ).toMatchObject({
      args: {
        checkoutExisting: true,
        fetchBranch: sim.state.workflow!.integrationBranch,
        baseBranch: `origin/${sim.state.workflow!.integrationBranch}`,
      },
    });
    expect(Object.values(sim.state.attempts)[0]).toMatchObject({
      purpose: 'integrator',
      keepOpen: false,
      released: true,
    });
    expect(sim.state.workflow).toMatchObject({ finalPr: 2, status: 'running' });
    expect(finalGate(sim).status).toBe('open');
    const publish = sim
      .eventsOf('command.issued')
      .find((e) => e.payload.kind === 'scm.openPR')!;
    expect(sim.eventsOf('seat.exited')[0]!.seq).toBeLessThan(publish.seq);
    expect(sim.issued.some((e) => e.command.kind === 'scm.mergePR')).toBe(
      false,
    );
    merge(sim);
    expect(sim.state.workflow?.status).toBe('completed');
    expect(sim.eventsOf('gate.closed').at(-1)?.payload.reason).toBe('merged');
    expect(sim.rejections).toEqual([]);
    expect(sim.warnings).toEqual([]);
  });
  it('updates the same PR across two revisions and then offers only keep-open and abort', () => {
    const sim = report(setup());
    for (let i = 0; i < 2; i++) {
      sim.dispatch({
        type: 'DecideGate',
        gateId: finalGate(sim).gateId,
        expectedVersion: 1,
        by: 'user',
        decision: 'reject',
        comment: 'Improve verification',
      });
      expect(sim.state.stages.integrate?.mode).toBe('revision');
      report(sim);
    }
    expect(finalGate(sim).options.map((o) => o.optionId)).toEqual([
      'keep-open',
      'abort',
    ]);
    expect(
      sim.issued.filter((e) => e.command.kind === 'scm.openPR'),
    ).toHaveLength(1);
    expect(
      sim.issued.filter((e) => e.command.kind === 'scm.updatePR'),
    ).toHaveLength(2);
    expect(
      sim.issued.filter((e) => e.command.kind === 'scm.comment'),
    ).toHaveLength(2);
    merge(sim);
    expect(sim.state.workflow?.status).toBe('completed');
    expect(sim.rejections).toEqual([]);
  });
  it('continues observing merge after keep-open', () => {
    const sim = report(setup());
    sim.dispatch({
      type: 'DecideGate',
      gateId: finalGate(sim).gateId,
      expectedVersion: 1,
      by: 'user',
      decision: 'option',
      optionId: 'keep-open',
    });
    merge(sim);
    expect(sim.state.workflow?.status).toBe('completed');
  });
  it('opens and answers a wrap-up decision request without publishing', () => {
    const sim = setup();
    const attempt = Object.values(sim.state.attempts)[0]!;
    sim.dispatch({
      type: 'AcceptSubmission',
      submissionId: 'decision',
      attemptId: attempt.attemptId,
      submission: {
        kind: 'decision-request',
        payload: {
          reason: 'scope-change',
          question: 'Proceed?',
          options: ['Proceed'],
        },
      },
    });
    const gate = Object.values(sim.state.gates)[0]!;
    expect(gate).toMatchObject({
      kind: 'exception',
      exceptionKind: 'decision-request',
    });
    sim.dispatch({
      type: 'DecideGate',
      gateId: gate.gateId,
      expectedVersion: 1,
      by: 'user',
      decision: 'option',
      optionId: 'choice-1',
    });
    expect(sim.issued.at(-1)?.command).toMatchObject({
      kind: 'runtime.send',
      args: { body: 'Proceed\n' },
    });
    report(sim);
    expect(finalGate(sim).status).toBe('open');
    expect(sim.rejections).toEqual([]);
  });
  it('rejects unmerged work before spawning', () => {
    const sim = setup(cooperativeWorld, false);
    sim.state.workItems.pending = {
      key: 'pending',
      title: 'Pending',
      body: '',
      acceptance: [],
      role: 'engineer',
      agent: 'codex',
      deps: [],
      status: 'pr_open',
      approvedGateId: 'approved',
      attemptIds: [],
      attempt: 1,
      rework: 0,
    };
    sim.dispatch({ type: 'StartStage', stageId: 'integrate' });
    expect(sim.eventsOf('seat.spawned')).toHaveLength(0);
    expect(sim.eventsOf('gate.opened')[0]?.payload).toMatchObject({
      exceptionKind: 'stage-violation',
    });
  });
  it('nudges missing output then opens an exception', () => {
    const sim = setup().advance(65 * 60_000);
    expect(sim.eventsOf('message.nudge')).toHaveLength(1);
    expect(sim.eventsOf('gate.opened')[0]?.payload).toMatchObject({
      exceptionKind: 'stage-violation',
    });
  });
  it('removes the kept wrap-up worktree before a rerun checks the integration branch out again (W1)', () => {
    // Silent simulated agents would otherwise hit the spawn-stall rule first.
    const sim = setup(
      cooperativeWorld,
      true,
      DEFAULT_MODULES.policies,
      DAY,
    ).advance(65 * 60_000);
    const gate = sim.eventsOf('gate.opened')[0]!.payload;
    expect(gate).toMatchObject({ exceptionKind: 'stage-violation' });
    expect(
      sim.issued.find((c) => c.command.kind === 'runtime.release')?.command,
    ).toMatchObject({ args: { removeWorkspace: false } });
    sim.dispatch({
      type: 'DecideGate',
      gateId: gate.gateId,
      expectedVersion: 1,
      decision: 'option',
      optionId: 'rerun',
      by: 'user',
    });
    const steps = sim.issued
      .filter((c) =>
        ['runtime.prepareWorkspace', 'runtime.disposeWorkspace'].includes(
          c.command.kind,
        ),
      )
      .map((c) =>
        c.command.kind === 'runtime.prepareWorkspace'
          ? `prepare ${c.command.args.name}`
          : c.command.kind === 'runtime.disposeWorkspace'
            ? `dispose ${c.command.args.workspace}`
            : '',
      );
    expect(steps).toEqual([
      'prepare aio-ab12-wrap-up-r1',
      'dispose ws:aio-ab12-wrap-up-r1',
      'prepare aio-ab12-wrap-up-r2',
    ]);
    expect(sim.state.stages.integrate?.attempt).toBe(2);
    expect(sim.rejections).toEqual([]);
  });
  it('escalates when an earlier wrap-up worktree cannot be removed', () => {
    const sim = setup(
      (issued, current) =>
        issued.command.kind === 'runtime.disposeWorkspace'
          ? {
              ok: false,
              error: {
                category: 'guard',
                code: 'worktree_dirty',
                message: 'dirty',
                retryable: false,
              },
            }
          : cooperativeWorld(issued, current),
      true,
      DEFAULT_MODULES.policies,
      DAY,
    ).advance(65 * 60_000);
    sim.dispatch({
      type: 'DecideGate',
      gateId: sim.eventsOf('gate.opened')[0]!.payload.gateId,
      expectedVersion: 1,
      decision: 'option',
      optionId: 'rerun',
      by: 'user',
    });
    expect(
      sim.issued.filter((c) => c.command.kind === 'runtime.prepareWorkspace'),
    ).toHaveLength(1);
    expect(sim.eventsOf('gate.opened').at(-1)?.payload).toMatchObject({
      exceptionKind: 'stage-violation',
      content: { summary: 'An earlier wrap-up worktree could not be removed' },
    });
  });
  it('does not publish while a stopped agent remains possibly live', () => {
    const sim = setup((issued, current) =>
      ['runtime.stop', 'runtime.release'].includes(issued.command.kind)
        ? undefined
        : cooperativeWorld(issued, current),
    );
    report(sim);
    expect(sim.state.workflow?.finalPr).toBeUndefined();
    expect(sim.liveAgents()).toBe(1);
  });
});

it('keeps the final gate closed for a lost on-demand attempt arriving during publication', () => {
  const sim = report(
    setup((issued, current) =>
      issued.command.kind === 'scm.openPR'
        ? undefined
        : cooperativeWorld(issued, current),
    ),
  );
  const old = sim.eventsOf('seat.spawned')[0]!.payload;
  sim.inject('seat.spawned', {
    ...old,
    attemptId: 'late-oncall',
    stageId: 'implement',
    purpose: 'oncall',
    ondemand: { purpose: 'oncall' },
    spawnCommandId: 'late-spawn',
  });
  sim.inject('seat.status', { attemptId: 'late-oncall', state: 'lost' });
  const published = sim.issued.find((e) => e.command.kind === 'scm.openPR')!;
  sim.inject(
    'command.succeeded',
    {
      commandId: published.commandId,
      kind: 'scm.openPR',
      result: { pr: 2, url: 'https://github.com/octo/demo/pull/2' },
    },
    { stageId: 'final-pr' },
  );
  expect(sim.eventsOf('gate.opened')).toHaveLength(0);
  sim.advance(90_000);
  expect(sim.eventsOf('gate.opened').at(-1)?.payload).toMatchObject({
    kind: 'exception',
    exceptionKind: 'anomaly',
  });
  expect(sim.state.workflow?.pausedReasons).toContain('anomaly');
});

it('waits for preexisting on-demand instances before preparing wrap-up', () => {
  const sim = setup(cooperativeWorld, false);
  sim.inject('seat.spawned', {
    attemptId: 'old-oncall',
    attempt: 1,
    seatId: 'wf-1/lead',
    stageId: 'implement',
    role: 'lead',
    agent: 'claude-code',
    purpose: 'oncall',
    ondemand: { purpose: 'oncall' },
    keepOpen: true,
    spawnCommandId: 'old-spawn',
  });
  sim.dispatch({ type: 'StartStage', stageId: 'integrate' });
  expect(
    sim.issued.some((e) => e.command.kind === 'runtime.prepareWorkspace'),
  ).toBe(false);
  sim.dispatch({
    type: 'ReleaseAttempt',
    attemptId: 'old-oncall',
    removeWorkspace: false,
  });
  expect(
    sim.issued.some((e) => e.command.kind === 'runtime.prepareWorkspace'),
  ).toBe(true);
});

it('escalates when wrap-up stop never settles', () => {
  const sim = report(
    setup((issued, current) =>
      ['runtime.stop', 'runtime.release'].includes(issued.command.kind)
        ? undefined
        : cooperativeWorld(issued, current),
    ),
  ).advance(60 * 60_000);
  expect(sim.eventsOf('gate.opened').at(-1)?.payload).toMatchObject({
    exceptionKind: 'stage-violation',
  });
  expect(sim.state.workflow?.finalPr).toBeUndefined();
});

it('does not finish an early merge during a requested revision', () => {
  const sim = report(setup());
  sim.dispatch({
    type: 'DecideGate',
    gateId: finalGate(sim).gateId,
    expectedVersion: 1,
    by: 'user',
    decision: 'reject',
    comment: 'Fix tests',
  });
  merge(sim);
  expect(sim.state.workflow?.status).toBe('running');
  expect(sim.eventsOf('gate.closed')).toHaveLength(0);
});

it('publishes traceable conclusions, technical choices, worker PRs, checks, and risks', () => {
  const sim = setup(cooperativeWorld, false);
  for (const [key, status, pr, issue] of [
    ['merged', 'merged', 10, 5],
    ['skipped', 'skipped', undefined, 6],
    ['failed', 'failed', undefined, undefined],
  ] as const) {
    sim.state.workItems[key] = {
      key,
      title: key,
      body: '',
      acceptance: [],
      role: 'engineer',
      agent: 'codex',
      deps: [],
      status,
      attempt: 1,
      approvedGateId: 'approved',
      attemptIds: [],
      ...(pr ? { pr } : {}),
      ...(issue ? { issue } : {}),
    };
    sim.state.workItemOrder.push(key);
  }
  sim.state.artifacts.conclusion = {
    kind: 'issue',
    artifactId: 'conclusion',
    purpose: 'conclusion',
    number: 1,
    url: 'https://github.com/octo/demo/issues/1',
    createdAt: sim.clock,
  };
  sim.state.gates.conclusion = {
    kind: 'stage',
    gateId: 'conclusion',
    stageId: 'meeting',
    stageKind: 'meeting',
    templateGateId: 'conclusion',
    title: 'Conclusion',
    optional: true,
    options: [],
    content: {
      type: 'conclusion',
      artifactId: 'conclusion',
      renderedHash: 'a'.repeat(64),
    },
    version: 1,
    openedAt: sim.clock,
    status: 'approved',
    decision: {
      gateId: 'conclusion',
      version: 1,
      decision: 'approve',
      by: 'user',
      decidedAt: sim.clock,
      approvedSnapshot: {
        source: 'github',
        body: 'Use SQLite',
        bodyHash: 'a'.repeat(64),
        structured: null,
      },
    },
  };
  sim.dispatch({ type: 'StartStage', stageId: 'integrate' });
  const attempt = Object.values(sim.state.attempts)[0]!;
  sim.dispatch({
    type: 'AcceptSubmission',
    attemptId: attempt.attemptId,
    submissionId: 'rich-report',
    artifactId: 'rich-artifact',
    submission: {
      kind: 'integration-report',
      payload: {
        summary: 'Validated',
        merged: [10],
        verification: [
          { command: 'test', ok: true },
          { command: 'optional check', ok: false },
        ],
        risks: ['Optional check needs manual review'],
      },
    },
  });
  const published = sim.issued.find(
    (e) => e.command.kind === 'scm.openPR',
  )!.command;
  expect(published.kind).toBe('scm.openPR');
  if (published.kind !== 'scm.openPR') throw new Error('Missing PR');
  expect(published.args.body).toContain(
    'https://github.com/octo/demo/issues/1',
  );
  expect(published.args.body).toContain('Use SQLite');
  expect(published.args.body).toContain('worker PR #10');
  expect(published.args.body).toContain('Closes #5');
  expect(published.args.body).not.toContain('Closes #6');
  expect(published.args.body).toContain('[ ] optional check');
  expect(published.args.body).toContain('Optional check needs manual review');
  expect(published.args.body).toContain('<!-- ai-office:cmd=');
  expect(finalGate(sim).content).toMatchObject({ artifactId: 'rich-artifact' });
  expect(sim.rejections).toEqual([]);
});
