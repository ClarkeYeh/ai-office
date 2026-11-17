import { describe, expect, it, vi } from 'vitest';
import { scmPortContract } from '../../test-support/scm-port-contract.js';
import { FakeClock } from '../../test-support/services.js';
import { FakeScm } from './index.js';
const repo = { owner: 'owner', name: 'repo' };
const c = { workflowId: 'workflow', commandId: 'command' };
scmPortContract(() => {
  const scm = new FakeScm();
  scm.addRepo(repo);
  return {
    scm,
    repo,
    defaultBranch: 'main',
    pushBranch: async (branch) => scm.pushBranch(repo, branch),
    editBody: (issue, body) => scm.editIssueBody(issue, body),
  };
});
async function setup(scm = new FakeScm()) {
  scm.addRepo(repo);
  await scm.ensureBranch(repo, 'ai-office/integration', 'main', c);
  await scm.ensureBranch(repo, 'ai-office/worker', 'main', c);
  const sha = scm.pushBranch(repo, 'ai-office/worker');
  const pr = await scm.openPR(
    repo,
    {
      title: 'Work',
      body: '',
      base: 'ai-office/integration',
      head: 'ai-office/worker',
    },
    c,
  );
  return { scm, sha, pr };
}
describe('FakeScm scenarios', () => {
  it('models repo metadata, labels, updates, reviews and defensive snapshots', async () => {
    const clock = new FakeClock(),
      scm = new FakeScm({ clock });
    scm.addRepo(repo, {
      defaultBranch: 'trunk',
      visibility: 'private',
      defaultBranchProtected: 'unknown',
    });
    expect(await scm.inspectRepo(repo)).toMatchObject({
      defaultBranch: 'trunk',
      visibility: 'private',
      defaultBranchProtected: 'unknown',
    });
    expect(await scm.health()).toMatchObject({
      available: true,
      viewerLogin: 'owner',
    });
    await scm.ensureLabels(repo, [{ name: 'pending', color: 'ffffff' }]);
    const issue = await scm.createIssue(
      repo,
      { title: 'Old', body: 'body', labels: [] },
      c,
    );
    clock.advance(1000);
    await scm.updateIssue(issue, { title: 'New', state: 'closed' });
    await scm.setLabels(issue, ['pending', 'pending']);
    await scm.comment(issue, 'Once', c);
    await scm.comment(issue, 'Once', c);
    const snapshot = scm.inspectObject(issue);
    expect(snapshot).toMatchObject({
      title: 'New',
      state: 'closed',
      labels: ['pending'],
      updatedAt: clock.now().toISOString(),
    });
    expect(snapshot.comments).toHaveLength(1);
    snapshot.labels.push('not persisted');
    expect((await scm.getIssue(issue)).labels).toEqual(['pending']);
    await expect(scm.getIssue({ repo, number: 999 })).rejects.toMatchObject({
      code: 'object_not_found',
    });
  });
  it('exposes unmarked creation, external merges and default branch advancement', async () => {
    const { scm } = await setup();
    const cursor = (await scm.poll(repo, null)).cursor;
    const issue = await scm.createExternalIssue(repo, {
      title: 'Manual',
      body: '',
      labels: [],
    });
    expect((await scm.poll(repo, cursor)).events).toContainEqual(
      expect.objectContaining({
        type: 'repo.object_created',
        ref: issue,
        hasMarker: false,
      }),
    );
    const pr = await scm.openPR(
      repo,
      { title: 'Final', body: '', head: 'ai-office/integration', base: 'main' },
      { ...c, commandId: 'final' },
    );
    const before = await scm.compareBranch(repo, 'main', 'main');
    await scm.mergeExternally(pr, 'human');
    expect((await scm.compareBranch(repo, 'main', 'main'))?.headSha).not.toBe(
      before?.headSha,
    );
    expect((await scm.poll(repo, cursor)).events).toContainEqual(
      expect.objectContaining({
        type: 'pr.state',
        state: 'merged',
        mergedBy: 'human',
      }),
    );
    const pushed = scm.pushBranch(repo, 'main');
    expect((await scm.compareBranch(repo, 'main', 'main'))?.headSha).toBe(
      pushed,
    );
    await scm.addExternalComment(issue, 'Manual comment');
    expect(scm.inspectObject(issue).comments).toEqual(['Manual comment']);
  });
  it('handles PR checks, conflicts, closing and review comments', async () => {
    const { scm, pr, sha } = await setup();
    const opts = { method: 'merge' as const, expectedHeadSha: sha };
    scm.setChecks(pr, 'pending');
    await expect(scm.mergePR(pr, opts)).rejects.toMatchObject({
      code: 'pr_not_mergeable',
    });
    scm.setChecks(pr, 'success');
    scm.setMergeable(pr, false);
    await expect(scm.mergePR(pr, opts)).rejects.toMatchObject({
      code: 'pr_not_mergeable',
    });
    scm.setMergeable(pr, true);
    await scm.updatePR(pr, {
      title: 'Updated',
      body: 'Changed',
      state: 'closed',
    });
    await expect(scm.mergePR(pr, opts)).rejects.toMatchObject({
      code: 'pr_not_mergeable',
    });
    await scm.updatePR(pr, { state: 'open' });
    scm.addReviewComment(pr, {
      id: 'review',
      author: 'reviewer',
      body: 'Fix',
      path: 'index.ts',
      line: 1,
      occurredAt: '2026-01-01T00:00:00Z',
    });
    expect(await scm.listReviewComments(pr)).toHaveLength(1);
    const merged = await scm.mergePR(pr, opts);
    expect(await scm.mergePR(pr, opts)).toEqual(merged);
    expect(
      (
        await scm.compareBranch(
          repo,
          'ai-office/integration',
          'ai-office/worker',
        )
      )?.ahead,
    ).toBe(0);
  });
  it('compares a branch against a pinned commit SHA, as GitHub does', async () => {
    const scm = new FakeScm();
    const repo = { owner: 'o', name: 'r' };
    scm.addRepo(repo);
    const base = (await scm.compareBranch(repo, 'main', 'main'))!.headSha;
    await scm.ensureBranch(repo, 'ai-office/worker', base, {
      workflowId: 'wf',
      commandId: 'c',
    });
    const head = scm.pushBranch(repo, 'ai-office/worker');
    expect(await scm.compareBranch(repo, base, 'ai-office/worker')).toEqual({
      ahead: 1,
      headSha: head,
    });
    expect(await scm.compareBranch(repo, 'f'.repeat(40), 'main')).toBeNull();
  });
  it('supports a merge still pending at 120 seconds with virtual timers', async () => {
    vi.useFakeTimers();
    try {
      const { scm, pr, sha } = await setup(
        new FakeScm({ mergeDelayMs: 121_000 }),
      );
      let completed = false;
      const merge = scm
        .mergePR(pr, { method: 'merge', expectedHeadSha: sha })
        .then((result) => {
          completed = true;
          return result;
        });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(completed).toBe(false);
      expect(scm.inspectObject(pr).state).toBe('open');
      await vi.advanceTimersByTimeAsync(1000);
      await merge;
      expect(completed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it('rechecks head after an injected delay before committing a merge', async () => {
    let release = () => {};
    const delay = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { scm, pr, sha } = await setup(
      new FakeScm({ mergeDelayMs: 1, delay: () => delay }),
    );
    const merge = scm.mergePR(pr, { method: 'merge', expectedHeadSha: sha });
    scm.pushBranch(repo, 'ai-office/worker');
    release();
    await expect(merge).rejects.toMatchObject({ code: 'head_sha_mismatch' });
  });
  it('keeps repositories and cursor scopes isolated', async () => {
    const scm = new FakeScm();
    scm.addRepo(repo);
    const other = { ...repo, name: 'other' };
    scm.addRepo(other);
    await scm.createIssue(repo, { title: 'One', body: '', labels: [] }, c);
    expect(await scm.findByMarker(other, c.commandId)).toBeNull();
    const result = await scm.poll(repo, null);
    await expect(scm.poll(other, result.cursor)).rejects.toMatchObject({
      code: 'invalid_cursor',
    });
    result.events.length = 0;
    expect((await scm.poll(repo, null)).events).toHaveLength(1);
  });
});
