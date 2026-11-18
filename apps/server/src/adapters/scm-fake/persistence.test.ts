import { expect, it, vi } from 'vitest';
import { FakeClock } from '../../test-support/services.js';
import { createFakeScm } from './index.js';

it.each([false, true])(
  'restores owner merge deadlines and revision guards (edited=%s)',
  async (edited) => {
    vi.useFakeTimers();
    try {
      const clock = new FakeClock();
      const repo = { owner: 'fake', name: 'repo' };
      const correlation = { workflowId: 'wf', commandId: 'pr' };
      const original = createFakeScm({
        clock,
        autoMergeIntoDefaultBranchAfterMs: 1000,
      });
      original.addRepo(repo);
      original.pushBranch(repo, 'work', 'main');
      const pr = await original.openPR(
        repo,
        { title: 'Final', body: 'Synthetic', head: 'work', base: 'main' },
        correlation,
      );
      if (edited)
        await original.comment(pr, 'revise', {
          ...correlation,
          commandId: 'comment',
        });
      const before = await original.poll(repo, null);
      clock.advance(750);
      const restored = createFakeScm({ clock });
      restored.restore(JSON.parse(JSON.stringify(original.snapshot())));
      expect(await restored.poll(repo, before.cursor)).toEqual({
        events: [],
        cursor: before.cursor,
      });
      expect(restored.inspectObject(pr)).toEqual(original.inspectObject(pr));
      await vi.advanceTimersByTimeAsync(249);
      expect((await restored.getPR(pr)).state).toBe('open');
      await vi.advanceTimersByTimeAsync(1);
      expect((await restored.getPR(pr)).state).toBe(edited ? 'open' : 'merged');
      expect(restored.snapshot().ownerMerges).toEqual([]);
      // The configured timer also survives for PRs opened after restoration.
      const next = await restored.openPR(
        repo,
        { title: 'Next', body: '', head: 'work', base: 'main' },
        { ...correlation, commandId: 'next' },
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect((await restored.getPR(next)).state).toBe('merged');
      expect(await restored.findByMarker(repo, 'pr')).toEqual(
        await original.findByMarker(repo, 'pr'),
      );
    } finally {
      vi.useRealTimers();
    }
  },
);
