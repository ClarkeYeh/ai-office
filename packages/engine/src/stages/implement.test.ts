import type { ExternalCommandKind } from '@ai-office/contracts/events';
import { describe, expect, it } from 'vitest';
import type { WorkItem } from '@ai-office/domain';
import { createReact, DEFAULT_MODULES } from '../react.js';
import { startWorkflow } from '../test-support/fixtures.js';
import { cooperativeWorld, Simulator } from '../test-support/simulator.js';
import type { World } from '../test-support/simulator.js';

const sha = (n: number) => n.toString(16).padStart(40, 'a');
const item = (key: string, deps: string[] = []): WorkItem => ({
  key,
  title: key,
  body: `Implement ${key}`,
  acceptance: ['Works'],
  deps,
  role: 'engineer',
  agent: 'codex',
  status: 'approved',
  approvedGateId: 'approved',
  attemptIds: [],
  attempt: 0,
  issue: 10,
});
function setup(
  options: {
    items?: WorkItem[];
    global?: number;
    world?: World;
    hold?: ExternalCommandKind;
  } = {},
) {
  let nextPr = 20;
  let head = 1;
  const sim = new Simulator({
    react: createReact({
      ...DEFAULT_MODULES,
      policies: [],
      stages: {
        ...DEFAULT_MODULES.stages,
        meeting: { react: () => [] },
        planning: { react: () => [] },
        integrate: { react: () => [] },
        ondemand: { react: () => [] },
      },
    }),
    world: (issued, current) => {
      if (issued.command.kind === options.hold) return undefined;
      if (options.world) {
        const reply = options.world(issued, current);
        if (reply !== undefined) return reply;
      }
      if (issued.command.kind === 'scm.compareBranch')
        return { ok: true, result: { ahead: 1, headSha: sha(head) } };
      if (issued.command.kind === 'scm.openPR')
        return {
          ok: true,
          result: {
            pr: nextPr++,
            url: `https://github.com/octo/demo/pull/${nextPr - 1}`,
          },
        };
      return cooperativeWorld(issued, current);
    },
  });
  const start = startWorkflow();
  start.limits.globalAgents = options.global ?? 10;
  const config = start.template.stages.find((s) => s.kind === 'implement')!;
  if (config.kind === 'implement') config.maxParallel = 2;
  sim.dispatch(start);
  sim.state.stages.meeting!.status = 'done';
  sim.state.stages.breakdown!.status = 'done';
  const items = options.items ?? [item('A'), item('B'), item('C', ['A'])];
  sim.state.workItems = Object.fromEntries(items.map((i) => [i.key, i]));
  sim.state.workItemOrder = items.map((i) => i.key);
  sim.dispatch({ type: 'StartStage', stageId: 'implement' });
  return {
    sim,
    moveHead: () => {
      head++;
    },
  };
}
const workerPrs = (sim: Simulator) =>
  sim
    .eventsOf('artifact.created')
    .flatMap(({ payload: p }) =>
      p.kind === 'pr' && p.purpose === 'worker' ? [p] : [],
    );
const done = (sim: Simulator, key: string) =>
  sim.dispatch({
    type: 'ObserveAttemptStatus',
    attemptId: sim.state.workItems[key]!.currentAttemptId!,
    state: 'done',
  });
function merge(sim: Simulator, key: string) {
  const i = sim.state.workItems[key]!;
  sim.inject('workitem.merged', {
    itemKey: key,
    pr: i.pr!,
    mergeCommitSha: sha(9),
    commandId: 'merge-' + key,
  });
}

it('golden: parallel workers queue PRs and only merged dependencies unlock a freshly pinned base', () => {
  const { sim, moveHead } = setup();
  expect(sim.state.workItems.A?.status).toBe('in_progress');
  expect(sim.state.workItems.B?.status).toBe('in_progress');
  expect(sim.state.workItems.C?.status).toBe('approved');
  done(sim, 'A');
  expect(sim.state.workItems.A?.status).toBe('merge_queued');
  expect(sim.state.workItems.C?.status).toBe('approved');
  moveHead();
  merge(sim, 'A');
  expect(sim.state.workItems.C).toMatchObject({
    status: 'in_progress',
    baseSha: sha(2),
  });
  const prepare = sim.issued.find(
    (c) =>
      c.command.kind === 'runtime.prepareWorkspace' &&
      c.command.args.branch.endsWith('/C'),
  )!;
  expect(prepare.command).toMatchObject({
    args: {
      baseBranch: sha(2),
      fetchBranch: sim.state.workflow!.integrationBranch,
    },
  });
  done(sim, 'B');
  merge(sim, 'B');
  done(sim, 'C');
  merge(sim, 'C');
  expect(sim.state.stages.implement?.status).toBe('done');
  // Each worker PR is recorded once, before its item is queued for merge.
  const integration = sim.state.workflow!.integrationBranch;
  expect(workerPrs(sim)).toEqual(
    ['A', 'B', 'C'].map((key) => ({
      kind: 'pr',
      artifactId: expect.any(String),
      number: sim.state.workItems[key]!.pr,
      url: `https://github.com/octo/demo/pull/${sim.state.workItems[key]!.pr}`,
      purpose: 'worker',
      head: sim.state.workItems[key]!.branch,
      base: integration,
      itemKey: key,
    })),
  );
  for (const key of ['A', 'B', 'C']) {
    const seqOf = (type: 'artifact.created' | 'workitem.merge_queued') =>
      sim
        .eventsOf(type)
        .find((e) => 'itemKey' in e.payload && e.payload.itemKey === key)!.seq;
    expect(seqOf('artifact.created')).toBeLessThan(
      seqOf('workitem.merge_queued'),
    );
  }
  expect(sim.liveAgents()).toBe(0);
  expect(sim.rejections).toEqual([]);
  expect(sim.warnings).toEqual([]);
  expect(
    sim
      .trace()
      .filter((l) =>
        /workitem\.|stage.completed|scm.compareBranch|scm.openPR|artifact.created/.test(
          l,
        ),
      ),
  ).toMatchSnapshot();
});

it('counts on-demand agents against the global limit', () => {
  const { sim } = setup({ global: 1 });
  expect(sim.eventsOf('workitem.dispatched')).toHaveLength(1);
  done(sim, 'A');
  expect(sim.state.workItems.B?.status).toBe('in_progress');
  expect(sim.rejections).toEqual([]);
});

it('reworks on the same branch and PR with a fresh workspace and attempt', () => {
  const { sim } = setup({ items: [item('A')] });
  done(sim, 'A');
  const first = { ...sim.state.workItems.A! };
  sim.inject('workitem.rework_requested', {
    itemKey: 'A',
    pr: first.pr!,
    submissionId: 'review-1',
    attemptId: 'reviewer',
    reasons: ['Add a regression test'],
    rework: 1,
  });
  expect(sim.state.workItems.A).toMatchObject({
    attempt: 2,
    branch: first.branch,
    pr: first.pr,
    reworkOf: 'review-1',
  });
  expect(
    sim.issued
      .filter((c) => c.command.kind === 'runtime.prepareWorkspace')
      .at(-1)?.command,
  ).toMatchObject({
    args: {
      checkoutExisting: true,
      branch: first.branch,
      fetchBranch: first.branch,
      name: `${first.workspaceName}-r1`,
    },
  });
  done(sim, 'A');
  expect(sim.state.workItems.A?.status).toBe('merge_queued');
  expect(
    sim.issued.filter((c) => c.command.kind === 'scm.openPR'),
  ).toHaveLength(1);
  // Same branch, same PR: rework does not record the PR again.
  expect(workerPrs(sim).map((p) => p.number)).toEqual([first.pr]);
  merge(sim, 'A');
  expect(sim.liveAgents()).toBe(0);
  expect(sim.rejections).toEqual([]);
});

it('raises transitive dependency exceptions when a prerequisite fails', () => {
  const { sim } = setup({
    items: [item('A'), item('B', ['A']), item('C', ['B'])],
  });
  sim.dispatch({
    type: 'UpdateWorkItemStatus',
    update: { itemKey: 'A', status: 'failed' },
  });
  const gates = sim.eventsOf('gate.opened').map((e) => e.payload);
  expect(
    gates
      .filter(
        (g) =>
          g.kind === 'exception' && g.exceptionKind === 'dependency-blocked',
      )
      .map((g) => g.content.type === 'exception' && g.content.itemKey),
  ).toEqual(['B', 'C']);
  expect(sim.eventsOf('workitem.dispatched')).toHaveLength(1);
});

it('nudges an unpushed worker once then opens the item exception', () => {
  const { sim } = setup({
    items: [item('A')],
    world: (issued) =>
      issued.command.kind === 'scm.compareBranch' &&
      issued.command.args.head !== issued.command.args.base
        ? { ok: true, result: null }
        : undefined,
  });
  done(sim, 'A');
  expect(sim.eventsOf('message.nudge')).toHaveLength(1);
  sim.advance(5 * 60_000);
  expect(sim.state.workItems.A?.status).toBe('needs_attention');
  expect(sim.eventsOf('gate.opened').at(-1)?.payload).toMatchObject({
    exceptionKind: 'workitem-failed',
  });
  expect(sim.rejections).toEqual([]);
});

it('ignores stale worker completions and does not dispatch while paused', () => {
  const { sim } = setup();
  sim.dispatch({ type: 'PauseWorkflow', reason: 'anomaly' });
  done(sim, 'A');
  expect(
    sim.issued.filter((c) => c.command.kind === 'scm.openPR'),
  ).toHaveLength(0);
  sim.dispatch({ type: 'ResumeWorkflow', reason: 'anomaly' });
  expect(sim.state.workItems.A?.status).toBe('merge_queued');
  expect(sim.rejections).toEqual([]);
});

it('a failed-attempt retry uses -a2, changes agent, and closes and links the old PR', () => {
  const { sim } = setup({ items: [item('A')] });
  done(sim, 'A');
  const first = { ...sim.state.workItems.A! };
  sim.dispatch({
    type: 'UpdateWorkItemStatus',
    update: { itemKey: 'A', status: 'needs_attention' },
  });
  sim.dispatch({
    type: 'OpenGate',
    noLiveAttempts: true,
    gate: {
      kind: 'exception',
      gateId: 'retry-A',
      stageId: 'implement',
      exceptionKind: 'workitem-failed',
      title: 'Retry',
      options: [
        { optionId: 'retry', label: 'Retry' },
        { optionId: 'reassign', label: 'Reassign', input: 'agent' },
        { optionId: 'skip', label: 'Skip' },
        { optionId: 'abort', label: 'Abort' },
      ],
      content: {
        type: 'exception',
        itemKey: 'A',
        attemptId: first.currentAttemptId!,
        summary: 'Retry failed review',
      },
    },
  });
  sim.dispatch({
    type: 'DecideGate',
    gateId: 'retry-A',
    decision: 'option',
    optionId: 'reassign',
    agent: 'claude-code',
    by: 'user',
    expectedVersion: 1,
  });
  expect(sim.state.workItems.A).toMatchObject({
    attempt: 2,
    branch: 'ai-office/ab12/A-a2',
    agent: 'claude-code',
  });
  done(sim, 'A');
  expect(
    sim.issued.filter((c) => c.command.kind === 'scm.updatePR').at(-1)?.command,
  ).toMatchObject({
    args: { pr: { number: first.pr }, patch: { state: 'closed' } },
  });
  expect(
    sim.issued.filter((c) => c.command.kind === 'scm.comment').at(-1)?.command,
  ).toMatchObject({ args: { body: expect.stringContaining('/pull/21') } });
  // The retry opened a new PR on a new branch, so it gets its own artifact.
  expect(workerPrs(sim).map((p) => [p.number, p.head])).toEqual([
    [first.pr, first.branch],
    [21, 'ai-office/ab12/A-a2'],
  ]);
  expect(sim.state.workItems.A?.pr).toBe(21);
  expect(sim.rejections).toEqual([]);
});

it('rework over the limit opens its exception before any extra dispatch', () => {
  const { sim } = setup({ items: [item('A')] });
  done(sim, 'A');
  const i = sim.state.workItems.A!;
  i.status = 'in_review';
  i.rework = 2;
  sim.state.ondemand.implement = {
    merge: {
      stageId: 'implement',
      attemptId: 'reviewer',
      queue: [],
      current: 'A',
    },
  };
  sim.state.submissions.review = {
    id: 'review',
    attemptId: 'reviewer',
    kind: 'rework-request',
    acceptedAt: sim.clock,
    submission: {
      kind: 'rework-request',
      payload: { pr: i.pr!, reasons: ['Still broken'] },
    },
  };
  sim.dispatch({
    type: 'RequestWorkItemRework',
    submissionId: 'review',
    gateId: 'rework-limit',
  });
  expect(sim.state.workItems.A).toMatchObject({
    status: 'needs_attention',
    attempt: 1,
    rework: 3,
  });
  expect(sim.state.gates['rework-limit']).toMatchObject({
    status: 'open',
    exceptionKind: 'rework-limit',
  });
  expect(sim.eventsOf('workitem.dispatched')).toHaveLength(1);
  expect(sim.rejections).toEqual([]);
});

it('question waits suspend the item deadline exactly once', () => {
  const { sim } = setup({ items: [item('A')] });
  const id = sim.state.workItems.A!.currentAttemptId!;
  sim.advance(10 * 60_000);
  sim.dispatch({
    type: 'AskQuestion',
    questionId: 'q1',
    attemptId: id,
    itemKey: 'A',
    body: 'Which behavior?',
  });
  sim.advance(10 * 60_000);
  sim.inject('message.answered', {
    questionId: 'q1',
    by: 'user',
    body: 'Use A',
  });
  sim.advance(25 * 60_000);
  expect(sim.eventsOf('message.nudge')).toHaveLength(0);
  sim.advance(10 * 60_000);
  expect(sim.eventsOf('message.nudge')).toHaveLength(1);
  expect(sim.eventsOf('budget.exceeded').at(-1)?.payload).toMatchObject({
    metric: 'wallclock',
    used: 45,
  });
  expect(sim.rejections).toEqual([]);
});

it('does not complete implement until on-demand agents have stopped', () => {
  const { sim } = setup({ items: [item('A')] });
  sim.dispatch({
    type: 'SpawnAttempt',
    stageId: 'implement',
    role: 'lead',
    purpose: 'oncall',
    attemptId: 'oncall',
    keepOpen: true,
    spawnCommandId: 'spawn-oncall',
  });
  done(sim, 'A');
  merge(sim, 'A');
  expect(sim.state.stages.implement?.status).toBe('running');
  sim.dispatch({
    type: 'RecordAttemptExited',
    attemptId: 'oncall',
    expected: true,
    reason: 'queue_empty',
  });
  expect(sim.state.stages.implement?.status).toBe('done');
  expect(sim.liveAgents()).toBe(0);
  expect(sim.rejections).toEqual([]);
});

it.each([
  'runtime.prepareWorkspace',
  'runtime.spawnAgent',
  'scm.openPR',
] as const)('surfaces %s failures as item exceptions', (kind) => {
  const { sim } = setup({
    items: [item('A')],
    world: (issued) =>
      issued.command.kind === kind
        ? {
            ok: false,
            error: {
              category: 'permanent',
              code: 'failed',
              message: 'External operation failed',
              retryable: false,
            },
          }
        : undefined,
  });
  if (kind === 'scm.openPR') done(sim, 'A');
  expect(sim.state.workItems.A?.status).toBe('needs_attention');
  expect(sim.eventsOf('gate.opened').at(-1)?.payload).toMatchObject({
    exceptionKind: 'workitem-failed',
  });
  expect(sim.rejections).toEqual([]);
});

it('a missing remote base opens a retryable setup exception', () => {
  let missing = true;
  const { sim } = setup({
    items: [item('A')],
    world: (issued) =>
      issued.command.kind === 'scm.compareBranch' && missing
        ? { ok: true, result: null }
        : undefined,
  });
  expect(sim.eventsOf('workitem.dispatched')).toHaveLength(0);
  const gateId = sim.eventsOf('gate.opened').at(-1)!.payload.gateId;
  missing = false;
  sim.dispatch({
    type: 'DecideGate',
    gateId,
    decision: 'option',
    optionId: 'retry',
    by: 'user',
    expectedVersion: 1,
  });
  expect(sim.state.workItems.A?.status).toBe('in_progress');
  expect(sim.rejections).toEqual([]);
});

it.each(['error', 'lost', 'exited'] as const)(
  'handles a worker reported as %s',
  (state) => {
    const { sim } = setup({ items: [item('A')] });
    sim.dispatch({
      type: 'ObserveAttemptStatus',
      attemptId: sim.state.workItems.A!.currentAttemptId!,
      state,
    });
    if (state === 'error') {
      expect(sim.eventsOf('message.nudge')).toHaveLength(1);
      sim.advance(5 * 60_000);
    }
    expect(sim.state.workItems.A?.status).toBe('needs_attention');
    expect(sim.rejections).toEqual([]);
  },
);

it('a dependency waiver permits the downstream worker while an open gate blocks it', () => {
  const { sim } = setup({ items: [item('A'), item('B', ['A'])] });
  sim.dispatch({
    type: 'UpdateWorkItemStatus',
    update: { itemKey: 'A', status: 'skipped' },
  });
  expect(sim.state.workItems.B?.status).toBe('approved');
  const gateId = sim
    .eventsOf('gate.opened')
    .find(
      (e) =>
        e.payload.kind === 'exception' &&
        e.payload.exceptionKind === 'dependency-blocked',
    )!.payload.gateId;
  sim.dispatch({
    type: 'DecideGate',
    gateId,
    decision: 'option',
    optionId: 'proceed',
    by: 'user',
    expectedVersion: 1,
  });
  expect(sim.state.workItems.B?.status).toBe('in_progress');
  expect(sim.rejections).toEqual([]);
});

it('waits for queued work-item approval after implement starts', () => {
  const { sim } = setup({ items: [] });
  expect(sim.state.stages.implement?.status).toBe('running');
  expect(sim.eventsOf('workitem.dispatched')).toHaveLength(0);
  sim.inject('workitem.approved', { gateId: 'approved', items: [item('A')] });
  expect(sim.state.workItems.A?.status).toBe('in_progress');
  expect(sim.rejections).toEqual([]);
});

it('waits for the on-demand stopped event after its agent exits', () => {
  const { sim } = setup({ items: [item('A')] });
  sim.dispatch({
    type: 'SpawnAttempt',
    stageId: 'implement',
    role: 'lead',
    purpose: 'oncall',
    attemptId: 'oncall',
    keepOpen: true,
    spawnCommandId: 'spawn-oncall',
  });
  sim.inject('ondemand.started', {
    stageId: 'implement',
    purpose: 'oncall',
    attemptId: 'oncall',
  });
  done(sim, 'A');
  merge(sim, 'A');
  sim.dispatch({
    type: 'RecordAttemptExited',
    attemptId: 'oncall',
    expected: true,
    reason: 'queue_empty',
  });
  expect(sim.state.stages.implement?.status).toBe('running');
  sim.dispatch({
    type: 'StopOnDemand',
    stop: {
      stageId: 'implement',
      purpose: 'oncall',
      attemptId: 'oncall',
      reason: 'queue_empty',
    },
  });
  expect(sim.state.stages.implement?.status).toBe('done');
  expect(sim.rejections).toEqual([]);
});

it.each([
  'scm.compareBranch',
  'runtime.prepareWorkspace',
  'runtime.spawnAgent',
] as const)('recovers %s results received while paused', (kind) => {
  const { sim } = setup({ items: [item('A')], hold: kind });
  const issued = sim.issued.find((c) => c.command.kind === kind)!;
  sim.dispatch({ type: 'PauseWorkflow', reason: 'anomaly' });
  if (kind === 'scm.compareBranch')
    sim.inject('command.succeeded', {
      commandId: issued.commandId,
      kind,
      result: { ahead: 0, headSha: sha(1) },
    });
  if (kind === 'runtime.prepareWorkspace')
    sim.inject('command.succeeded', {
      commandId: issued.commandId,
      kind,
      result: { workspace: 'workspace-A', path: '/worktrees/A' },
    });
  if (kind === 'runtime.spawnAgent')
    sim.inject('command.succeeded', {
      commandId: issued.commandId,
      kind,
      result: { agent: 'agent-A' },
    });
  sim.dispatch({ type: 'ResumeWorkflow', reason: 'anomaly' });
  expect(sim.state.workItems.A?.status).toBe('in_progress');
  expect(sim.rejections).toEqual([]);
});

it('rearms an item deadline that fired while paused', () => {
  const { sim } = setup({ items: [item('A')] });
  sim.dispatch({ type: 'PauseWorkflow', reason: 'anomaly' });
  sim.advance(45 * 60_000);
  expect(sim.eventsOf('message.nudge')).toHaveLength(0);
  sim.dispatch({ type: 'ResumeWorkflow', reason: 'anomaly' });
  sim.advance(0);
  expect(sim.eventsOf('message.nudge')).toHaveLength(1);
  expect(sim.rejections).toEqual([]);
});

it('queues a PR whose result arrived while paused', () => {
  const { sim } = setup({ items: [item('A')], hold: 'scm.openPR' });
  done(sim, 'A');
  const issued = sim.issued.find((c) => c.command.kind === 'scm.openPR')!;
  sim.dispatch({ type: 'PauseWorkflow', reason: 'anomaly' });
  sim.inject('command.succeeded', {
    commandId: issued.commandId,
    kind: 'scm.openPR',
    result: { pr: 30, url: 'https://github.com/octo/demo/pull/30' },
  });
  sim.dispatch({ type: 'ResumeWorkflow', reason: 'anomaly' });
  expect(sim.state.workItems.A).toMatchObject({
    status: 'merge_queued',
    pr: 30,
  });
  expect(sim.rejections).toEqual([]);
});

it('surfaces a workspace failure recorded while paused on resume', () => {
  const { sim } = setup({
    items: [item('A')],
    hold: 'runtime.prepareWorkspace',
  });
  const issued = sim.issued.find(
    (c) => c.command.kind === 'runtime.prepareWorkspace',
  )!;
  sim.dispatch({ type: 'PauseWorkflow', reason: 'anomaly' });
  sim.inject('command.failed', {
    commandId: issued.commandId,
    kind: 'runtime.prepareWorkspace',
    error: {
      category: 'permanent',
      code: 'missing',
      message: 'Workspace unavailable',
      retryable: false,
    },
    attempts: 1,
  });
  sim.dispatch({ type: 'ResumeWorkflow', reason: 'anomaly' });
  expect(sim.state.workItems.A?.status).toBe('needs_attention');
  expect(sim.rejections).toEqual([]);
});

it('reserves global capacity for a live on-call instance before worker dispatch', () => {
  const { sim } = setup({ items: [], global: 1 });
  sim.dispatch({
    type: 'SpawnAttempt',
    stageId: 'implement',
    role: 'lead',
    purpose: 'oncall',
    attemptId: 'oncall',
    keepOpen: true,
    spawnCommandId: 'spawn-oncall',
  });
  sim.inject('workitem.approved', { gateId: 'approved', items: [item('A')] });
  expect(sim.eventsOf('workitem.dispatched')).toHaveLength(0);
  sim.dispatch({
    type: 'RecordAttemptExited',
    attemptId: 'oncall',
    expected: true,
    reason: 'queue_empty',
  });
  expect(sim.state.workItems.A?.status).toBe('in_progress');
  expect(sim.rejections).toEqual([]);
});

describe('deadlines that elapse during a hijack pause (FX8)', () => {
  const itemTimers = (
    sim: Simulator,
    type: 'timer.fired' | 'timer.scheduled',
  ) =>
    sim
      .eventsOf(type)
      .filter((e) => e.payload.timerId.includes('/item-timeout/'));

  it('holds the item deadline and fires it exactly once on resume', () => {
    const { sim } = setup({ items: [item('A')] });
    sim.dispatch({ type: 'PauseWorkflow', reason: 'hijacked' });
    sim.advance(50 * 60_000);
    expect(itemTimers(sim, 'timer.fired')).toHaveLength(0);
    expect(sim.eventsOf('budget.exceeded')).toHaveLength(0);
    sim.dispatch({ type: 'ResumeWorkflow', reason: 'hijacked' });
    expect(itemTimers(sim, 'timer.fired')).toHaveLength(1);
    expect(sim.eventsOf('budget.exceeded').at(-1)?.payload).toMatchObject({
      scope: 'item',
      metric: 'wallclock',
      used: 50,
    });
    expect(sim.eventsOf('message.nudge')).toHaveLength(1);
    // The held timer was delivered, not re-armed beside it.
    expect(itemTimers(sim, 'timer.scheduled')).toHaveLength(1);
    sim.advance(60 * 60_000);
    expect(itemTimers(sim, 'timer.fired')).toHaveLength(1);
    expect(sim.state.workItems.A?.status).toBe('needs_attention');
    expect(sim.rejections).toEqual([]);
  });

  it('records the wallclock hard limit when the pause outlasts it', () => {
    const { sim } = setup({ items: [item('A')] });
    sim.dispatch({ type: 'PauseWorkflow', reason: 'hijacked' });
    sim.advance(100 * 60_000);
    expect(sim.eventsOf('budget.hard_limit')).toHaveLength(0);
    sim.dispatch({ type: 'ResumeWorkflow', reason: 'hijacked' });
    expect(sim.eventsOf('budget.hard_limit').at(-1)?.payload).toMatchObject({
      scope: 'item',
      metric: 'wallclock',
      used: 100,
      threshold: 90,
    });
    expect(sim.rejections).toEqual([]);
  });

  it('keeps holding while another pause reason remains', () => {
    const { sim } = setup({ items: [item('A')] });
    sim.dispatch({ type: 'PauseWorkflow', reason: 'hijacked' });
    sim.dispatch({ type: 'PauseWorkflow', reason: 'budget' });
    sim.advance(50 * 60_000);
    sim.dispatch({ type: 'ResumeWorkflow', reason: 'hijacked' });
    expect(itemTimers(sim, 'timer.fired')).toHaveLength(0);
    sim.dispatch({ type: 'ResumeWorkflow', reason: 'budget' });
    expect(itemTimers(sim, 'timer.fired')).toHaveLength(1);
    expect(sim.rejections).toEqual([]);
  });

  it('lets the resume re-evaluation cancel a held deadline before it fires', () => {
    const { sim } = setup({ items: [item('A')] });
    sim.dispatch({ type: 'PauseWorkflow', reason: 'hijacked' });
    sim.advance(50 * 60_000);
    done(sim, 'A');
    sim.dispatch({ type: 'ResumeWorkflow', reason: 'hijacked' });
    expect(itemTimers(sim, 'timer.fired')).toHaveLength(0);
    expect(
      sim
        .eventsOf('timer.cancelled')
        .filter((e) => e.payload.timerId.includes('/item-timeout/')),
    ).toHaveLength(1);
    expect(sim.state.workItems.A?.status).toBe('merge_queued');
    expect(sim.eventsOf('message.nudge')).toHaveLength(0);
    sim.advance(60 * 60_000);
    expect(itemTimers(sim, 'timer.fired')).toHaveLength(0);
    expect(sim.rejections).toEqual([]);
  });
});
