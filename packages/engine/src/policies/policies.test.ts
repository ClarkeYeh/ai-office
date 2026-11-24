import { describe, expect, it } from 'vitest';
import type {
  DomainEvent,
  EventPayload,
  EventType,
} from '@ai-office/contracts/events';
import type {
  AttemptPurpose,
  EvaluateAnomaly,
  OpenGate,
} from '@ai-office/domain';
import { createReact, DEFAULT_MODULES } from '../react.js';
import { external, internal } from '../effects.js';
import type { Effect } from '../effects.js';
import type { ReactContext } from '../context.js';
import { Simulator, cooperativeWorld } from '../test-support/simulator.js';
import { startWorkflow, WORKFLOW_ID } from '../test-support/fixtures.js';
import {
  alertGateId,
  budgetBlocked,
  budgetPolicy,
  filterPolicyEffects,
} from './budget.js';
import { exceptionsPolicy } from './exceptions.js';
import { cancelPolicy } from './cancel.js';

const modules = {
  ...DEFAULT_MODULES,
  stages: Object.fromEntries(
    Object.keys(DEFAULT_MODULES.stages).map((key) => [
      key,
      { react: () => [] },
    ]),
  ) as unknown as typeof DEFAULT_MODULES.stages,
};
function setup(
  stage = 'implement',
  world = cooperativeWorld,
  ondemand = false,
) {
  const sim = new Simulator({
    react: createReact(
      ondemand
        ? {
            ...modules,
            stages: {
              ...modules.stages,
              ondemand: DEFAULT_MODULES.stages.ondemand,
            },
          }
        : modules,
    ),
    world,
  });
  sim.dispatch(startWorkflow());
  for (const s of Object.values(sim.state.stages))
    s.status =
      s.id === stage
        ? 'running'
        : s.index < sim.state.stages[stage]!.index
          ? 'done'
          : 'pending';
  sim.state.stages[stage]!.attempt = 1;
  return sim;
}
function agent(
  sim: Simulator,
  id: string,
  purpose: AttemptPurpose = 'worker',
  stageId = 'implement',
) {
  if (purpose === 'worker') {
    sim.state.workItems[id] = {
      key: id,
      title: id,
      body: 'body',
      acceptance: ['test'],
      role: 'engineer',
      agent: 'codex',
      deps: [],
      status: 'in_progress',
      approvedGateId: 'approved',
      attemptIds: [id],
      attempt: 1,
      currentAttemptId: id,
    };
    sim.state.workItemOrder.push(id);
  }
  sim.dispatch({
    type: 'SpawnAttempt',
    stageId,
    role:
      purpose === 'worker'
        ? 'engineer'
        : purpose === 'integrator'
          ? 'integrator'
          : 'lead',
    attemptId: id,
    purpose,
    keepOpen: true,
    spawnCommandId: `spawn-${id}`,
    ...(purpose === 'worker' ? { itemKey: id } : {}),
  });
  sim.state.attempts[id]!.agentRef = `agent:${id}`;
  return sim.state.attempts[id]!;
}
function usage(sim: Simulator, id: string, tokens: number) {
  sim.dispatch({
    type: 'RecordUsageTokens',
    usage: {
      attemptId: id,
      budgetTokens: tokens,
      inputUncached: tokens,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0,
    },
  });
}
function choose(sim: Simulator, gateId: string, optionId: string, extra = {}) {
  sim.dispatch({
    type: 'DecideGate',
    gateId,
    expectedVersion: 1,
    decision: 'option',
    optionId,
    by: 'user',
    ...extra,
  });
}
function context<T extends EventType>(
  sim: Simulator,
  type: T,
  payload: EventPayload<T>,
): ReactContext {
  return {
    workflowId: WORKFLOW_ID,
    before: sim.state,
    state: sim.state,
    event: {
      id: 'trigger',
      seq: sim.state.lastSeq + 1,
      schemaVersion: 1,
      workflowId: WORKFLOW_ID,
      occurredAt: sim.clock,
      source: 'engine',
      type,
      payload,
    } as DomainEvent,
  };
}
function open(
  sim: Simulator,
  kind: Extract<OpenGate['gate'], { kind: 'exception' }>['exceptionKind'],
  options: string[],
  itemKey?: string,
) {
  sim.dispatch({
    type: 'OpenGate',
    noLiveAttempts: false,
    gate: {
      gateId: 'gate',
      stageId: 'implement',
      kind: 'exception',
      exceptionKind: kind,
      title: kind,
      content: {
        type: 'exception',
        summary: kind,
        ...(itemKey ? { itemKey } : {}),
      },
      options: options.map((optionId) => ({
        optionId,
        label: optionId,
        ...(optionId === 'reassign' ? { input: 'agent' as const } : {}),
      })),
    },
  });
}
const stops = (sim: Simulator) =>
  sim.issued
    .filter((e) => e.command.kind === 'runtime.stop')
    .map((e) => e.attemptId);

describe('budget enforcement', () => {
  it('preserves alert gate IDs, deduplicates, and top-ups unblock only the item', () => {
    const sim = setup();
    agent(sim, 'a');
    agent(sim, 'b');
    usage(sim, 'a', 400_000);
    usage(sim, 'b', 400_000);
    const gates = Object.values(sim.state.budgetAlerts);
    const a = gates.find((g) => g.scope === 'item' && g.itemKey === 'a')!;
    expect(sim.state.gates[a.gateId!]?.status).toBe('open');
    expect(budgetBlocked(sim.state, 'implement', 'a')).toBe(true);
    choose(sim, a.gateId!, 'top-up', { additionalTokens: 300_000 });
    expect(budgetBlocked(sim.state, 'implement', 'a')).toBe(false);
    expect(budgetBlocked(sim.state, 'implement', 'b')).toBe(true);
    usage(sim, 'a', 1);
    expect(Object.values(sim.state.gates)).toHaveLength(2);
    expect(stops(sim)).toEqual([]);
    expect(sim.rejections).toEqual([]);
  });
  it('item hard limit stops only that worker and uses the increased threshold', () => {
    const sim = setup();
    agent(sim, 'a');
    agent(sim, 'b');
    sim.state.workflow!.budgets.stages.implement!.tokens = 10_000_000;
    usage(sim, 'a', 400_000);
    choose(sim, Object.values(sim.state.budgetAlerts)[0]!.gateId!, 'top-up', {
      additionalTokens: 100_000,
    });
    usage(sim, 'a', 599_999);
    expect(stops(sim)).toEqual([]);
    usage(sim, 'a', 1);
    expect(stops(sim)).toEqual(['a']);
    expect(sim.state.workItems.a!.status).toBe('needs_attention');
    expect(sim.state.attempts.b!.state).toBe('starting');
    expect(sim.rejections).toEqual([]);
  });
  it('stage hard limit includes merge and on-call instances even during hijack', () => {
    const sim = setup();
    agent(sim, 'a');
    agent(sim, 'merge', 'integrator');
    agent(sim, 'oncall', 'oncall');
    sim.inject('runtime.identity_hijacked', {
      run: 'session-1',
      coordinatorHandle: 'other',
      consumerGeneration: 1,
    });
    usage(sim, 'merge', 3_000_000);
    expect(new Set(stops(sim))).toEqual(new Set(['a', 'merge', 'oncall']));
    expect(
      sim.issued.filter((e) => e.command.kind === 'runtime.send'),
    ).toHaveLength(0);
    expect(sim.rejections).toEqual([]);
  });
  it('soft stage budget reminds a lead, or all workers when no lead exists', () => {
    for (const lead of [false, true]) {
      const sim = setup();
      agent(sim, 'a');
      agent(sim, 'b');
      if (lead) agent(sim, 'lead', 'oncall');
      sim.inject('budget.exceeded', {
        scope: 'stage',
        stageId: 'implement',
        stageAttempt: 1,
        metric: 'tokens',
        used: 100,
        budget: 100,
        threshold: 100,
      });
      expect(
        sim.issued
          .filter((e) => e.command.kind === 'runtime.send')
          .map((e) => e.attemptId),
      ).toEqual(lead ? ['lead'] : ['a', 'b']);
      expect(budgetBlocked(sim.state, 'implement')).toBe(true);
      expect(budgetBlocked(sim.state, 'meeting')).toBe(false);
    }
  });
  it('workflow budgets affect all stages, while old stage and item attempts do not block', () => {
    const sim = setup();
    agent(sim, 'a');
    sim.inject('budget.exceeded', {
      scope: 'workflow',
      metric: 'tokens',
      used: 100,
      budget: 100,
      threshold: 100,
    });
    expect(budgetBlocked(sim.state, 'meeting')).toBe(true);
    const alert = Object.values(sim.state.budgetAlerts)[0]!;
    choose(
      sim,
      alertGateId(
        context(sim, 'workflow.resumed', { reason: 'budget' }),
        alert,
      ),
      'top-up',
      { additionalTokens: 10 },
    );
    expect(budgetBlocked(sim.state, 'meeting')).toBe(false);
    sim.inject('budget.exceeded', {
      scope: 'stage',
      stageId: 'implement',
      stageAttempt: 1,
      metric: 'turns',
      used: 2,
      budget: 2,
      threshold: 2,
    });
    sim.state.stages.implement!.attempt = 2;
    expect(budgetBlocked(sim.state, 'implement')).toBe(false);
  });
  it('stops no unrelated agents and safely ignores absent workflow, cancelled workflow and unscoped stale alerts', () => {
    const sim = setup();
    const ctx = context(sim, 'budget.exceeded', {
      scope: 'workflow',
      metric: 'tokens',
      used: 1,
      budget: 1,
      threshold: 1,
    });
    sim.state.stages.implement!.status = 'done';
    expect(budgetPolicy(ctx)).toEqual([]);
    sim.state.workflow!.cancelRequested = true;
    expect(budgetPolicy(ctx)).toEqual([]);
    sim.state.workflow = null;
    expect(budgetPolicy(ctx)).toEqual([]);
  });
});

describe('cancel drain', () => {
  it.each(['meeting', 'breakdown', 'implement', 'integrate', 'final-pr'])(
    'cancels %s with timers, open gates, labels and retained workspaces',
    (stage) => {
      const sim = setup(stage);
      if (stage !== 'final-pr')
        agent(
          sim,
          'agent',
          stage === 'implement'
            ? 'oncall'
            : stage === 'meeting'
              ? 'facilitator'
              : stage === 'breakdown'
                ? 'planner'
                : 'integrator',
          stage,
        );
      sim.inject('timer.scheduled', {
        timerId: 'timer',
        fireAt: '2026-11-18T00:00:00.000Z',
        payload: { purpose: 'stage-timeout', stageId: stage, attempt: 1 },
      });
      sim.state.artifacts.issue = {
        artifactId: 'issue',
        kind: 'issue',
        purpose: 'conclusion',
        number: 7,
        url: 'https://github.com/octo/demo/issues/7',
        createdAt: sim.clock,
      };
      sim.state.workflow!.finalPr = 8;
      sim.dispatch({
        type: 'OpenGate',
        noLiveAttempts: false,
        gate: {
          gateId: 'cancel-gate',
          stageId: stage,
          kind: 'exception',
          exceptionKind: 'anomaly',
          title: 'anomaly',
          options: [
            { optionId: 'continue', label: 'continue' },
            { optionId: 'abort', label: 'abort' },
          ],
          content: { type: 'exception', summary: 'test' },
        },
      });
      sim.dispatch({ type: 'RequestCancel', by: 'user' });
      expect(sim.state.workflow!.status).toBe('cancelled');
      expect(sim.state.gates['cancel-gate']!.closedReason).toBe('cancelled');
      expect(sim.state.timers).toEqual({});
      expect(
        sim.issued
          .filter((e) => e.command.kind === 'runtime.release')
          .every(
            (e) =>
              e.command.kind === 'runtime.release' &&
              !e.command.args.removeWorkspace,
          ),
      ).toBe(true);
      expect(
        sim.issued.filter((e) => e.command.kind === 'scm.setLabels'),
      ).toHaveLength(2);
      expect(
        sim.issued.some((e) => e.command.kind === 'runtime.disposeWorkspace'),
      ).toBe(false);
      expect(sim.rejections).toEqual([]);
    },
  );
  it('aborting the anomaly gate cancels on-demand instances despite hijack', () => {
    const sim = setup();
    agent(sim, 'merge', 'integrator');
    agent(sim, 'oncall', 'oncall');
    sim.inject('runtime.identity_hijacked', {
      run: 'session-1',
      coordinatorHandle: 'other',
      consumerGeneration: 1,
    });
    choose(sim, Object.keys(sim.state.gates)[0]!, 'abort');
    expect(sim.state.workflow!.status).toBe('cancelled');
    expect(stops(sim)).toEqual(['merge', 'oncall']);
    expect(sim.rejections).toEqual([]);
  });
  it('waits for pending spawns and failed stop commands, and never marks cancellation early', () => {
    const sim = setup('implement', (issued, s) =>
      issued.command.kind === 'runtime.stop'
        ? undefined
        : cooperativeWorld(issued, s),
    );
    const a = agent(sim, 'a');
    delete a.agentRef;
    sim.dispatch({ type: 'RequestCancel', by: 'user' });
    expect(sim.state.workflow!.status).toBe('running');
    a.agentRef = 'agent:a';
    sim.inject('seat.activity', {
      attemptId: 'a',
      activity: [
        {
          messageId: 'm',
          category: 'other',
          inputLen: 0,
          outputLen: 0,
          inputHash: 'a'.repeat(64),
        },
      ],
    });
    expect(stops(sim)).toEqual(['a']);
    sim.inject('seat.activity', {
      attemptId: 'a',
      activity: [
        {
          messageId: 'm',
          category: 'other',
          inputLen: 0,
          outputLen: 0,
          inputHash: 'a'.repeat(64),
        },
      ],
    });
    expect(stops(sim)).toEqual(['a']);
    expect(sim.state.workflow!.status).toBe('running');
  });
});

describe('exception and pause handling', () => {
  it.each(['anomaly', 'hijacked'] as const)(
    '%s belongs to the latest reached stage while its gate is open',
    (kind) => {
      const sim = setup('integrate');
      for (const stage of Object.values(sim.state.stages))
        if (stage.status !== 'pending') stage.attempt = 1;
      sim.state.stages.integrate!.status = 'awaiting_gate';
      if (kind === 'anomaly')
        sim.inject('anomaly.detected', {
          kind: 'unknown-object',
          severity: 'high',
          summary: 'Unexpected object',
        });
      else
        sim.inject('runtime.identity_hijacked', {
          run: 'session-1',
          coordinatorHandle: 'other',
          consumerGeneration: 1,
        });
      expect(Object.values(sim.state.gates)).toEqual([
        expect.objectContaining({ exceptionKind: kind, stageId: 'integrate' }),
      ]);
    },
  );

  it('an attempt anomaly retains its stage after the workflow advances', () => {
    const sim = setup('breakdown');
    agent(sim, 'planner', 'planner', 'breakdown');
    sim.state.stages.breakdown!.status = 'done';
    sim.state.stages.implement!.status = 'running';
    sim.inject('anomaly.detected', {
      kind: 'policy-hit',
      severity: 'high',
      summary: 'Policy violation',
      attemptId: 'planner',
    });
    expect(Object.values(sim.state.gates)[0]).toMatchObject({
      exceptionKind: 'anomaly',
      stageId: 'breakdown',
    });
  });

  it.each(['event', 'command'] as const)(
    'an anomaly uses its %s stage before the currently running stage',
    (source) => {
      const sim = setup('breakdown');
      agent(sim, 'planner', 'planner', 'breakdown');
      sim.state.stages.breakdown!.status = 'done';
      sim.state.stages.implement!.status = 'running';
      sim.state.commands['old-send'] = {
        id: 'old-send',
        attemptId: 'planner',
        issuedAt: sim.clock,
        status: 'succeeded',
        issued: {
          commandId: 'old-send',
          kind: 'runtime.send',
          args: { agent: 'agent:planner', subject: 'Plan', body: 'Plan' },
        },
      };
      const ctx = context(sim, 'anomaly.detected', {
        kind: 'unknown-object',
        severity: 'high',
        summary: 'Unexpected object',
        ...(source === 'command' ? { commandId: 'old-send' } : {}),
      });
      if (source === 'event') ctx.event.stageId = 'breakdown';
      expect(exceptionsPolicy(ctx)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            command: expect.objectContaining({
              type: 'OpenGate',
              gate: expect.objectContaining({ stageId: 'breakdown' }),
            }),
          }),
        ]),
      );
    },
  );

  it.each([
    'budget-exceeded',
    'budget-hard-limit',
    'item-budget-exceeded',
    'item-budget-hard-limit',
  ] as const)('%s belongs to its triggering stage', (kind) => {
    const sim = setup();
    agent(sim, 'a');
    const item = kind.startsWith('item-');
    sim.inject(
      kind.endsWith('hard-limit') ? 'budget.hard_limit' : 'budget.exceeded',
      {
        ...(item
          ? {
              scope: 'item' as const,
              stageId: 'implement',
              itemKey: 'a',
              attemptId: 'a',
            }
          : { scope: 'stage' as const, stageId: 'implement', stageAttempt: 1 }),
        metric: 'tokens',
        used: 100,
        budget: 100,
        threshold: 100,
      },
    );
    expect(Object.values(sim.state.gates)).toEqual([
      expect.objectContaining({ exceptionKind: kind, stageId: 'implement' }),
    ]);
  });
  it('never automatically reclaims; resumes only after an authorized successful reclaim', () => {
    const sim = setup('implement', (e, s) =>
      e.command.kind === 'runtime.reclaimSession'
        ? { ok: true, result: { reclaimed: true } }
        : cooperativeWorld(e, s),
    );
    sim.inject('runtime.identity_hijacked', {
      run: 'session-1',
      coordinatorHandle: 'other',
      consumerGeneration: 1,
    });
    expect(sim.state.workflow!.pausedReasons).toEqual(['anomaly']);
    expect(
      sim.issued.some((e) => e.command.kind === 'runtime.reclaimSession'),
    ).toBe(false);
    choose(sim, Object.keys(sim.state.gates)[0]!, 'reclaim');
    expect(sim.state.workflow!.pausedReasons).toEqual([]);
    expect(
      sim.issued.filter((e) => e.command.kind === 'runtime.reclaimSession'),
    ).toHaveLength(1);
    expect(sim.rejections).toEqual([]);
  });
  it('a declined reclaim leaves dispatch paused and usage outages never pause', () => {
    const sim = setup('implement', (e, s) =>
      e.command.kind === 'runtime.reclaimSession'
        ? { ok: true, result: { reclaimed: false } }
        : cooperativeWorld(e, s),
    );
    sim.inject('health.changed', { component: 'usage', status: 'unhealthy' });
    expect(sim.state.workflow!.pausedReasons).toEqual([]);
    sim.inject('runtime.identity_hijacked', {
      run: 'session-1',
      coordinatorHandle: 'other',
      consumerGeneration: 1,
    });
    choose(sim, Object.keys(sim.state.gates)[0]!, 'reclaim');
    expect(sim.state.workflow!.pausedReasons).toEqual(['anomaly']);
  });
  it.each(['runtime', 'scm', 'store'] as const)(
    'pauses and resumes %s health without gates',
    (component) => {
      const sim = setup();
      sim.inject('health.changed', { component, status: 'unhealthy' });
      expect(sim.state.workflow!.pausedReasons).toEqual([
        `${component}_unhealthy`,
      ]);
      expect(sim.state.gates).toEqual({});
      sim.inject('health.changed', { component, status: 'healthy' });
      expect(sim.state.workflow!.pausedReasons).toEqual([]);
    },
  );
  it('high policy hits stop the offending attempt and an anomaly gate can continue', () => {
    const sim = setup();
    agent(sim, 'a');
    agent(sim, 'b');
    sim.dispatch({
      type: 'EvaluateAnomaly',
      observation: {
        kind: 'policy-hits',
        attemptId: 'a',
        hits: [
          { rule: 'orca-dispatch', severity: 'high', messageId: 'message' },
        ],
      },
    });
    expect(stops(sim)).toEqual(['a']);
    choose(sim, Object.keys(sim.state.gates)[0]!, 'continue');
    expect(sim.state.workflow!.pausedReasons).toEqual([]);
    expect(sim.rejections).toEqual([]);
  });
  it('a worker run-use of another run stops only that worker, once, beside the hijack gate', () => {
    const sim = setup();
    agent(sim, 'a');
    agent(sim, 'b');
    // Detection of the takeover itself has no attempt, so it stops nothing.
    sim.inject('runtime.identity_hijacked', {
      run: 'session-1',
      coordinatorHandle: 'other',
      consumerGeneration: 1,
    });
    expect(stops(sim)).toEqual([]);
    const runUse = (messageId: string) =>
      sim.dispatch({
        type: 'EvaluateAnomaly',
        observation: {
          kind: 'policy-hits',
          attemptId: 'a',
          hits: [
            // Severity-independent: a downgraded rule still stops.
            { rule: 'orca-run-use', severity: 'medium', messageId },
          ],
        },
      });
    runUse('m1');
    runUse('m2');
    expect(stops(sim)).toEqual(['a']);
    expect(
      sim.issued.find((e) => e.command.kind === 'runtime.stop')!.commandId,
    ).toBe(`${WORKFLOW_ID}/stop/a/run-use`);
    // The hijack gate keeps its own reclaim path.
    const hijacked = Object.values(sim.state.gates).find(
      (g) => g.kind === 'exception' && g.exceptionKind === 'hijacked',
    )!;
    expect(hijacked.status).toBe('open');
    expect(sim.rejections).toEqual([]);
  });
  it('run-use stops wait for the agent ref and other hits do not use the run-use fuse', () => {
    const sim = setup();
    const a = agent(sim, 'a');
    delete a.agentRef;
    const hit = {
      rule: 'orca-run-use' as const,
      messageId: 'm',
      severity: 'high' as const,
    };
    expect(
      exceptionsPolicy(
        context(sim, 'seat.policy_violation', { attemptId: 'a', hits: [hit] }),
      ),
    ).toEqual([]);
    a.agentRef = 'agent:a';
    expect(
      exceptionsPolicy(
        context(sim, 'seat.policy_violation', {
          attemptId: 'a',
          hits: [{ ...hit, rule: 'orca-dispatch' }],
        }),
      ),
    ).toMatchObject([{ commandId: `${WORKFLOW_ID}/stop/a/policy/trigger` }]);
  });
  it('finish sends an explicit wrap-up and item skip stops only the chosen item', () => {
    const sim = setup();
    agent(sim, 'a');
    agent(sim, 'b');
    usage(sim, 'a', 400_000);
    choose(sim, Object.keys(sim.state.gates)[0]!, 'finish');
    expect(
      sim.issued.some(
        (e) =>
          e.command.kind === 'runtime.send' &&
          e.command.args.subject === 'Finish now',
      ),
    ).toBe(true);
    usage(sim, 'a', 400_000);
    const hard = Object.values(sim.state.gates).find(
      (g) =>
        g.kind === 'exception' && g.exceptionKind === 'item-budget-hard-limit',
    )!;
    choose(sim, hard.gateId, 'skip');
    expect(sim.state.workItems.a!.status).toBe('skipped');
    expect(sim.state.attempts.b!.state).toBe('starting');
    expect(sim.rejections).toEqual([]);
  });
  it('reruns a failed stage only after all instances exit, with agent override', () => {
    const sim = setup();
    agent(sim, 'merge', 'integrator');
    open(sim, 'stage-violation', ['rerun', 'reassign', 'abort']);
    choose(sim, 'gate', 'reassign', { agent: 'codex' });
    expect(sim.state.stages.implement!.attempt).toBe(2);
    expect(sim.state.stages.implement!.agentOverride).toBe('codex');
    expect(sim.rejections).toEqual([]);
  });
  it.each([
    'dependency-blocked',
    'merge-blocked',
    'rework-limit',
    'merge-review-failed',
  ] as const)('preserves domain skip behavior for %s', (kind) => {
    const sim = setup();
    agent(sim, 'a');
    agent(sim, 'b');
    sim.state.workItems.b!.deps = ['a'];
    open(sim, kind, ['skip', 'abort'], 'a');
    choose(sim, 'gate', 'skip');
    expect(sim.state.workItems.a!.status).toBe('skipped');
    expect(sim.state.workItems.b!.status).toBe(
      kind === 'dependency-blocked' ? 'skipped' : 'in_progress',
    );
    expect(sim.rejections).toEqual([]);
  });
});

it('central policy filter suppresses dispatch without suppressing hard stops', () => {
  const sim = setup();
  const a = agent(sim, 'a');
  const ctx = context(sim, 'workflow.paused', { reason: 'anomaly' });
  sim.state.workflow!.pausedReasons = ['anomaly'];
  const effects: Effect[] = [
    external('spawn', {
      kind: 'runtime.spawnAgent',
      args: {
        session: 's',
        agent: 'codex',
        title: 'x',
        specPath: '/x',
        specSha256: 'a'.repeat(64),
        workspace: {
          kind: 'existing-worktree',
          workspace: 'ws',
          readOnly: true,
        },
        keepOpen: true,
      },
    }),
    internal({
      type: 'StartStage',
      meta: { occurredAt: sim.clock, source: 'engine' },
      stageId: 'implement',
    }),
    external('stop', { kind: 'runtime.stop', args: { agent: a.agentRef! } }),
  ];
  expect(filterPolicyEffects(ctx, effects)).toEqual([effects[2]]);
  sim.state.workflow!.pausedReasons = [];
  expect(filterPolicyEffects(ctx, effects)).toEqual(effects);
  expect(
    exceptionsPolicy(context(sim, 'workflow.resumed', { reason: 'budget' })),
  ).toEqual([]);
  expect(cancelPolicy(ctx)).toEqual([]);
});

describe('recovery and exception choices', () => {
  it('retries and reassigns failed items without disturbing another worker', () => {
    for (const option of ['retry', 'reassign']) {
      const sim = setup();
      agent(sim, 'a');
      agent(sim, 'b');
      open(sim, 'workitem-failed', ['retry', 'reassign', 'skip', 'abort'], 'a');
      choose(
        sim,
        'gate',
        option,
        option === 'reassign' ? { agent: 'codex' } : {},
      );
      expect(sim.state.workItems.a!.status).toBe('needs_attention');
      expect(stops(sim)).toEqual(['a']);
      expect(sim.rejections).toEqual([]);
    }
  });
  it('accepts additional item hard-limit choices and preserves the selected agent', () => {
    for (const option of ['retry', 'reassign', 'top-up-rerun']) {
      const sim = setup();
      agent(sim, 'a');
      usage(sim, 'a', 800_000);
      const gate = Object.values(sim.state.gates).find(
        (g) =>
          g.kind === 'exception' &&
          g.exceptionKind === 'item-budget-hard-limit',
      )!;
      choose(sim, gate.gateId, option, {
        agent: 'claude-code',
        additionalTokens: 100_000,
      });
      expect(gate.gateId).toBe(sim.state.gates[gate.gateId]!.decision!.gateId);
      expect(budgetBlocked(sim.state, 'implement', 'a')).toBe(false); // The hard-limit decision supersedes the soft alert.
      expect(sim.rejections).toEqual([]);
    }
  });
  it('uses an available item PR and human-approved merge-review bypass pins the SHA', () => {
    const sim = setup();
    agent(sim, 'a');
    const item = sim.state.workItems.a!;
    item.pr = 12;
    item.headSha = 'a'.repeat(40);
    item.status = 'pr_open';
    open(sim, 'item-budget-hard-limit', ['use-output', 'abort'], 'a');
    choose(sim, 'gate', 'use-output');
    expect(item.pr).toBe(12);
    expect(sim.state.workItems.a!.status).toBe('merge_queued');
    expect(sim.rejections).toEqual([]);
    const merge = setup();
    agent(merge, 'a');
    Object.assign(merge.state.workItems.a!, {
      pr: 12,
      headSha: 'a'.repeat(40),
      status: 'needs_attention',
    });
    open(merge, 'merge-review-failed', ['merge', 'abort'], 'a');
    choose(merge, 'gate', 'merge');
    expect(
      merge.issued.find((e) => e.command.kind === 'scm.mergePR')?.command,
    ).toEqual({
      kind: 'scm.mergePR',
      args: {
        pr: { repo: { owner: 'octo', name: 'demo' }, number: 12 },
        expectedHeadSha: 'a'.repeat(40),
        method: 'merge',
      },
    });
  });
  it('use-output completes a stopped stage only when submitted output exists', () => {
    const sim = setup();
    const a = agent(sim, 'integrator', 'integrator');
    a.state = 'exited';
    sim.state.artifacts.report = {
      artifactId: 'report',
      kind: 'integration-report',
      submissionId: 'report',
      attemptId: a.attemptId,
      createdAt: sim.clock,
    };
    open(sim, 'budget-hard-limit', ['use-output', 'abort']);
    choose(sim, 'gate', 'use-output');
    expect(sim.state.stages.implement!.status).toBe('done');
    expect(sim.rejections).toEqual([]);
    const empty = setup();
    open(empty, 'budget-hard-limit', ['use-output', 'abort']);
    choose(empty, 'gate', 'use-output');
    expect(empty.state.stages.implement!.status).toBe('running');
  });
  it('does not resume an anomaly while a separate hijack is still unresolved', () => {
    const sim = setup();
    sim.inject('anomaly.detected', {
      kind: 'unknown-object',
      severity: 'medium',
      summary: 'unmarked object',
    });
    const anomaly = Object.keys(sim.state.gates)[0]!;
    sim.inject('anomaly.detected', {
      kind: 'unknown-object',
      severity: 'medium',
      summary: 'same unresolved kind',
    });
    expect(Object.values(sim.state.gates)).toHaveLength(1);
    sim.inject('runtime.identity_hijacked', {
      run: 'session-1',
      coordinatorHandle: 'other',
      consumerGeneration: 1,
    });
    choose(sim, anomaly, 'continue');
    expect(sim.state.workflow!.pausedReasons).toEqual(['anomaly']);
  });
  it('reclaim success cannot resume unrelated anomalies or an unapproved gate', () => {
    const sim = setup();
    sim.inject('anomaly.detected', {
      kind: 'unknown-object',
      severity: 'medium',
      summary: 'object',
    });
    const ctx = context(sim, 'command.succeeded', {
      commandId: 'unapproved',
      kind: 'runtime.reclaimSession',
      result: { reclaimed: true },
    });
    expect(exceptionsPolicy(ctx)).toEqual([]);
    const noSession = setup();
    noSession.state.commands = {};
    noSession.inject('runtime.identity_hijacked', {
      run: 'session-1',
      coordinatorHandle: 'other',
      consumerGeneration: 1,
    });
    choose(noSession, Object.keys(noSession.state.gates)[0]!, 'reclaim');
    expect(
      noSession.issued.some((e) => e.command.kind === 'runtime.reclaimSession'),
    ).toBe(false);
  });
  it('stage reruns wait for stopped instances and do not repeat an old decision', () => {
    const sim = setup('implement', (e, s) =>
      e.command.kind === 'runtime.stop' ? undefined : cooperativeWorld(e, s),
    );
    const a = agent(sim, 'merge', 'integrator');
    open(sim, 'stage-violation', ['rerun', 'abort']);
    choose(sim, 'gate', 'rerun', { comment: 'try again' });
    expect(sim.state.stages.implement!.attempt).toBe(1);
    sim.inject('seat.exited', {
      attemptId: a.attemptId,
      reason: 'stopped',
      expected: true,
    });
    expect(sim.state.stages.implement!.attempt).toBe(2);
    expect(sim.state.stages.implement!.feedback).toBe('try again');
    const b = agent(sim, 'new', 'integrator');
    sim.inject('seat.exited', {
      attemptId: b.attemptId,
      reason: 'stopped',
      expected: true,
    });
    expect(sim.state.stages.implement!.attempt).toBe(2);
    expect(sim.rejections).toEqual([]);
  });
  it('hard stage top-up reruns only after all agents stop', () => {
    const sim = setup();
    sim.state.workflow!.budgets.workflow = { tokens: 10_000_000 };
    agent(sim, 'merge', 'integrator');
    usage(sim, 'merge', 3_000_000);
    const gate = Object.values(sim.state.gates).find(
      (g) => g.kind === 'exception' && g.exceptionKind === 'budget-hard-limit',
    )!;
    choose(sim, gate.gateId, 'top-up-rerun', { additionalTokens: 100_000 });
    expect(sim.state.stages.implement!.attempt).toBe(2);
    expect(sim.rejections).toEqual([]);
  });
  it('anomalies after a stage ends still open a gate, but absent workflow/stages are ignored', () => {
    const sim = setup();
    sim.state.stages.implement!.status = 'done';
    sim.inject('anomaly.detected', {
      kind: 'unknown-object',
      severity: 'medium',
      summary: 'object',
    });
    expect(Object.values(sim.state.gates)).toHaveLength(1);
    const blank = setup();
    blank.state.stages = {};
    blank.state.stageOrder = [];
    expect(
      exceptionsPolicy(
        context(blank, 'anomaly.detected', {
          kind: 'unknown-object',
          severity: 'medium',
          summary: 'object',
        }),
      ),
    ).toEqual([]);
    blank.state.workflow = null;
    expect(
      exceptionsPolicy(
        context(blank, 'workflow.resumed', { reason: 'budget' }),
      ),
    ).toEqual([]);
  });
  it('high policy hits with missing refs remain safe; low hits never stop', () => {
    const sim = setup();
    const a = agent(sim, 'a');
    delete a.agentRef;
    const hit = {
      rule: 'orca-dispatch' as const,
      messageId: 'm',
      severity: 'high' as const,
    };
    expect(
      exceptionsPolicy(
        context(sim, 'seat.policy_violation', {
          attemptId: 'missing',
          hits: [hit],
        }),
      ),
    ).toEqual([]);
    expect(
      exceptionsPolicy(
        context(sim, 'seat.policy_violation', {
          attemptId: 'a',
          hits: [{ ...hit, severity: 'medium' }],
        }),
      ),
    ).toEqual([]);
    usage(sim, 'a', 400_000);
    expect(
      sim.issued.filter((e) => e.command.kind === 'runtime.send'),
    ).toHaveLength(0);
    choose(sim, Object.keys(sim.state.gates)[0]!, 'finish');
    expect(sim.rejections).toEqual([]);
  });
});

it('late spawn results after a hard stop are stopped using the same fuse ID', () => {
  const sim = setup();
  const a = agent(sim, 'a');
  delete a.agentRef;
  usage(sim, 'a', 800_000);
  expect(stops(sim)).toEqual([]);
  a.agentRef = 'agent:a';
  const effects = budgetPolicy(
    context(sim, 'command.succeeded', {
      commandId: 'spawn-a',
      kind: 'runtime.spawnAgent',
      result: { agent: 'agent:a' },
    }),
  );
  expect(effects).toHaveLength(1);
  expect(effects[0]).toMatchObject({
    kind: 'external',
    command: { kind: 'runtime.stop', args: { agent: 'agent:a' } },
  });
});

it('cancel labels all recorded and just-created artifacts and preserves known labels', () => {
  const sim = setup();
  agent(sim, 'a');
  const item = sim.state.workItems.a!;
  item.issue = 10;
  item.pr = 11;
  sim.state.artifacts.pr = {
    artifactId: 'pr',
    kind: 'pr',
    purpose: 'worker',
    head: 'worker',
    base: 'integration',
    number: 11,
    url: 'https://github.com/octo/demo/pull/11',
    createdAt: sim.clock,
  };
  sim.state.issueDrift[10] = {
    issue: 10,
    labels: ['existing'],
    bodyHash: 'a'.repeat(64),
    githubUpdatedAt: sim.clock,
  };
  sim.state.commands.issue = {
    id: 'issue',
    issuedAt: sim.clock,
    status: 'succeeded',
    issued: {
      commandId: 'issue',
      kind: 'scm.createIssue',
      args: {
        repo: { owner: 'octo', name: 'demo' },
        title: 'issue',
        body: 'body',
        labels: ['managed'],
      },
    },
    result: {
      kind: 'scm.createIssue',
      result: { issue: 10, url: 'https://github.com/octo/demo/issues/10' },
    },
  };
  sim.state.commands.pr = {
    id: 'pr',
    issuedAt: sim.clock,
    status: 'succeeded',
    issued: {
      commandId: 'pr',
      kind: 'scm.openPR',
      args: {
        repo: { owner: 'octo', name: 'demo' },
        title: 'pr',
        body: 'body',
        head: 'head',
        base: 'base',
        draft: false,
      },
    },
    result: {
      kind: 'scm.openPR',
      result: { pr: 12, url: 'https://github.com/octo/demo/pull/12' },
    },
  };
  sim.state.commands.labels = {
    id: 'labels',
    issuedAt: sim.clock,
    status: 'succeeded',
    issued: {
      commandId: 'labels',
      kind: 'scm.setLabels',
      args: {
        target: {
          repo: { owner: 'octo', name: 'demo' },
          type: 'issue',
          number: 10,
        },
        labels: ['previous'],
      },
    },
  };
  sim.dispatch({ type: 'RequestCancel', by: 'user' });
  const label = sim.issued.find(
    (e) =>
      e.command.kind === 'scm.setLabels' && e.command.args.target.number === 10,
  )!;
  expect(label.command).toMatchObject({
    args: {
      labels: ['existing', 'managed', 'previous', 'ai-office:cancelled'],
    },
  });
  expect(sim.state.workflow!.status).toBe('cancelled');
  expect(sim.rejections).toEqual([]);
});

it('cancel waits for a pending PR and failed label write, but a failed spawn needs no release', () => {
  const sim = setup('implement', (e, s) =>
    e.command.kind === 'scm.setLabels' ? undefined : cooperativeWorld(e, s),
  );
  const a = agent(sim, 'a');
  delete a.agentRef;
  sim.state.commands[a.spawnCommandId] = {
    id: a.spawnCommandId,
    issuedAt: sim.clock,
    status: 'failed',
    issued: {
      commandId: a.spawnCommandId,
      kind: 'runtime.stop',
      args: { agent: 'a' },
    },
  };
  sim.state.commands.pr = {
    id: 'pr',
    issuedAt: sim.clock,
    status: 'issued',
    issued: {
      commandId: 'pr',
      kind: 'scm.openPR',
      args: {
        repo: { owner: 'octo', name: 'demo' },
        title: 'pr',
        body: 'body',
        head: 'head',
        base: 'base',
        draft: false,
      },
    },
  };
  sim.dispatch({ type: 'RequestCancel', by: 'user' });
  expect(sim.state.workflow!.status).toBe('running');
  sim.inject('command.succeeded', {
    commandId: 'pr',
    kind: 'scm.openPR',
    result: { pr: 7, url: 'https://github.com/octo/demo/pull/7' },
  });
  expect(sim.state.workflow!.status).toBe('running');
  expect(
    sim.issued.filter((e) => e.command.kind === 'scm.setLabels'),
  ).toHaveLength(1);
  const ctx = context(sim, 'workflow.cancel_requested', { by: 'user' });
  expect(cancelPolicy(ctx)).toEqual([]);
});

it('filters every dispatch form and keeps merge assignments paused without blocking finish messages', () => {
  const sim = setup();
  const a = agent(sim, 'a');
  const merge = agent(sim, 'merge', 'integrator');
  const ctx = context(sim, 'workflow.resumed', { reason: 'anomaly' });
  const meta = { occurredAt: sim.clock, source: 'engine' as const };
  const effects: Effect[] = [
    internal({
      type: 'SpawnAttempt',
      meta,
      stageId: 'implement',
      role: 'engineer',
      purpose: 'worker',
      itemKey: 'a',
      attemptId: 'next',
      keepOpen: true,
      spawnCommandId: 'new',
    }),
    {
      kind: 'spawn',
      stageId: 'implement',
      seatId: 'seat',
      attemptId: 'next',
      commandId: 'new',
      agent: 'codex',
      spec: {
        purpose: 'worker',
        stageId: 'implement',
        itemKey: 'a',
        attempt: 2,
      },
      workspace: {
        kind: 'existing-worktree',
        workspace: 'ws',
        readOnly: false,
      },
      keepOpen: true,
    },
    internal({
      type: 'DispatchWorkItem',
      meta,
      itemKey: 'a',
      attemptId: 'next',
    }),
    internal({
      type: 'StartOnDemand',
      meta,
      instance: { purpose: 'merge', stageId: 'implement', attemptId: 'merge' },
    }),
    external(
      'assignment',
      {
        kind: 'runtime.send',
        args: { agent: merge.agentRef!, subject: 'review', body: 'PR' },
      },
      { stageId: 'implement', attemptId: 'merge' },
    ),
    external(
      'merge',
      {
        kind: 'scm.mergePR',
        args: {
          pr: { repo: { owner: 'octo', name: 'demo' }, number: 1 },
          expectedHeadSha: 'a'.repeat(40),
          method: 'merge',
        },
      },
      { stageId: 'implement' },
    ),
    external('wf-1/finish/gate/merge', {
      kind: 'runtime.send',
      args: { agent: merge.agentRef!, subject: 'finish', body: 'finish' },
    }),
    external('stop', { kind: 'runtime.stop', args: { agent: a.agentRef! } }),
  ];
  sim.state.workItems.a!.pr = 1;
  sim.state.workflow!.pausedReasons = ['anomaly'];
  expect(filterPolicyEffects(ctx, effects)).toEqual([
    effects[3],
    ...effects.slice(-2),
  ]);
  sim.state.workflow!.pausedReasons = [];
  expect(filterPolicyEffects(ctx, effects)).toEqual(effects);
  usage(sim, 'a', 400_000);
  ctx.state = sim.state;
  expect(filterPolicyEffects(ctx, effects)).toEqual(
    effects.slice(3, 5).concat(effects.slice(-2)),
  );
  sim.state.workItems.a!.currentAttemptId = 'newer';
  expect(budgetBlocked(sim.state, 'implement', 'a')).toBe(false);
  sim.state.workflow = null;
  expect(filterPolicyEffects(ctx, effects)).toEqual(effects.slice(-2));
});

it('budget gates are idempotent, hard stops include workflow scope, and closed old gates unblock', () => {
  const sim = setup();
  agent(sim, 'a');
  agent(sim, 'merge', 'integrator');
  const p = {
    scope: 'workflow' as const,
    metric: 'tokens' as const,
    used: 2,
    budget: 1,
    threshold: 2,
    gateId: 'fuse',
  };
  sim.inject('budget.hard_limit', p);
  expect(new Set(stops(sim))).toEqual(new Set(['a', 'merge']));
  expect(
    budgetPolicy(context(sim, 'budget.hard_limit', p)).filter(
      (e) => e.kind === 'internal' && e.command.type === 'OpenGate',
    ),
  ).toEqual([]);
  sim.dispatch({ type: 'CloseGate', gateId: 'fuse', reason: 'superseded' });
  expect(budgetBlocked(sim.state, 'implement')).toBe(false);
});

it('top-up-rerun credit survives only the same item or stage retry', () => {
  const item = setup();
  agent(item, 'a');
  agent(item, 'b');
  item.state.workflow!.budgets.stages.implement!.tokens = 10_000_000;
  usage(item, 'a', 800_000);
  const hard = Object.values(item.state.gates).find(
    (g) =>
      g.kind === 'exception' && g.exceptionKind === 'item-budget-hard-limit',
  )!;
  choose(item, hard.gateId, 'top-up-rerun', { additionalTokens: 100_000 });
  const previous = item.state.attempts.a!;
  item.dispatch({ type: 'DispatchWorkItem', itemKey: 'a', attemptId: 'a2' });
  item.dispatch({
    type: 'SpawnAttempt',
    stageId: 'implement',
    role: 'engineer',
    purpose: 'worker',
    itemKey: 'a',
    attemptId: 'a2',
    retryOf: 'a',
    spawnCommandId: 'spawn-a2',
    keepOpen: true,
  });
  usage(item, 'a2', 499_999);
  expect(
    Object.values(item.state.budgetAlerts).filter(
      (g) => g.scope === 'item' && g.attemptId === 'a2',
    ),
  ).toEqual([]);
  usage(item, 'a2', 1);
  expect(
    Object.values(item.state.budgetAlerts).find(
      (g) => g.scope === 'item' && g.attemptId === 'a2',
    )?.budget,
  ).toBe(500_000);
  usage(item, 'b', 400_000);
  expect(
    Object.values(item.state.budgetAlerts).find(
      (g) => g.scope === 'item' && g.attemptId === 'b',
    )?.budget,
  ).toBe(400_000);
  expect(previous.state).toBe('exited');
  expect(item.rejections).toEqual([]);

  const stage = setup();
  stage.state.workflow!.budgets.workflow = { tokens: 10_000_000 };
  agent(stage, 'merge', 'integrator');
  usage(stage, 'merge', 3_000_000);
  const gate = Object.values(stage.state.gates).find(
    (g) => g.kind === 'exception' && g.exceptionKind === 'budget-hard-limit',
  )!;
  choose(stage, gate.gateId, 'top-up-rerun', { additionalTokens: 100_000 });
  agent(stage, 'merge2', 'integrator');
  usage(stage, 'merge2', 1_599_999);
  expect(
    Object.values(stage.state.budgetAlerts).filter(
      (g) => g.scope === 'stage' && g.stageAttempt === 2,
    ),
  ).toEqual([]);
  usage(stage, 'merge2', 1);
  expect(
    Object.values(stage.state.budgetAlerts).find(
      (g) => g.scope === 'stage' && g.stageAttempt === 2,
    )?.budget,
  ).toBe(1_600_000);
  expect(stage.rejections).toEqual([]);
});

it('item hard-limit use-output queues only its current observed open PR', () => {
  const sim = setup();
  agent(sim, 'a');
  Object.assign(sim.state.workItems.a!, { pr: 9, headSha: 'a'.repeat(40) });
  sim.state.prs[9] = {
    pr: 9,
    state: 'open',
    head: 'worker',
    base: 'integration',
    headSha: 'a'.repeat(40),
    mergeable: true,
  };
  usage(sim, 'a', 800_000);
  expect(sim.state.workItems.a!.status).toBe('needs_attention');
  const gate = Object.values(sim.state.gates).find(
    (g) =>
      g.kind === 'exception' && g.exceptionKind === 'item-budget-hard-limit',
  )!;
  choose(sim, gate.gateId, 'use-output');
  expect(sim.state.workItems.a!.status).toBe('merge_queued');
  expect(sim.rejections).toEqual([]);
});

it('unexpected exits open anomalies, medium policy hits remind, and custom decisions reach the requester', () => {
  const sim = setup();
  const a = agent(sim, 'a');
  sim.dispatch({
    type: 'RecordPolicyViolation',
    attemptId: 'a',
    hits: [{ rule: 'gh-comment', severity: 'medium', messageId: 'm' }],
  });
  expect(stops(sim)).toEqual([]);
  expect(
    sim.issued.some(
      (e) =>
        e.command.kind === 'runtime.send' &&
        e.command.args.subject === 'Policy reminder',
    ),
  ).toBe(true);
  sim.dispatch({
    type: 'OpenGate',
    noLiveAttempts: false,
    gate: {
      kind: 'exception',
      gateId: 'choice',
      stageId: 'implement',
      exceptionKind: 'decision-request',
      title: 'choice',
      content: { type: 'exception', summary: 'choose', attemptId: 'a' },
      options: [
        { optionId: 'choice-a', label: 'Use A' },
        { optionId: 'abort', label: 'Abort' },
      ],
    },
  });
  choose(sim, 'choice', 'choice-a');
  expect(
    sim.issued.some(
      (e) =>
        e.command.kind === 'runtime.send' && e.command.args.body === 'Use A',
    ),
  ).toBe(true);
  sim.inject('seat.exited', {
    attemptId: a.attemptId,
    reason: 'stopped',
    expected: false,
  });
  expect(sim.state.workflow!.pausedReasons).toContain('anomaly');
  expect(
    Object.values(sim.state.gates).some(
      (g) =>
        g.kind === 'exception' &&
        g.exceptionKind === 'anomaly' &&
        g.status === 'open',
    ),
  ).toBe(true);
  expect(sim.rejections).toEqual([]);
});

it('cancels real merge/on-call modules without removing any worker workspace', () => {
  const sim = setup('implement', cooperativeWorld, true);
  agent(sim, 'a');
  Object.assign(sim.state.workItems.a!, {
    status: 'pr_open',
    pr: 11,
    headSha: 'abcdef2',
  });
  sim.dispatch({
    type: 'QueueWorkItemForMerge',
    item: { itemKey: 'a', attemptId: 'a', pr: 11, headSha: 'abcdef2' },
  });
  sim.dispatch({
    type: 'AskQuestion',
    questionId: 'q',
    attemptId: 'a',
    body: 'Which interface?',
  });
  expect(sim.state.ondemand.implement?.merge?.attemptId).toBeTruthy();
  expect(sim.state.ondemand.implement?.oncall?.attemptId).toBeTruthy();
  sim.dispatch({ type: 'RequestCancel', by: 'user' });
  expect(sim.state.workflow!.status).toBe('cancelled');
  const releases = sim.issued.filter(
    (e) => e.command.kind === 'runtime.release',
  );
  expect(releases.length).toBeGreaterThanOrEqual(3);
  expect(
    releases.every(
      (e) =>
        e.command.kind === 'runtime.release' &&
        e.command.args.removeWorkspace === false,
    ),
  ).toBe(true);
  expect(
    sim.issued.some((e) => e.command.kind === 'runtime.disposeWorkspace'),
  ).toBe(false);
  expect(sim.rejections).toEqual([]);
});

it('a soft stage budget holds queued PRs and top-up wakes the existing merge instance', () => {
  const sim = setup('implement', cooperativeWorld, true);
  agent(sim, 'a');
  agent(sim, 'b');
  Object.assign(sim.state.workItems.a!, {
    status: 'pr_open',
    pr: 11,
    headSha: 'abcdef2',
  });
  Object.assign(sim.state.workItems.b!, {
    status: 'pr_open',
    pr: 12,
    headSha: 'abcdef2',
  });
  sim.dispatch({
    type: 'QueueWorkItemForMerge',
    item: { itemKey: 'a', attemptId: 'a', pr: 11, headSha: 'abcdef2' },
  });
  const reviewer = sim.state.ondemand.implement!.merge!.attemptId!;
  sim.inject('budget.exceeded', {
    scope: 'stage',
    stageId: 'implement',
    stageAttempt: 1,
    metric: 'tokens',
    used: 100,
    budget: 100,
    threshold: 100,
    gateId: 'budget',
  });
  sim.dispatch({
    type: 'QueueWorkItemForMerge',
    item: { itemKey: 'b', attemptId: 'b', pr: 12, headSha: 'abcdef2' },
  });
  sim.inject('workitem.status', { itemKey: 'a', status: 'skipped' });
  expect(sim.state.ondemand.implement!.merge!.current).toBeUndefined();
  expect(sim.state.ondemand.implement!.merge!.queue).toEqual(['b']);
  choose(sim, 'budget', 'top-up', { additionalTokens: 100 });
  expect(sim.state.ondemand.implement!.merge!.current).toBe('b');
  expect(sim.state.ondemand.implement!.merge!.attemptId).toBe(reviewer);
  expect(sim.rejections).toEqual([]);
});

it('an accepted merge waits during pause and is issued exactly once on resume', () => {
  const sim = setup('implement', cooperativeWorld, true);
  agent(sim, 'a');
  Object.assign(sim.state.workItems.a!, {
    status: 'pr_open',
    pr: 11,
    headSha: 'abcdef2',
  });
  sim.dispatch({
    type: 'QueueWorkItemForMerge',
    item: { itemKey: 'a', attemptId: 'a', pr: 11, headSha: 'abcdef2' },
  });
  const reviewer = sim.state.ondemand.implement!.merge!.attemptId!;
  sim.dispatch({ type: 'PauseWorkflow', reason: 'scm_unhealthy' });
  sim.dispatch({
    type: 'AcceptSubmission',
    submissionId: 'merge-request',
    attemptId: reviewer,
    submission: {
      kind: 'merge-request',
      payload: { pr: 11, expectedHeadSha: 'abcdef2' },
    },
  });
  expect(
    sim.issued.filter((e) => e.command.kind === 'scm.mergePR'),
  ).toHaveLength(0);
  sim.dispatch({ type: 'ResumeWorkflow', reason: 'scm_unhealthy' });
  expect(
    sim.issued.filter((e) => e.command.kind === 'scm.mergePR'),
  ).toHaveLength(1);
  expect(sim.state.workItems.a!.status).toBe('merged');
  expect(sim.rejections).toEqual([]);
});

it.each(['meeting', 'planning'] as const)(
  '%s re-evaluates blocked spawns after health recovery and soft top-up',
  (kind) => {
    for (const pause of ['health', 'budget']) {
      const world = (
        e: Parameters<typeof cooperativeWorld>[0],
        sim: Simulator,
      ) => {
        if (
          e.command.kind === 'runtime.prepareWorkspace' ||
          (kind === 'planning' && e.command.kind === 'runtime.openSession')
        )
          return undefined;
        return cooperativeWorld(e, sim);
      };
      const sim = new Simulator({
        world,
        react: createReact({
          ...modules,
          stages: { ...modules.stages, [kind]: DEFAULT_MODULES.stages[kind] },
        }),
      });
      sim.dispatch(startWorkflow());
      const stageId = kind === 'meeting' ? 'meeting' : 'breakdown';
      if (kind === 'planning') {
        sim.state.stages.meeting!.status = 'done';
        sim.dispatch({ type: 'StartStage', stageId });
        if (pause === 'health')
          sim.dispatch({ type: 'PauseWorkflow', reason: 'runtime_unhealthy' });
        else
          sim.inject('budget.exceeded', {
            scope: 'workflow',
            metric: 'tokens',
            used: 100,
            budget: 100,
            threshold: 100,
          });
        const session = sim.issued.find(
          (e) => e.command.kind === 'runtime.openSession',
        )!;
        sim.inject('command.succeeded', {
          commandId: session.commandId,
          kind: 'runtime.openSession',
          result: { session: 'session-1' },
        });
      } else {
        if (pause === 'health')
          sim.dispatch({ type: 'PauseWorkflow', reason: 'runtime_unhealthy' });
        else
          sim.inject('budget.exceeded', {
            scope: 'stage',
            stageId,
            stageAttempt: 1,
            metric: 'tokens',
            used: 100,
            budget: 100,
            threshold: 100,
          });
        const workspace = sim.issued.find(
          (e) => e.command.kind === 'runtime.prepareWorkspace',
        )!;
        sim.inject(
          'command.succeeded',
          {
            commandId: workspace.commandId,
            kind: 'runtime.prepareWorkspace',
            result: { workspace: 'workspace', path: '/workspace' },
          },
          { stageId },
        );
      }
      expect(sim.eventsOf('seat.spawned')).toHaveLength(0);
      if (pause === 'health')
        sim.dispatch({ type: 'ResumeWorkflow', reason: 'runtime_unhealthy' });
      else
        choose(sim, Object.keys(sim.state.gates)[0]!, 'top-up', {
          additionalTokens: 100,
        });
      expect(sim.eventsOf('seat.spawned')).toHaveLength(1);
      expect(sim.rejections).toEqual([]);
    }
  },
);

it('failed reclamation offers another explicit choice and a later success clears the hijack guard', () => {
  let calls = 0;
  const sim = setup('implement', (e, s) =>
    e.command.kind === 'runtime.reclaimSession'
      ? { ok: true, result: { reclaimed: ++calls > 1 } }
      : cooperativeWorld(e, s),
  );
  sim.inject('runtime.identity_hijacked', {
    run: 'session-1',
    coordinatorHandle: 'other',
    consumerGeneration: 1,
  });
  choose(sim, Object.values(sim.state.gates)[0]!.gateId, 'reclaim');
  expect(calls).toBe(1);
  const retry = Object.values(sim.state.gates).find(
    (g) => g.status === 'open',
  )!;
  expect(retry).toBeTruthy();
  choose(sim, retry.gateId, 'reclaim');
  expect(calls).toBe(2);
  expect(sim.state.workflow!.pausedReasons).toEqual([]);
  const effects = [
    internal({ type: 'StartStage', meta: sim.meta(), stageId: 'implement' }),
  ];
  expect(
    filterPolicyEffects(
      context(sim, 'workflow.resumed', { reason: 'anomaly' }),
      effects,
    ),
  ).toEqual(effects);
  expect(sim.rejections).toEqual([]);
});

it('late usage never regresses a terminal work item to needs_attention', () => {
  const sim = setup();
  agent(sim, 'a');
  sim.state.workItems.a!.status = 'merged';
  sim.state.attempts.a!.state = 'exited';
  usage(sim, 'a', 800_000);
  expect(sim.state.workItems.a!.status).toBe('merged');
  expect(sim.rejections).toEqual([]);
});

it('the implementation scheduler retries a hard-limited item with its scoped top-up', () => {
  const sim = new Simulator({
    react: createReact({
      ...modules,
      stages: {
        ...modules.stages,
        implement: DEFAULT_MODULES.stages.implement,
      },
    }),
    world: (e, s) =>
      e.command.kind === 'scm.compareBranch'
        ? { ok: true, result: { ahead: 1, headSha: 'a'.repeat(40) } }
        : cooperativeWorld(e, s),
  });
  sim.dispatch(startWorkflow());
  sim.state.stages.meeting!.status = 'done';
  sim.state.stages.breakdown!.status = 'done';
  sim.state.workItems.A = {
    key: 'A',
    title: 'A',
    body: 'body',
    acceptance: ['works'],
    role: 'engineer',
    agent: 'codex',
    deps: [],
    status: 'approved',
    approvedGateId: 'tasks',
    attempt: 0,
    attemptIds: [],
    issue: 10,
  };
  sim.state.workItemOrder = ['A'];
  sim.dispatch({ type: 'StartStage', stageId: 'implement' });
  const old = sim.state.workItems.A!.currentAttemptId!;
  usage(sim, old, 800_000);
  const hard = Object.values(sim.state.gates).find(
    (g) =>
      g.kind === 'exception' && g.exceptionKind === 'item-budget-hard-limit',
  )!;
  choose(sim, hard.gateId, 'top-up-rerun', { additionalTokens: 100_000 });
  expect(sim.state.workItems.A!.attempt).toBe(2);
  expect(sim.state.workItems.A!.currentAttemptId).not.toBe(old);
  usage(sim, sim.state.workItems.A!.currentAttemptId!, 499_999);
  expect(sim.state.workItems.A!.status).toBe('in_progress');
  expect(sim.rejections).toEqual([]);
});

describe('duplicate compensation (S19, M3 §4.8)', () => {
  const repo = { owner: 'octo', name: 'demo' };
  const target = { type: 'pr' as const, repo, number: 4 };
  const seeded = () => {
    const sim = setup();
    sim.inject('command.issued', {
      commandId: 'wf/issue',
      kind: 'scm.createIssue',
      args: { repo, title: 'T', body: 'B', labels: ['ai-office:item'] },
    });
    sim.inject('command.succeeded', {
      commandId: 'wf/issue',
      kind: 'scm.createIssue',
      result: { issue: 7, url: 'https://github.com/octo/demo/issues/7' },
    });
    sim.inject('command.issued', {
      commandId: 'wf/pr',
      kind: 'scm.openPR',
      args: { repo, title: 'T', body: 'B', head: 'h', base: 'b' },
    });
    sim.inject('command.issued', {
      commandId: 'wf/comment',
      kind: 'scm.comment',
      args: { target, body: 'hi' },
    });
    return sim;
  };
  const compensations = (sim: Simulator) =>
    sim.issued
      .filter((i) => i.commandId.includes('/duplicate/'))
      .map((i) => ({ id: i.commandId, command: i.command }));

  it('closes extra issues and PRs and deletes extra comments, keeping the recorded copy, without pausing', () => {
    const sim = seeded();
    const duplicates: Omit<
      Extract<EvaluateAnomaly['observation'], { kind: 'duplicate' }>,
      'kind'
    >[] = [
      { objectKind: 'issue', commandId: 'wf/issue', numbers: [5, 7] },
      { objectKind: 'pr', commandId: 'wf/pr', numbers: [9, 8] },
      {
        objectKind: 'comment',
        commandId: 'wf/comment',
        commentIds: ['30', '12'],
      },
    ];
    for (const observation of duplicates)
      sim.dispatch({
        type: 'EvaluateAnomaly',
        observation: { kind: 'duplicate', ...observation },
      });
    const id = (...parts: (string | number)[]) =>
      [WORKFLOW_ID, 'duplicate', ...parts].join('/');
    expect(compensations(sim)).toEqual([
      {
        id: id('wf/issue', 'issue', 5),
        command: {
          kind: 'scm.updateIssue',
          args: { issue: { repo, number: 5 }, patch: { state: 'closed' } },
        },
      },
      {
        id: id('wf/issue', 'issue', 5, 'label'),
        command: {
          kind: 'scm.setLabels',
          args: {
            target: { type: 'issue', repo, number: 5 },
            labels: ['ai-office:item', 'ai-office:duplicate'],
          },
        },
      },
      {
        id: id('wf/pr', 'pr', 9),
        command: {
          kind: 'scm.updatePR',
          args: { pr: { repo, number: 9 }, patch: { state: 'closed' } },
        },
      },
      {
        id: id('wf/comment', 'comment', '30'),
        command: {
          kind: 'scm.deleteComment',
          args: { target, commentId: '30' },
        },
      },
    ]);
    expect(sim.state.workflow!.pausedReasons).toEqual([]);
    expect(Object.values(sim.state.gates)).toEqual([]);
    expect(sim.rejections).toEqual([]);
  });
  it('is idempotent on redelivery and ignores other runs', () => {
    const sim = seeded();
    const anomaly = {
      kind: 'duplicate-object' as const,
      severity: 'warning' as const,
      summary: 'dup',
      commandId: 'wf/issue',
      number: 5,
    };
    sim.inject('anomaly.detected', anomaly);
    sim.inject('anomaly.detected', anomaly);
    expect(compensations(sim)).toHaveLength(2);
    sim.inject('anomaly.detected', { ...anomaly, commandId: 'other-run/x' });
    sim.inject('anomaly.detected', {
      ...anomaly,
      commandId: 'wf/issue',
      number: undefined,
      commentId: '3',
    });
    expect(compensations(sim)).toHaveLength(2);
  });
});

describe('warning anomalies (SPEC rev2.15.3 §12.3)', () => {
  it('notify without an anomaly gate or pause; high ones still gate', () => {
    const sim = setup();
    for (const kind of [
      'integration-branch-moved',
      'unmanaged-close',
      'default-branch-moved',
    ] as const)
      sim.inject('anomaly.detected', {
        kind,
        severity: 'warning',
        summary: kind,
      });
    expect(Object.values(sim.state.gates)).toEqual([]);
    expect(sim.state.workflow!.pausedReasons).toEqual([]);
    sim.inject('anomaly.detected', {
      kind: 'merge-base-changed',
      severity: 'high',
      summary: 'retargeted',
    });
    expect(Object.values(sim.state.gates)).toHaveLength(1);
    expect(sim.state.workflow!.pausedReasons).toEqual(['anomaly']);
  });
});
