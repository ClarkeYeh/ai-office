import { describe, expect, test } from 'vitest';
import type {
  CommandResult,
  ExternalCommand,
} from '@ai-office/contracts/events';
import {
  cleanupResource,
  collectCleanup,
  unresolvedSpawnWorkspaces,
} from './cleanup.js';
import { initialState } from './state/index.js';
import {
  Harness,
  SHORT_ID,
  eventDraft,
  meta,
  startCommand,
} from './test-support/fixtures.js';

const repo = { owner: 'octo', name: 'demo' };
const runtimeRepo = { orcaRepoId: 'orca-repo-1', localPath: '/repos/demo' };
const branch = (name: string) => `ai-office/${SHORT_ID}/${name}`;

const issue = (h: Harness, commandId: string, command: ExternalCommand) =>
  h.given(
    eventDraft('command.issued', {
      commandId,
      ...command,
    } as never),
  );
const succeed = (h: Harness, commandId: string, result: CommandResult) =>
  h.given(eventDraft('command.succeeded', { commandId, ...result } as never));
const prepare = (h: Harness, id: string, name: string, workspace: string) => {
  issue(h, id, {
    kind: 'runtime.prepareWorkspace',
    args: {
      session: 's',
      repo: runtimeRepo,
      baseBranch: 'main',
      name,
      branch: branch(name),
    },
  });
  succeed(h, id, {
    kind: 'runtime.prepareWorkspace',
    result: { workspace, path: `/w/${name}` },
  });
};
const spawn = (
  h: Harness,
  id: string,
  name: string,
  workspace?: string,
  result = true,
) => {
  issue(h, id, {
    kind: 'runtime.spawnAgent',
    args: {
      session: 's',
      agent: 'claude-code',
      title: name,
      specPath: `/specs/${name}`,
      specSha256: 'a'.repeat(64),
      workspace: {
        kind: 'new-worktree',
        baseBranch: 'main',
        name,
        branch: branch(name),
      },
      keepOpen: false,
    },
  });
  if (result)
    succeed(h, id, {
      kind: 'runtime.spawnAgent',
      result:
        workspace === undefined
          ? { agent: `agent-${name}` }
          : { agent: `agent-${name}`, workspace },
    });
};
const started = () => new Harness().given(startCommand());
const summary = (h: Harness, resolved?: Map<string, string>) =>
  collectCleanup(h.state, resolved).map(
    ({ resource, command }) => `${resource.join(' ')} ${command.kind}`,
  );

describe('collectCleanup (M5 §4.2)', () => {
  test('nothing before the workflow starts', () => {
    expect(collectCleanup(initialState())).toEqual([]);
    expect(unresolvedSpawnWorkspaces(initialState())).toEqual([]);
  });

  test('prepared and spawned worktrees, then their branches and work item branches', () => {
    const h = started();
    prepare(h, 'wf-1/prep/a', 'a', 'ws-a');
    spawn(h, 'wf-1/spawn/lead', 'planning', 'ws-lead');
    // A failed prepare and an unanswered spawn leave nothing to clean.
    issue(h, 'wf-1/prep/x', {
      kind: 'runtime.prepareWorkspace',
      args: {
        session: 's',
        repo: runtimeRepo,
        baseBranch: 'main',
        name: 'x',
        branch: branch('x'),
      },
    });
    spawn(h, 'wf-1/spawn/hung', 'hung', undefined, false);
    // Existing-worktree spawns reuse a prepared worktree.
    issue(h, 'wf-1/spawn/reviewer', {
      kind: 'runtime.spawnAgent',
      args: {
        session: 's',
        agent: 'codex',
        title: 'reviewer',
        specPath: '/specs/r',
        specSha256: 'a'.repeat(64),
        workspace: {
          kind: 'existing-worktree',
          workspace: 'ws-a',
          readOnly: true,
        },
        keepOpen: false,
      },
    });
    succeed(h, 'wf-1/spawn/reviewer', {
      kind: 'runtime.spawnAgent',
      result: { agent: 'agent-r', workspace: 'ws-a' },
    });
    h.state = {
      ...h.state,
      workItems: {
        a: { branch: branch('a') } as never,
        b: { branch: branch('b') } as never,
        c: {} as never,
      },
    };
    expect(summary(h)).toEqual([
      'workspace ws-a runtime.disposeWorkspace',
      'workspace ws-lead runtime.disposeWorkspace',
      `branch ${branch('a')} scm.deleteBranch`,
      `branch ${branch('planning')} scm.deleteBranch`,
      `branch ${branch('b')} scm.deleteBranch`,
    ]);
    expect(collectCleanup(h.state)[2]!.command).toEqual({
      kind: 'scm.deleteBranch',
      args: { repo, name: branch('a') },
    });
    expect(unresolvedSpawnWorkspaces(h.state)).toEqual([]);
  });

  test('older spawn results without workspace are unresolved unless supplied', () => {
    const h = started();
    spawn(h, 'wf-1/spawn/lead', 'planning');
    expect(unresolvedSpawnWorkspaces(h.state)).toEqual([
      { commandId: 'wf-1/spawn/lead', name: 'planning' },
    ]);
    expect(summary(h)).toEqual([
      `branch ${branch('planning')} scm.deleteBranch`,
    ]);
    expect(summary(h, new Map([['wf-1/spawn/lead', 'ws-found']]))).toEqual([
      'workspace ws-found runtime.disposeWorkspace',
      `branch ${branch('planning')} scm.deleteBranch`,
    ]);
  });

  test('never the integration, default or a foreign branch', () => {
    const h = started();
    const workflow = h.state.workflow!;
    h.state = {
      ...h.state,
      workItems: {
        a: { branch: workflow.integrationBranch } as never,
        b: { branch: 'main' } as never,
        c: { branch: 'ai-office/other/x' } as never,
        d: { branch: `ai-office/${SHORT_ID}-slug` } as never,
      },
    };
    expect(collectCleanup(h.state)).toEqual([]);
  });
});

describe('cleanupResource and cleanup-failed (M5 §4.2)', () => {
  const failed = (h: Harness, commandId: string, code = 'workspace_unpushed') =>
    h.given(
      eventDraft('command.failed', {
        commandId,
        kind: h.state.commands[commandId]!.issued.kind,
        error: { category: 'guard', code, message: 'm', retryable: false },
        attempts: 1,
      }),
    );
  const evaluate = (h: Harness, commandId: string) => {
    const result = h.run({
      type: 'EvaluateAnomaly',
      meta: meta(40),
      observation: { kind: 'cleanup-failed', commandId },
    });
    expect(result.ok).toBe(true);
    return result.ok ? result.events : [];
  };
  const completed = () => {
    const h = started();
    h.state = {
      ...h.state,
      workflow: { ...h.state.workflow!, status: 'completed' },
    };
    issue(h, 'wf-1/cleanup/workspace/ws-a', {
      kind: 'runtime.disposeWorkspace',
      args: { workspace: 'ws-a' },
    });
    issue(h, 'wf-1/cleanup/branch/b', {
      kind: 'scm.deleteBranch',
      args: { repo, name: branch('b') },
    });
    issue(h, 'wf-1/other', {
      kind: 'scm.ensureBranch',
      args: { repo, name: branch('c'), from: 'main' },
    });
    return h;
  };

  test('reads the resource from the issued args', () => {
    const h = completed();
    expect(cleanupResource(h.state, 'wf-1/cleanup/workspace/ws-a')).toEqual([
      'workspace',
      'ws-a',
    ]);
    expect(cleanupResource(h.state, 'wf-1/cleanup/branch/b')).toEqual([
      'branch',
      branch('b'),
    ]);
    expect(cleanupResource(h.state, 'wf-1/other')).toBeUndefined();
    expect(cleanupResource(h.state, 'nope')).toBeUndefined();
  });

  test('one warning per failed command after the workflow ended, never a pause', () => {
    const h = completed();
    // Not failed (yet), unknown, or not a cleanup command: nothing.
    expect(evaluate(h, 'wf-1/cleanup/workspace/ws-a')).toEqual([]);
    expect(evaluate(h, 'nope')).toEqual([]);
    failed(h, 'wf-1/other');
    expect(evaluate(h, 'wf-1/other')).toEqual([]);
    failed(h, 'wf-1/cleanup/workspace/ws-a');
    const events = evaluate(h, 'wf-1/cleanup/workspace/ws-a');
    expect(events).toEqual([
      expect.objectContaining({
        type: 'anomaly.detected',
        payload: {
          kind: 'cleanup-failed',
          severity: 'warning',
          summary: 'Cleanup left workspace ws-a (workspace_unpushed)',
          commandId: 'wf-1/cleanup/workspace/ws-a',
        },
      }),
    ]);
    expect(evaluate(h, 'wf-1/cleanup/workspace/ws-a')).toEqual([]);
    failed(h, 'wf-1/cleanup/branch/b', 'branch_delete_guard');
    expect(evaluate(h, 'wf-1/cleanup/branch/b')[0]?.payload).toMatchObject({
      summary: `Cleanup left branch ${branch('b')} (branch_delete_guard)`,
    });
    expect(h.state.workflow!.pausedReasons).toEqual([]);
    expect(h.state.anomalies.map((a) => a.kind)).toEqual([
      'cleanup-failed',
      'cleanup-failed',
    ]);
  });

  test('also while running, still without pausing', () => {
    const h = started();
    issue(h, 'wf-1/dispose', {
      kind: 'runtime.disposeWorkspace',
      args: { workspace: 'ws-a' },
    });
    failed(h, 'wf-1/dispose');
    expect(evaluate(h, 'wf-1/dispose').map((e) => e.type)).toEqual([
      'anomaly.detected',
    ]);
  });

  test('rejected before the workflow starts', () => {
    const result = new Harness().run({
      type: 'EvaluateAnomaly',
      meta: meta(40),
      observation: { kind: 'cleanup-failed', commandId: 'x' },
    });
    expect(result.ok).toBe(false);
  });
});
