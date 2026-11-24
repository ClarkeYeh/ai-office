import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '@ai-office/contracts/events';
import { evolve, initialState } from '@ai-office/domain';
import type { WorkflowState } from '@ai-office/domain';
import { createReact, DEFAULT_MODULES } from '../react.js';
import type { React } from '../react.js';
import { cooperativeWorld, Simulator } from '../test-support/simulator.js';
import type { World, WorldReply } from '../test-support/simulator.js';
import { startWorkflow, WORKFLOW_ID } from '../test-support/fixtures.js';
import { retentionPolicy } from './retention.js';

type Retention = 'delete-on-complete' | 'keep' | undefined;

const empty = { react: () => [] };
const retentionOnly: React = createReact({
  stages: {
    meeting: empty,
    planning: empty,
    implement: empty,
    ondemand: empty,
    integrate: empty,
    'final-pr': empty,
  },
  policies: [retentionPolicy],
});
const runtimeRepo = { orcaRepoId: 'orca-repo-1', localPath: '/repos/demo' };
const repo = { owner: 'octo', name: 'demo' };

/** A finished workflow: one prepared worker worktree and a new-worktree lead. */
const finished = (
  retention: Retention,
  world: World = cooperativeWorld,
  options: { leadWorkspace?: boolean; complete?: boolean } = {},
) => {
  const sim = new Simulator({ world, react: retentionOnly });
  const start = startWorkflow();
  if (retention !== undefined) start.limits.workerBranchRetention = retention;
  sim.dispatch(start);
  sim.inject('command.issued', {
    commandId: `${WORKFLOW_ID}/prep/a`,
    kind: 'runtime.prepareWorkspace',
    args: {
      session: 'session-1',
      repo: runtimeRepo,
      baseBranch: 'main',
      name: 'a',
      branch: 'ai-office/ab12/a',
    },
  });
  sim.inject('command.succeeded', {
    commandId: `${WORKFLOW_ID}/prep/a`,
    kind: 'runtime.prepareWorkspace',
    result: { workspace: 'ws-a', path: '/w/a' },
  });
  sim.inject('command.issued', {
    commandId: `${WORKFLOW_ID}/spawn/lead`,
    orcaRequestId: '00000000-0000-5000-8000-000000000001',
    kind: 'runtime.spawnAgent',
    args: {
      session: 'session-1',
      agent: 'claude-code',
      title: 'lead',
      specPath: '/specs/lead',
      specSha256: 'a'.repeat(64),
      workspace: {
        kind: 'new-worktree',
        baseBranch: 'main',
        name: 'planning',
        branch: 'ai-office/ab12/planning',
      },
      keepOpen: true,
    },
  });
  sim.inject('command.succeeded', {
    commandId: `${WORKFLOW_ID}/spawn/lead`,
    kind: 'runtime.spawnAgent',
    result:
      options.leadWorkspace === false
        ? { agent: 'agent-lead' }
        : { agent: 'agent-lead', workspace: 'ws-lead' },
  });
  if (options.complete !== false)
    sim.inject('workflow.completed', { finalPr: 7, mergeCommitSha: 'abcdef1' });
  return sim;
};
const cleanupIds = (sim: Simulator) =>
  sim.issued
    .map((c) => c.commandId)
    .filter((id) => id.startsWith(`${WORKFLOW_ID}/cleanup/`));
const replayed = (events: DomainEvent[]): WorkflowState =>
  events.reduce(evolve, initialState());
/** Every external effect engine derives when it reacts to `events` again. */
const rederived = (events: DomainEvent[]) => {
  let before = initialState();
  const ids: string[] = [];
  for (const event of events) {
    for (const effect of retentionOnly(before, event))
      if (effect.kind === 'external') ids.push(effect.commandId);
    before = evolve(before, event);
  }
  return ids;
};

describe('retention policy (M5 §4.2)', () => {
  it('golden: delete-on-complete disposes each worktree, then deletes the workflow branches', () => {
    const sim = finished('delete-on-complete');
    expect(
      sim.issued
        .filter((c) => c.commandId.includes('/cleanup/'))
        .map((c) => [c.commandId, c.command]),
    ).toEqual([
      [
        'wf-1/cleanup/workspace/ws-a',
        { kind: 'runtime.disposeWorkspace', args: { workspace: 'ws-a' } },
      ],
      [
        'wf-1/cleanup/workspace/ws-lead',
        { kind: 'runtime.disposeWorkspace', args: { workspace: 'ws-lead' } },
      ],
      [
        'wf-1/cleanup/branch/ai-office/ab12/a',
        { kind: 'scm.deleteBranch', args: { repo, name: 'ai-office/ab12/a' } },
      ],
      [
        'wf-1/cleanup/branch/ai-office/ab12/planning',
        {
          kind: 'scm.deleteBranch',
          args: { repo, name: 'ai-office/ab12/planning' },
        },
      ],
    ]);
    const issued = sim
      .eventsOf('command.issued')
      .filter((e) => e.payload.commandId.includes('/cleanup/'));
    expect(issued.every((e) => e.stageId === undefined)).toBe(true);
    expect(
      Object.values(sim.state.commands)
        .filter((c) => c.id.includes('/cleanup/'))
        .map((c) => c.status),
    ).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded']);
    expect(sim.rejections).toEqual([]);
    expect(sim.warnings).toEqual([]);
  });

  it.each<[string, Retention]>([
    ['keep', 'keep'],
    ['older events without the snapshot', undefined],
  ])('%s: no cleanup', (_, retention) => {
    const sim = finished(retention);
    expect(cleanupIds(sim)).toEqual([]);
    expect(
      rederived(sim.events).filter((id) => id.includes('/cleanup/')),
    ).toEqual([]);
  });

  it('skips spawns recorded without workspace (left to POST /cleanup)', () => {
    const sim = finished('delete-on-complete', cooperativeWorld, {
      leadWorkspace: false,
    });
    expect(cleanupIds(sim)).toEqual([
      'wf-1/cleanup/workspace/ws-a',
      'wf-1/cleanup/branch/ai-office/ab12/a',
      'wf-1/cleanup/branch/ai-office/ab12/planning',
    ]);
  });

  it('react reruns derive the same ids and skip the ones already issued', () => {
    const sim = finished('delete-on-complete');
    const index = sim.events.findIndex((e) => e.type === 'workflow.completed');
    const completed = sim.events[index]!;
    const before = replayed(sim.events.slice(0, index));
    const first = retentionOnly(before, completed);
    expect(retentionOnly(before, completed)).toEqual(first);
    expect(first.map((e) => e.kind === 'external' && e.commandId)).toEqual(
      cleanupIds(sim),
    );
    // Partway through issuing: only what is still missing.
    const partial = replayed(
      sim.events.slice(
        0,
        sim.events.findIndex(
          (e) =>
            e.type === 'command.issued' &&
            e.payload.commandId === 'wf-1/cleanup/workspace/ws-lead',
        ) + 1,
      ),
    );
    const again = retentionOnly(
      { ...before, commands: partial.commands },
      completed,
    );
    expect(again.map((e) => e.kind === 'external' && e.commandId)).toEqual([
      'wf-1/cleanup/branch/ai-office/ab12/a',
      'wf-1/cleanup/branch/ai-office/ab12/planning',
    ]);
    // Redelivering an event already applied yields nothing.
    expect(retentionOnly(sim.state, completed)).toEqual([]);
  });

  it('a restart after completion neither re-issues nor misses cleanup', () => {
    const sim = finished('delete-on-complete');
    const state = replayed(sim.events);
    // Restart from scratch: everything re-derived was already issued.
    const ids = rederived(sim.events);
    expect(ids.filter((id) => id.includes('/cleanup/'))).toEqual(
      cleanupIds(sim),
    );
    expect(ids.every((id) => Object.hasOwn(state.commands, id))).toBe(true);
    // Crash right after workflow.completed was stored: nothing is skipped.
    const index = sim.events.findIndex((e) => e.type === 'workflow.completed');
    const crashed = sim.events.slice(0, index + 1);
    const missing = rederived(crashed).filter(
      (id) => !Object.hasOwn(replayed(crashed).commands, id),
    );
    expect(missing).toEqual(cleanupIds(sim));
  });

  it('a failed cleanup command becomes one cleanup-failed warning without pausing', () => {
    const refusal = (code: string): WorldReply => ({
      ok: false,
      error: { category: 'guard', code, message: 'Refused', retryable: false },
    });
    // T2's surfaced failures: the unpushed guard and a separate branch delete.
    const refuse: World = (issued, sim) =>
      issued.command.kind === 'runtime.disposeWorkspace' &&
      issued.command.args.workspace === 'ws-lead'
        ? refusal('workspace_unpushed')
        : issued.command.kind === 'scm.deleteBranch' &&
            issued.command.args.name === 'ai-office/ab12/a'
          ? refusal('branch_delete_guard')
          : cooperativeWorld(issued, sim);
    const sim = finished('delete-on-complete', refuse);
    expect(sim.eventsOf('anomaly.detected').map((e) => e.payload)).toEqual([
      {
        kind: 'cleanup-failed',
        severity: 'warning',
        summary: 'Cleanup left workspace ws-lead (workspace_unpushed)',
        commandId: 'wf-1/cleanup/workspace/ws-lead',
      },
      {
        kind: 'cleanup-failed',
        severity: 'warning',
        summary: 'Cleanup left branch ai-office/ab12/a (branch_delete_guard)',
        commandId: 'wf-1/cleanup/branch/ai-office/ab12/a',
      },
    ]);
    expect(sim.eventsOf('workflow.paused')).toEqual([]);
    expect(sim.state.workflow?.status).toBe('completed');
    // The other cleanup commands still ran.
    expect(cleanupIds(sim)).toHaveLength(4);
  });

  it('ignores failures while running and of other command kinds', () => {
    const fail: World = (issued, sim) =>
      issued.command.kind === 'runtime.disposeWorkspace' ||
      issued.command.kind === 'scm.ensureBranch'
        ? {
            ok: false,
            error: {
              category: 'guard',
              code: 'workspace_dirty',
              message: 'Dirty',
              retryable: false,
            },
          }
        : cooperativeWorld(issued, sim);
    const sim = finished('delete-on-complete', fail, { complete: false });
    // ensure-branch (lifecycle) failed; a stage's own dispose failing while running:
    sim.inject('command.issued', {
      commandId: `${WORKFLOW_ID}/meeting/dispose`,
      kind: 'runtime.disposeWorkspace',
      args: { workspace: 'ws-a' },
    });
    sim.inject('command.failed', {
      commandId: `${WORKFLOW_ID}/meeting/dispose`,
      kind: 'runtime.disposeWorkspace',
      error: {
        category: 'guard',
        code: 'workspace_dirty',
        message: 'Dirty',
        retryable: false,
      },
      attempts: 1,
    });
    expect(sim.eventsOf('command.failed').length).toBeGreaterThan(1);
    expect(sim.eventsOf('anomaly.detected')).toEqual([]);
  });

  it('is part of the default policies and inert before a workflow exists', () => {
    expect(DEFAULT_MODULES.policies).toContain(retentionPolicy);
    const sim = finished('delete-on-complete');
    const event = sim.eventsOf('workflow.completed')[0]!;
    const state = initialState();
    expect(
      retentionPolicy({ workflowId: WORKFLOW_ID, event, before: state, state }),
    ).toEqual([]);
  });
});
