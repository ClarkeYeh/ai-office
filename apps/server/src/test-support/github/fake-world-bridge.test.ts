import { expect, it, vi } from 'vitest';
import { createGithubWorldBridge } from './fake-world-bridge.js';
import { FakeRuntime } from '../../adapters/runtime-fake/index.js';
import { FakeScm } from '../../adapters/scm-fake/index.js';
import { FakeClock } from '../services.js';

const repo = { owner: 'ClarkeYeh', name: 'ai-office-spike' };
const runId = '123456abcdef';
const branch = `ai-office/t${runId}/feature`;
const correlation = (commandId: string) => ({ workflowId: 'wf', commandId });

it('serializes checkout writes, propagates failure, and recovers for subsequent pushes', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const push = vi
    .fn()
    .mockImplementationOnce(() => pending)
    .mockRejectedValueOnce(new Error('push failed'))
    .mockResolvedValue('b'.repeat(40));
  const bridge = createGithubWorldBridge({
    repo,
    runId,
    scm: { compareBranch: vi.fn().mockResolvedValue(null) },
    pusher: { push },
  });
  const request = { branch, base: 'a'.repeat(40) };
  const first = bridge.onPush(request);
  const second = bridge.onPush(request);
  const rejected = expect(second).rejects.toThrow('push failed');
  await Promise.resolve();
  expect(push).toHaveBeenCalledTimes(1);
  release();
  await first;
  await rejected;
  await bridge.onPush(request);
  expect(push).toHaveBeenCalledTimes(3);
  expect(() => bridge.onPush({ branch: 'main', base: request.base })).toThrow(
    'namespace',
  );
  expect(() => bridge.onPush({ branch })).toThrow('pinned base');
  expect(() =>
    createGithubWorldBridge({
      repo: { owner: 'other', name: 'repo' },
      runId,
      scm: bridge.scm,
      pusher: { push },
    }),
  ).toThrow('spike');
  expect(await bridge.remoteHead(branch)).toBeNull();
});

it('uses real SCM heads for repeated pushes and existing-branch rework', async () => {
  const scm = new FakeScm();
  scm.addRepo(repo);
  const integration = `ai-office/t${runId}-integration`;
  await scm.ensureBranch(repo, integration, 'main', correlation('integration'));
  const initial = (await scm.compareBranch(repo, integration, integration))!
    .headSha;
  const push = vi.fn(
    async ({ branch: target, base }: { branch: string; base: string }) =>
      scm.pushBranch(repo, target, base),
  );
  const bridge = createGithubWorldBridge({
    scm,
    repo,
    runId,
    pusher: { push },
  });
  const clock = new FakeClock();
  const runtime = new FakeRuntime({
    clock,
    ...bridge,
    scenario: {
      roles: {
        worker: {
          spawn: [
            { type: 'push', branch: 'illustrative', headSha: 'f'.repeat(40) },
            { type: 'push', branch: 'illustrative', headSha: 'f'.repeat(40) },
          ],
        },
      },
    },
  });
  const localRepo = { localPath: '/synthetic', orcaRepoId: 'synthetic' };
  const session = await runtime.openSession({
    repo: localRepo,
    workflowId: 'wf',
    objective: 'test',
    correlation: correlation('session'),
  });
  const request = {
    repo: localRepo,
    session,
    baseBranch: initial,
    baseSha: initial,
    fetchBranch: integration,
    branch,
    name: 'worker',
    correlation: correlation('prepare'),
  };
  const workspace = await runtime.prepareWorkspace(request);
  await runtime.spawnAgent({
    session,
    agent: 'codex',
    title: 'worker',
    prompt: 'synthetic',
    keepOpen: true,
    workspace: {
      kind: 'existing-worktree',
      workspace: workspace.workspace,
      readOnly: false,
    },
    correlation: correlation('spawn'),
  });
  await runtime.runDue();
  const head = await bridge.remoteHead(branch);
  expect(head).not.toBe('f'.repeat(40));
  expect(push.mock.calls[0]![0].base).toBe(initial);
  expect(push.mock.calls[1]![0].base).not.toBe(initial);
  await runtime.disposeWorkspace(workspace.workspace);
  const rework = await runtime.prepareWorkspace({
    ...request,
    baseBranch: head!,
    baseSha: head!,
    fetchBranch: branch,
    checkoutExisting: true,
    name: 'rework',
    correlation: correlation('rework'),
  });
  expect(rework.baseSha).toBe(head);
});
