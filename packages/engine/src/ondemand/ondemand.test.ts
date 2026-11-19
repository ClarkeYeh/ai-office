import { describe, expect, it } from 'vitest';
import { createReact, DEFAULT_MODULES } from '../react.js';
import { startWorkflow } from '../test-support/fixtures.js';
import { cooperativeWorld, Simulator } from '../test-support/simulator.js';
import type { World } from '../test-support/simulator.js';
import { MINUTE_MS } from '../timers.js';

const setup = (world: World = cooperativeWorld) => {
  const noop = { react: () => [] };
  const sim = new Simulator({
    world,
    react: createReact({
      ...DEFAULT_MODULES,
      stages: {
        ...DEFAULT_MODULES.stages,
        meeting: noop,
        planning: noop,
        implement: noop,
        integrate: noop,
        'final-pr': noop,
      },
    }),
  });
  sim.dispatch(startWorkflow());
  sim.state.stages.meeting!.status = 'done';
  sim.state.stages.breakdown!.status = 'done';
  sim.dispatch({ type: 'StartStage', stageId: 'implement' });
  sim.inject('workitem.approved', {
    gateId: 'tasks',
    items: ['A', 'B', 'C', 'D'].map((key) => ({
      key,
      title: key,
      body: 'Build it',
      acceptance: ['Tests pass'],
      role: 'engineer',
      agent: 'codex',
      deps: [],
    })),
  });
  for (const key of ['A', 'B', 'C', 'D']) {
    sim.dispatch({
      type: 'DispatchWorkItem',
      itemKey: key,
      attemptId: `worker-${key}`,
      baseSha: 'abcdef1',
    });
    sim.dispatch({
      type: 'SpawnAttempt',
      stageId: 'implement',
      role: 'engineer',
      itemKey: key,
      attemptId: `worker-${key}`,
      purpose: 'worker',
      keepOpen: false,
      spawnCommandId: `spawn-${key}`,
    });
    for (const status of ['in_progress', 'pushed', 'pr_open'] as const)
      sim.dispatch({
        type: 'UpdateWorkItemStatus',
        update: { itemKey: key, status },
      });
  }
  return sim;
};
const enqueue = (sim: Simulator, key: string, pr = 11) =>
  sim.dispatch({
    type: 'QueueWorkItemForMerge',
    item: { itemKey: key, attemptId: `worker-${key}`, pr, headSha: 'abcdef2' },
  });
const instance = (sim: Simulator, purpose: 'merge' | 'oncall' = 'merge') =>
  sim.state.ondemand.implement![purpose]!;
const merge = (sim: Simulator, id: string, pr: number) =>
  sim.dispatch({
    type: 'AcceptSubmission',
    submissionId: id,
    attemptId: instance(sim).attemptId!,
    submission: {
      kind: 'merge-request',
      payload: { pr, expectedHeadSha: 'abcdef2' },
    },
  });
const ask = (sim: Simulator, id: string) =>
  sim.dispatch({
    type: 'AskQuestion',
    questionId: id,
    attemptId: 'worker-A',
    body: 'Which interface? branch: ai-office/ab12/A',
  });
const answer = (sim: Simulator, id: string) =>
  sim.dispatch({
    type: 'AcceptSubmission',
    submissionId: `answer-${id}`,
    attemptId: instance(sim, 'oncall').attemptId!,
    submission: {
      kind: 'answer-question',
      payload: { questionId: id, body: 'Use the approved interface.' },
    },
  });
const clean = (sim: Simulator) => {
  expect(sim.rejections).toEqual([]);
  expect(sim.warnings).toEqual([]);
};

describe('on-demand engine', () => {
  it('serializes three PRs in arrival order, reuses one keep-open instance, then stops after five idle minutes', () => {
    const sim = setup();
    enqueue(sim, 'B', 12);
    enqueue(sim, 'A');
    enqueue(sim, 'C', 13);
    expect(instance(sim)).toMatchObject({ current: 'B', queue: ['A', 'C'] });
    merge(sim, 'merge-B', 12);
    merge(sim, 'merge-A', 11);
    merge(sim, 'merge-C', 13);
    expect(
      sim.eventsOf('workitem.merged').map((e) => e.payload.itemKey),
    ).toEqual(['B', 'A', 'C']);
    expect(sim.eventsOf('ondemand.started')).toHaveLength(1);
    sim.advance(4 * MINUTE_MS);
    expect(instance(sim).stopped).toBeUndefined();
    sim.advance(MINUTE_MS);
    expect(instance(sim).stopped).toBe('queue_empty');
    expect(sim.state.attempts[instance(sim).attemptId!]!.released).toBe(true);
    clean(sim);
  });
  it('hands rework back through domain events and reviews the next PR', () => {
    const sim = setup();
    enqueue(sim, 'A');
    enqueue(sim, 'B', 12);
    sim.dispatch({
      type: 'AcceptSubmission',
      submissionId: 'rework-A',
      attemptId: instance(sim).attemptId!,
      submission: {
        kind: 'rework-request',
        payload: { pr: 11, reasons: ['Add a regression test'] },
      },
    });
    expect(sim.state.workItems.A!.status).toBe('rework');
    expect(instance(sim).current).toBe('B');
    clean(sim);
  });
  it('keeps a failed merge current and accepts a corrected head SHA', () => {
    let failed = false;
    const sim = setup((issued, worldSim) =>
      issued.command.kind === 'scm.mergePR' && !failed
        ? ((failed = true),
          {
            ok: false,
            error: {
              category: 'guard',
              code: 'conflict',
              message: 'Conflict',
              retryable: false,
            },
          })
        : cooperativeWorld(issued, worldSim),
    );
    enqueue(sim, 'A');
    enqueue(sim, 'B', 12);
    merge(sim, 'merge-conflict', 11);
    expect(instance(sim).current).toBe('A');
    sim.dispatch({
      type: 'AcceptSubmission',
      submissionId: 'merge-fixed',
      attemptId: instance(sim).attemptId!,
      submission: {
        kind: 'merge-request',
        payload: { pr: 11, expectedHeadSha: 'abcdef3' },
      },
    });
    expect(instance(sim).current).toBe('B');
    clean(sim);
  });
  const mergeError = (code: string) => ({
    ok: false as const,
    error: {
      category:
        code === 'base_moved' ? ('conflict' as const) : ('guard' as const),
      code,
      message: code,
      retryable: false,
    },
  });
  const reviewHeads = (sim: Simulator, key: string) =>
    sim.issued.flatMap((i) =>
      i.command.kind === 'runtime.send' && i.command.args.subject === key
        ? [
            (JSON.parse(i.command.args.body) as { integrationHead: string })
              .integrationHead,
          ]
        : [],
    );
  const merges = (sim: Simulator) =>
    sim.issued.flatMap((i) =>
      i.command.kind === 'scm.mergePR' ? [i.command.args] : [],
    );
  it('merges with expectedBaseSha = the integration head sent for review (EP1)', () => {
    const sim = setup();
    enqueue(sim, 'A');
    merge(sim, 'merge-A', 11);
    expect(reviewHeads(sim, 'A')).toEqual(['abcdef1']);
    expect(merges(sim)).toEqual([
      expect.objectContaining({ expectedBaseSha: 'abcdef1' }),
    ]);
    clean(sim);
  });
  it('re-reviews the same PR on base_moved without rework, then opens merge-review-failed after two in a row', () => {
    let head = 1;
    const sim = setup((issued, worldSim) => {
      if (issued.command.kind === 'scm.mergePR')
        return mergeError('base_moved');
      if (issued.command.kind === 'scm.compareBranch')
        return {
          ok: true,
          result: { ahead: 0, headSha: `abcdef${++head + 1}` },
        };
      return cooperativeWorld(issued, worldSim);
    });
    enqueue(sim, 'A');
    merge(sim, 'merge-A1', 11);
    // One base_moved: the integration head is re-read and the review re-sent.
    expect(reviewHeads(sim, 'A')).toEqual(['abcdef1', 'abcdef3']);
    expect(sim.state.workItems.A!.status).toBe('in_review');
    expect(sim.state.workItems.A!.rework ?? 0).toBe(0);
    expect(instance(sim).current).toBe('A');
    expect(sim.eventsOf('gate.opened')).toEqual([]);
    merge(sim, 'merge-A2', 11);
    expect(merges(sim).map((m) => m.expectedBaseSha)).toEqual([
      'abcdef1',
      'abcdef3',
    ]);
    const gate = sim.eventsOf('gate.opened').at(-1)!.payload;
    expect(gate).toMatchObject({
      kind: 'exception',
      exceptionKind: 'merge-review-failed',
      content: { itemKey: 'A' },
    });
    expect(sim.state.workItems.A!.status).toBe('needs_attention');
    expect(
      sim.issued.filter((i) => i.command.kind === 'scm.compareBranch'),
    ).toHaveLength(1);
    clean(sim);
  });
  it('turns merge_base_changed into a high anomaly that pauses (EP1)', () => {
    const sim = setup((issued, worldSim) =>
      issued.command.kind === 'scm.mergePR'
        ? mergeError('merge_base_changed')
        : cooperativeWorld(issued, worldSim),
    );
    enqueue(sim, 'A');
    merge(sim, 'merge-A', 11);
    expect(sim.eventsOf('anomaly.detected').map((e) => e.payload)).toEqual([
      expect.objectContaining({
        kind: 'merge-base-changed',
        severity: 'high',
        number: 11,
      }),
    ]);
    expect(sim.state.workflow!.pausedReasons).toContain('anomaly');
    expect(
      sim.issued.filter(
        (i) =>
          i.command.kind === 'runtime.send' &&
          i.command.args.body.startsWith('Merge failed'),
      ),
    ).toEqual([]);
    clean(sim);
  });
  it('nudges once, replaces a timed-out reviewer once, then escalates', () => {
    const sim = setup();
    enqueue(sim, 'A');
    sim.advance(20 * MINUTE_MS);
    expect(
      sim
        .eventsOf('message.nudge')
        .filter((e) => e.payload.reason !== 'spawn-stall'),
    ).toHaveLength(1);
    sim.advance(20 * MINUTE_MS);
    expect(sim.eventsOf('ondemand.started')).toHaveLength(2);
    sim.advance(40 * MINUTE_MS);
    expect(sim.state.workItems.A!.status).toBe('needs_attention');
    expect(sim.eventsOf('gate.opened').at(-1)?.payload).toMatchObject({
      exceptionKind: 'merge-review-failed',
    });
    clean(sim);
  });
  it.each(['exited', 'lost'] as const)(
    'requeues %s reviewer once and escalates the second failure',
    (state) => {
      const sim = setup();
      enqueue(sim, 'A');
      for (let n = 0; n < 2; n++) {
        const attemptId = instance(sim).attemptId!;
        sim.dispatch(
          state === 'exited'
            ? {
                type: 'RecordAttemptExited',
                attemptId,
                reason: 'crash',
                expected: false,
              }
            : { type: 'ObserveAttemptStatus', attemptId, state },
        );
      }
      expect(sim.eventsOf('ondemand.started')).toHaveLength(2);
      expect(sim.state.workItems.A!.status).toBe('needs_attention');
      clean(sim);
    },
  );
  it('forwards one question at a time and replies to the original worker', () => {
    const sim = setup();
    ask(sim, 'q1');
    ask(sim, 'q2');
    expect(instance(sim, 'oncall')).toMatchObject({
      current: 'q1',
      queue: ['q2'],
    });
    answer(sim, 'q1');
    answer(sim, 'q2');
    expect(
      sim.issued.filter((i) => i.command.kind === 'runtime.answer'),
    ).toHaveLength(2);
    expect(sim.eventsOf('ondemand.started')).toHaveLength(1);
    sim.advance(5 * MINUTE_MS);
    expect(instance(sim, 'oncall').stopped).toBe('queue_empty');
    clean(sim);
  });
  it('escalates an unanswered question after one nudge', () => {
    const sim = setup();
    ask(sim, 'q1');
    sim.advance(20 * MINUTE_MS);
    expect(sim.state.questions.q1!.status).toBe('escalated');
    expect(
      sim
        .eventsOf('message.nudge')
        .filter((e) => e.payload.reason !== 'spawn-stall'),
    ).toHaveLength(1);
    clean(sim);
  });
  it('requeues a failed on-call once, then escalates', () => {
    const sim = setup();
    ask(sim, 'q1');
    for (let n = 0; n < 2; n++)
      sim.dispatch({
        type: 'RecordAttemptExited',
        attemptId: instance(sim, 'oncall').attemptId!,
        reason: 'crash',
        expected: false,
      });
    expect(sim.state.questions.q1!.status).toBe('escalated');
    clean(sim);
  });
  it('escalates decision requests tied to the current question', () => {
    const sim = setup();
    ask(sim, 'q1');
    sim.dispatch({
      type: 'AcceptSubmission',
      submissionId: 'decision',
      attemptId: instance(sim, 'oncall').attemptId!,
      submission: {
        kind: 'decision-request',
        payload: {
          questionId: 'q1',
          reason: 'scope-change',
          question: 'Change scope?',
          options: [],
        },
      },
    });
    expect(sim.state.questions.q1!.status).toBe('escalated');
    clean(sim);
  });
  it('stops immediately when all implementation items are terminal', () => {
    const sim = setup();
    enqueue(sim, 'A');
    merge(sim, 'merge-A', 11);
    for (const itemKey of ['B', 'C', 'D'])
      sim.dispatch({
        type: 'UpdateWorkItemStatus',
        update: { itemKey, status: 'skipped' },
      });
    expect(instance(sim).stopped).toBe('stage_ended');
    expect(sim.state.attempts[instance(sim).attemptId!]!.released).toBe(true);
    clean(sim);
  });
});

it('reviews a reworked PR again on the same keep-open instance', () => {
  const sim = setup();
  enqueue(sim, 'A');
  const first = instance(sim).attemptId;
  sim.dispatch({
    type: 'AcceptSubmission',
    submissionId: 'rework-A',
    attemptId: first!,
    submission: {
      kind: 'rework-request',
      payload: { pr: 11, reasons: ['Fix edge case'] },
    },
  });
  sim.dispatch({
    type: 'RecordAttemptExited',
    attemptId: 'worker-A',
    reason: 'done',
    expected: true,
  });
  sim.dispatch({
    type: 'DispatchWorkItem',
    itemKey: 'A',
    attemptId: 'worker-A-2',
    baseSha: 'abcdef1',
  });
  for (const status of ['in_progress', 'pushed', 'pr_open'] as const)
    sim.dispatch({
      type: 'UpdateWorkItemStatus',
      update: { itemKey: 'A', status },
    });
  sim.dispatch({
    type: 'QueueWorkItemForMerge',
    item: { itemKey: 'A', attemptId: 'worker-A-2', pr: 11, headSha: 'abcdef3' },
  });
  expect(instance(sim).attemptId).toBe(first);
  expect(instance(sim).current).toBe('A');
  clean(sim);
});

it('continues reviewing other PRs while a conflict exception gate is open', () => {
  const sim = setup();
  enqueue(sim, 'A');
  enqueue(sim, 'B', 12);
  sim.dispatch({
    type: 'AcceptSubmission',
    submissionId: 'conflict-decision',
    attemptId: instance(sim).attemptId!,
    submission: {
      kind: 'decision-request',
      payload: {
        reason: 'unresolvable-conflict',
        question: 'Which design should win?',
        options: ['Retry'],
      },
    },
  });
  expect(sim.eventsOf('gate.opened').at(-1)?.payload).toMatchObject({
    exceptionKind: 'merge-blocked',
  });
  expect(instance(sim).current).toBe('B');
  expect(sim.state.attempts[instance(sim).attemptId!]!.released).toBe(false);
  clean(sim);
});

it('escalates the integrator own question directly to a human', () => {
  const sim = setup();
  enqueue(sim, 'A');
  sim.dispatch({
    type: 'AskQuestion',
    questionId: 'integrator-question',
    attemptId: instance(sim).attemptId!,
    body: 'May I change scope?',
  });
  expect(sim.state.questions['integrator-question']!.status).toBe('escalated');
  expect(sim.state.ondemand.implement?.oncall).toBeUndefined();
  clean(sim);
});

it('does not allow a responder to answer or escalate a different question', () => {
  const sim = setup();
  ask(sim, 'q1');
  ask(sim, 'q2');
  for (const submission of [
    {
      kind: 'answer-question' as const,
      payload: { questionId: 'q2', body: 'Wrong question' },
    },
    {
      kind: 'decision-request' as const,
      payload: {
        questionId: 'q2',
        reason: 'other' as const,
        question: 'Wrong question',
        options: [],
      },
    },
  ])
    sim.dispatch({
      type: 'AcceptSubmission',
      submissionId: `wrong-${submission.kind}`,
      attemptId: instance(sim, 'oncall').attemptId!,
      submission,
    });
  expect(sim.state.questions.q2!.status).toBe('open');
  expect(instance(sim, 'oncall').current).toBe('q1');
  clean(sim);
});

it('cancels idle shutdown when new work arrives and starts a fresh idle period', () => {
  const sim = setup();
  enqueue(sim, 'A');
  merge(sim, 'merge-A', 11);
  const first = instance(sim).attemptId;
  sim.advance(4 * MINUTE_MS);
  enqueue(sim, 'B', 12);
  sim.advance(MINUTE_MS);
  expect(instance(sim).stopped).toBeUndefined();
  merge(sim, 'merge-B', 12);
  sim.advance(5 * MINUTE_MS);
  expect(instance(sim).attemptId).toBe(first);
  expect(instance(sim).stopped).toBe('queue_empty');
  clean(sim);
});

it('wakes a fresh instance after idle release, using the latest integration branch', () => {
  const sim = setup((issued, worldSim) =>
    issued.command.kind === 'runtime.prepareWorkspace'
      ? {
          ok: true,
          result: {
            workspace: 'ws-review',
            path: '/worktrees/review',
            baseSha: 'abcdef9',
          },
        }
      : cooperativeWorld(issued, worldSim),
  );
  enqueue(sim, 'A');
  merge(sim, 'merge-A', 11);
  sim.advance(5 * MINUTE_MS);
  enqueue(sim, 'B', 12);
  expect(sim.eventsOf('ondemand.started')).toHaveLength(2);
  expect(
    sim.issued
      .filter((i) => i.command.kind === 'runtime.prepareWorkspace')
      .at(-1)?.command,
  ).toMatchObject({
    args: {
      baseBranch: `origin/${sim.state.workflow!.integrationBranch}`,
      fetchBranch: sim.state.workflow!.integrationBranch,
    },
  });
  const send = sim.issued
    .filter((i) => i.command.kind === 'runtime.send')
    .at(-1)!.command;
  if (send.kind === 'runtime.send')
    expect(JSON.parse(send.args.body)).toMatchObject({
      baseSha: 'abcdef1',
      integrationHead: 'abcdef9',
    });
  clean(sim);
});

it('does not replace a lost instance while runtime stop and release are unconfirmed', () => {
  const sim = setup((issued, worldSim) =>
    ['runtime.stop', 'runtime.release'].includes(issued.command.kind)
      ? undefined
      : cooperativeWorld(issued, worldSim),
  );
  enqueue(sim, 'A');
  const old = instance(sim).attemptId!;
  sim.dispatch({ type: 'ObserveAttemptStatus', attemptId: old, state: 'lost' });
  enqueue(sim, 'B', 12);
  expect(sim.eventsOf('ondemand.started')).toHaveLength(1);
  expect(instance(sim).queue).toEqual(['A', 'B']);
  expect(sim.state.attempts[old]!.released).toBe(false);
  clean(sim);
});

it('stops both purposes immediately on cancellation without spawning replacements', () => {
  const sim = setup();
  enqueue(sim, 'A');
  ask(sim, 'q1');
  sim.dispatch({ type: 'RequestCancel', by: 'user' });
  expect(instance(sim).stopped).toBe('cancelled');
  expect(instance(sim, 'oncall').stopped).toBe('cancelled');
  clean(sim);
});

it.each(['success', 'failure'] as const)(
  'reserves the PR across reviewer loss until a pending merge settles with %s',
  (outcome) => {
    const sim = setup((issued, worldSim) =>
      issued.command.kind === 'scm.mergePR'
        ? undefined
        : cooperativeWorld(issued, worldSim),
    );
    enqueue(sim, 'A');
    enqueue(sim, 'B', 12);
    merge(sim, 'pending', 11);
    const command = sim.issued.find((i) => i.command.kind === 'scm.mergePR')!;
    sim.dispatch({
      type: 'RecordAttemptExited',
      attemptId: instance(sim).attemptId!,
      reason: 'crash',
      expected: false,
    });
    sim.advance(90 * MINUTE_MS);
    expect(instance(sim).current).toBe('A');
    expect(sim.eventsOf('ondemand.started')).toHaveLength(1);
    expect(sim.eventsOf('message.nudge')).toHaveLength(0);
    if (outcome === 'success')
      sim.inject('command.succeeded', {
        commandId: command.commandId,
        kind: 'scm.mergePR',
        result: { mergeCommitSha: 'abcdef9' },
      });
    else
      sim.inject('command.failed', {
        commandId: command.commandId,
        kind: 'scm.mergePR',
        error: {
          category: 'conflict',
          code: 'conflict',
          message: 'Conflict',
          retryable: false,
        },
        attempts: 1,
      });
    expect(instance(sim).current).toBe(outcome === 'success' ? 'B' : 'A');
    expect(sim.eventsOf('ondemand.started')).toHaveLength(2);
    clean(sim);
  },
);

it('requeues a failed review on explicit human authorization', () => {
  const sim = setup();
  enqueue(sim, 'A');
  for (let n = 0; n < 2; n++)
    sim.dispatch({
      type: 'RecordAttemptExited',
      attemptId: instance(sim).attemptId!,
      reason: 'crash',
      expected: false,
    });
  const gate = sim.eventsOf('gate.opened').at(-1)!.payload;
  sim.dispatch({
    type: 'DecideGate',
    gateId: gate.gateId,
    by: 'user',
    expectedVersion: 1,
    decision: 'option',
    optionId: 'requeue',
  });
  expect(instance(sim).current).toBe('A');
  expect(instance(sim).deliveries?.A?.retries).toBe(0);
  clean(sim);
});

it('holds new queue work while paused, then resumes without duplicating the instance', () => {
  const sim = setup();
  sim.dispatch({ type: 'PauseWorkflow', reason: 'runtime_unhealthy' });
  enqueue(sim, 'A');
  expect(sim.eventsOf('ondemand.started')).toHaveLength(0);
  sim.dispatch({ type: 'ResumeWorkflow', reason: 'runtime_unhealthy' });
  expect(instance(sim).current).toBe('A');
  expect(sim.eventsOf('ondemand.started')).toHaveLength(1);
  clean(sim);
});
