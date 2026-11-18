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
