import { describe, expect, it, vi } from 'vitest';
import type { ExternalCommand } from '@ai-office/contracts/events';
import type { RuntimePort } from '../../ports/runtime.js';
import type { ScmPort } from '../../ports/scm.js';
import type { SpecStore } from '../../ports/stores.js';
import { portHandlers } from './executor.js';

type SpawnArgs = Extract<
  ExternalCommand,
  { kind: 'runtime.spawnAgent' }
>['args'];

const args = (workspace: SpawnArgs['workspace']): SpawnArgs => ({
  session: 'session-1',
  agent: 'claude-code',
  title: 'lead',
  specPath: '/specs/lead.md',
  specSha256: 'a'.repeat(64),
  workspace,
  keepOpen: true,
});
const newWorktree: SpawnArgs['workspace'] = {
  kind: 'new-worktree',
  baseBranch: 'main',
  name: 'planning',
  branch: 'ai-office/ab12/planning',
};
const spawn = (
  runtime: Partial<RuntimePort>,
  workspace: SpawnArgs['workspace'] = newWorktree,
) =>
  portHandlers({
    runtime: { spawnAgent: vi.fn(async () => 'agent-1'), ...runtime } as never,
    scm: {} as ScmPort,
    specStore: { verify: () => true } as unknown as SpecStore,
  })['runtime.spawnAgent']!(args(workspace), {
    issued: {
      workflowId: 'wf-1',
      commandId: 'wf-1/spawn/lead',
      command: { kind: 'runtime.spawnAgent', args: args(workspace) },
    },
    correlation: { workflowId: 'wf-1', commandId: 'wf-1/spawn/lead' },
  });

describe('runtime.spawnAgent result workspace (M5 §4.2)', () => {
  it('records the worktree a new-worktree spawn created', async () => {
    const spawnedWorkspace = vi.fn(() => 'ws-lead' as never);
    expect(await spawn({ spawnedWorkspace })).toEqual({
      agent: 'agent-1',
      workspace: 'ws-lead',
    });
    expect(spawnedWorkspace).toHaveBeenCalledWith('wf-1/spawn/lead');
  });

  it('omits it when the adapter has none or does not report it', async () => {
    expect(await spawn({ spawnedWorkspace: () => undefined })).toEqual({
      agent: 'agent-1',
    });
    expect(await spawn({})).toEqual({ agent: 'agent-1' });
  });

  it('never for an existing worktree, which its prepareWorkspace owns', async () => {
    const spawnedWorkspace = vi.fn(() => 'ws-a' as never);
    expect(
      await spawn(
        { spawnedWorkspace },
        { kind: 'existing-worktree', workspace: 'ws-a', readOnly: true },
      ),
    ).toEqual({ agent: 'agent-1' });
    expect(spawnedWorkspace).not.toHaveBeenCalled();
  });
});
