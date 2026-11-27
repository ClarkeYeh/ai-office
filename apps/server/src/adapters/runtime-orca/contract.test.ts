import { describe, expect, it } from 'vitest';
import { runtimePortContract } from '../../test-support/runtime-port-contract.js';
import { orcaReplayFixture } from '../../test-support/orca/contract-binding.js';

describe('runtime-orca synthetic replay (T1 wire shapes)', () => {
  runtimePortContract(() =>
    orcaReplayFixture({ tape: expect.getState().currentTestName! }),
  );
});
it('removes an unexpected suffixed worktree before returning a guard', async () => {
  const f = await orcaReplayFixture();
  try {
    f.world.suffix = true;
    await expect(
      f.runtime.prepareWorkspace(f.prepareRequest),
    ).rejects.toMatchObject({ category: 'guard', code: 'branch_suffixed' });
    expect(f.world.workspaces).toHaveLength(1);
    expect(f.world.branches.has(`${f.prepareRequest.branch}-2`)).toBe(false);
  } finally {
    await f.dispose?.();
  }
});

it('keeps 10 active workers within the CLI budget for 60 virtual minutes', async () => {
  const f = await orcaReplayFixture({ maxCallsPerMinute: 120 });
  try {
    for (let i = 0; i < 10; i++)
      await f.runtime.spawnAgent({
        ...f.spawnRequest,
        correlation: { workflowId: 'wf', commandId: `load-${i}` },
      });
    f.world.longPoll = true;
    f.world.calls.splice(0);
    let cursor = null as import('../../ports/refs.js').RuntimeCursor | null;
    for (let minute = 0; minute < 60; minute++) {
      const before = f.world.calls.length;
      for (let second = 0; second < 60; second++) {
        f.world.advance(1000);
        cursor = (await f.observer.observe(f.session, cursor)).cursor;
      }
      const calls = f.world.calls
        .slice(before)
        .filter((c) => c.argv[0] === 'orca');
      const count = (command: string) =>
        calls.filter((c) => c.argv.slice(1, 3).join(' ') === command).length;
      expect(calls.length).toBeLessThanOrEqual(120);
      expect(count('orchestration worker-list')).toBe(30);
      expect(count('orchestration worker-read')).toBeGreaterThanOrEqual(40);
      expect(count('orchestration worker-read')).toBeLessThanOrEqual(50);
      expect(count('orchestration check')).toBeLessThanOrEqual(3);
      expect(count('terminal list')).toBeLessThanOrEqual(2);
      expect(count('orchestration run-show')).toBeLessThanOrEqual(2);
    }
  } finally {
    await f.dispose?.();
  }
}, 60_000);

it('rejects drift inside a replay segment and unconsumed calls', async () => {
  const f = await orcaReplayFixture();
  try {
    f.world.loadTape({
      default: [
        {
          orcaVersion: '1.4.259',
          recordedAt: '2026-11-18T00:00:00Z',
          argv: [
            'orca',
            'orchestration',
            'worker-show',
            '--dispatch',
            'ctx_recorded',
            '--json',
          ],
          exitCode: 0,
          response: { ok: true, result: {} },
          stderrLines: [],
        },
      ],
    });
    const request = {
      bin: '/synthetic/orca',
      args: [
        'orchestration',
        'worker-show',
        '--dispatch',
        'ctx_recorded',
        '--json',
        '--unexpected',
      ],
      env: {},
      cwd: '/synthetic',
      timeoutMs: 1000,
    };
    await expect(f.world.run(request)).rejects.toThrow(
      'Replay command mismatch',
    );
    expect(() => f.world.assertConsumed()).toThrow('Unconsumed replay calls');
    await f.world.run({ ...request, args: request.args.slice(0, -1) });
    f.world.assertConsumed();
  } finally {
    await f.dispose?.();
  }
});

it('replays the recorded 1.4.272 repo list through the CLI: git repos only, one bulk call (v0.1.1)', async () => {
  const f = await orcaReplayFixture();
  try {
    f.world.origins.set(
      '/synthetic/home/workspace/ai-office-spike',
      'https://github.com/example-owner/ai-office-spike.git',
    );
    f.world.calls.splice(0);
    const repos = await f.runtime.listLocalRepos();
    expect(repos).toEqual([
      {
        path: '/synthetic/home/workspace/ai-office-spike',
        displayName: 'ai-office-spike',
        runtimeRepoId: '00000000-0000-4000-8000-0000000000a1',
        isGitMainWorktree: true,
        originUrl: 'https://github.com/example-owner/ai-office-spike.git',
      },
      {
        path: '/synthetic/home/workspace/example-app',
        displayName: 'example-app',
        runtimeRepoId: '00000000-0000-4000-8000-0000000000a2',
        isGitMainWorktree: true,
        originUrl: null,
      },
      {
        path: '/synthetic/home/workspace/scratch',
        displayName: 'scratch',
        runtimeRepoId: '00000000-0000-4000-8000-0000000000a3',
        isGitMainWorktree: true,
        originUrl: null,
      },
    ]);
    // Cached: a second page load within 30 s makes no Orca or git call.
    const before = f.world.calls.length;
    await f.runtime.listLocalRepos();
    expect(f.world.calls.length).toBe(before);
    const orca = f.world.calls.filter((c) => c.argv[0] === 'orca');
    expect(orca.map((c) => c.argv.slice(1))).toEqual([
      ['repo', 'list', '--json'],
    ]);
    // The folder workspace never reaches git.
    expect(
      f.world.calls.some((c) => c.argv.some((a) => a.includes('orca-home'))),
    ).toBe(false);
  } finally {
    await f.dispose?.();
  }
});
