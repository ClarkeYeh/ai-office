import { describe, expect, it } from 'vitest';
import { createReact, DEFAULT_MODULES } from '../react.js';
import { Simulator, cooperativeWorld } from '../test-support/simulator.js';
import type { World } from '../test-support/simulator.js';
import { startWorkflow } from '../test-support/fixtures.js';

const setup = (world: World = cooperativeWorld, start = true) => {
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
      policies: [],
    }),
  });
  sim.dispatch(startWorkflow());
  for (const id of ['meeting', 'breakdown', 'implement'])
    sim.state.stages[id] = {
      ...sim.state.stages[id]!,
      status: 'done',
      attempt: 1,
    };
  if (start) sim.dispatch({ type: 'StartStage', stageId: 'integrate' });
  return sim;
};
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
  it('wraps up a report accepted while paused once the workflow resumes', () => {
    const sim = setup();
    sim.dispatch({ type: 'PauseWorkflow', reason: 'hijacked' });
    report(sim);
    expect(sim.liveAgents()).toBe(1);
    sim.dispatch({ type: 'ResumeWorkflow', reason: 'hijacked' });
    expect(sim.liveAgents()).toBe(0);
    expect(sim.state.stages.integrate?.status).toBe('done');
    expect(sim.state.workflow?.finalPr).toBe(2);
    expect(sim.rejections).toEqual([]);
  });
});

describe('re-evaluation on resume', () => {
  const pause = (sim: Simulator) =>
    sim.dispatch({ type: 'PauseWorkflow', reason: 'hijacked' });
  const resume = (sim: Simulator) =>
    sim.dispatch({ type: 'ResumeWorkflow', reason: 'hijacked' });
  const withhold =
    (kind: string): World =>
    (issued, current) =>
      issued.command.kind === kind
        ? undefined
        : cooperativeWorld(issued, current);
  const answer = (sim: Simulator, kind: string, result: object) => {
    const issued = sim.issued.find((e) => e.command.kind === kind)!;
    sim.inject(
      'command.succeeded',
      { commandId: issued.commandId, kind, result } as never,
      { stageId: 'final-pr' },
    );
  };

  it('completes on a final PR merge observed while paused', () => {
    const sim = report(setup());
    expect(finalGate(sim).status).toBe('open');
    pause(sim);
    merge(sim);
    expect(finalGate(sim).status).toBe('open');
    expect(sim.state.workflow?.status).toBe('running');
    resume(sim);
    expect(finalGate(sim)).toMatchObject({
      status: 'closed',
      closedReason: 'merged',
    });
    expect(sim.state.workflow?.status).toBe('completed');
    expect(sim.rejections).toEqual([]);
  });
  it('completes on a merge observed while paused after keep-open', () => {
    const sim = report(setup());
    sim.dispatch({
      type: 'DecideGate',
      gateId: finalGate(sim).gateId,
      expectedVersion: 1,
      by: 'user',
      decision: 'option',
      optionId: 'keep-open',
    });
    pause(sim);
    merge(sim);
    resume(sim);
    expect(sim.state.workflow?.status).toBe('completed');
  });
  it('waits for every pause reason before acting', () => {
    const sim = report(setup());
    pause(sim);
    sim.dispatch({ type: 'PauseWorkflow', reason: 'budget' });
    merge(sim);
    resume(sim);
    expect(sim.state.workflow?.status).toBe('running');
    sim.dispatch({ type: 'ResumeWorkflow', reason: 'budget' });
    expect(sim.state.workflow?.status).toBe('completed');
  });
  it('records and gates a final PR opened while paused', () => {
    const sim = report(setup(withhold('scm.openPR')));
    pause(sim);
    answer(sim, 'scm.openPR', {
      pr: 2,
      url: 'https://github.com/octo/demo/pull/2',
    });
    expect(sim.state.workflow?.finalPr).toBeUndefined();
    resume(sim);
    expect(sim.state.workflow?.finalPr).toBe(2);
    expect(sim.state.stages['final-pr']?.status).toBe('awaiting_gate');
    expect(finalGate(sim).status).toBe('open');
    merge(sim);
    expect(sim.state.workflow?.status).toBe('completed');
    expect(sim.rejections).toEqual([]);
  });
  it('opens the gate for a revision published while paused', () => {
    const sim = report(setup(withhold('scm.updatePR')));
    sim.dispatch({
      type: 'DecideGate',
      gateId: finalGate(sim).gateId,
      expectedVersion: 1,
      by: 'user',
      decision: 'reject',
      comment: 'Improve verification',
    });
    report(sim);
    expect(sim.eventsOf('gate.opened')).toHaveLength(1);
    pause(sim);
    answer(sim, 'scm.updatePR', {});
    resume(sim);
    expect(finalGate(sim).status).toBe('open');
    expect(sim.eventsOf('gate.opened')).toHaveLength(2);
    expect(sim.rejections).toEqual([]);
  });
  it('starts a revision requested while paused', () => {
    const sim = report(setup());
    pause(sim);
    sim.dispatch({
      type: 'DecideGate',
      gateId: finalGate(sim).gateId,
      expectedVersion: 1,
      by: 'user',
      decision: 'reject',
      comment: 'Fix tests',
    });
    expect(sim.state.stages.integrate?.status).toBe('done');
    resume(sim);
    expect(sim.state.stages.integrate).toMatchObject({
      status: 'running',
      mode: 'revision',
    });
    expect(sim.liveAgents()).toBe(1);
    expect(sim.rejections).toEqual([]);
  });
  it('opens and answers a decision request raised and decided while paused', () => {
    const sim = setup();
    const attempt = Object.values(sim.state.attempts)[0]!;
    pause(sim);
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
    expect(Object.values(sim.state.gates)).toHaveLength(0);
    resume(sim);
    const gate = Object.values(sim.state.gates)[0]!;
    expect(gate).toMatchObject({ exceptionKind: 'decision-request' });
    pause(sim);
    sim.dispatch({
      type: 'DecideGate',
      gateId: gate.gateId,
      expectedVersion: 1,
      by: 'user',
      decision: 'option',
      optionId: 'choice-1',
    });
    expect(sim.issued.some((e) => e.command.kind === 'runtime.send')).toBe(
      false,
    );
    resume(sim);
    expect(sim.issued.at(-1)?.command).toMatchObject({
      kind: 'runtime.send',
      args: { body: 'Proceed\n' },
    });
    expect(sim.rejections).toEqual([]);
  });
  it('prepares wrap-up once agents that ended while paused are gone', () => {
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
    pause(sim);
    sim.dispatch({
      type: 'ReleaseAttempt',
      attemptId: 'old-oncall',
      removeWorkspace: false,
    });
    expect(
      sim.issued.some((e) => e.command.kind === 'runtime.prepareWorkspace'),
    ).toBe(false);
    resume(sim);
    expect(
      sim.issued.some((e) => e.command.kind === 'runtime.prepareWorkspace'),
    ).toBe(true);
  });
  it('replays nothing already acted on', () => {
    const sim = report(setup());
    const events = sim.events.length;
    pause(sim);
    resume(sim);
    expect(sim.events.slice(events).map((e) => e.type)).toEqual([
      'workflow.paused',
      'workflow.resumed',
    ]);
    pause(sim);
    merge(sim);
    resume(sim);
    expect(sim.eventsOf('gate.closed')).toHaveLength(1);
    expect(sim.eventsOf('workflow.completed')).toHaveLength(1);
    expect(sim.rejections).toEqual([]);
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
