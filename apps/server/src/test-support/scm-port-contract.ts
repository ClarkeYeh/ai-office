import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScmPort } from '../ports/scm.js';
import type { IssueRef, RepoScmRef } from '../ports/refs.js';
import { ScmEventSchema } from '../ports/scm-events.js';

/** M3 can supply recorded HTTP interactions behind the same port and controls. */
export type ScmContractFixture = {
  scm: ScmPort;
  repo: RepoScmRef;
  defaultBranch: string;
  /** Restricted test remotes use ai-office-test/ instead. */
  branchPrefix?: string;
  pushBranch: (branch: string) => Promise<string>;
  editBody: (issue: IssueRef, body: string) => Promise<void>;
  dispose?: () => void | Promise<void>;
};
export function scmPortContract(
  factory: () => ScmContractFixture | Promise<ScmContractFixture>,
): void {
  describe('ScmPort contract', () => {
    let f: ScmContractFixture;
    const c = (commandId: string) => ({ workflowId: 'workflow', commandId });
    beforeEach(async () => {
      f = await factory();
    });
    afterEach(async () => {
      await f.dispose?.();
    });
    const branch = (name: string) => `${f.branchPrefix ?? 'ai-office/'}${name}`;
    async function branches() {
      await f.scm.ensureBranch(
        f.repo,
        branch('integration'),
        f.defaultBranch,
        c('integration'),
      );
      await f.scm.ensureBranch(
        f.repo,
        branch('worker'),
        branch('integration'),
        c('worker'),
      );
      return f.pushBranch(branch('worker'));
    }
    it('recovers issue, PR and comment targets by exact command marker', async () => {
      const issue = await f.scm.createIssue(
        f.repo,
        { title: 'Conclusion', body: 'Decision', labels: [] },
        c('issue'),
      );
      expect(issue.url).toMatch(/^https?:\/\//);
      expect((await f.scm.getIssue(issue)).body).toContain(
        '<!-- ai-office:cmd=issue -->',
      );
      expect(await f.scm.findByMarker(f.repo, 'issue')).toEqual({
        repo: issue.repo,
        number: issue.number,
      });
      expect(await f.scm.findByMarker(f.repo, 'issu')).toBeNull();
      await f.scm.comment(issue, 'Approved', c('comment'));
      expect(await f.scm.findByMarker(f.repo, 'comment')).toEqual({
        repo: issue.repo,
        number: issue.number,
      });
      await branches();
      const pr = await f.scm.openPR(
        f.repo,
        {
          title: 'Work',
          body: '',
          base: branch('integration'),
          head: branch('worker'),
        },
        c('pr'),
      );
      expect(pr.url).toMatch(/^https?:\/\//);
      expect(await f.scm.findByMarker(f.repo, 'pr')).toEqual({
        repo: pr.repo,
        number: pr.number,
      });
    });
    it('rejects merging into the default branch and mismatched head SHA', async () => {
      const sha = await branches();
      const final = await f.scm.openPR(
        f.repo,
        {
          title: 'Final',
          body: '',
          base: f.defaultBranch,
          head: branch('worker'),
        },
        c('final'),
      );
      await expect(
        f.scm.mergePR(final, { method: 'merge', expectedHeadSha: sha }),
      ).rejects.toMatchObject({ category: 'guard' });
      const worker = await f.scm.openPR(
        f.repo,
        {
          title: 'Work',
          body: '',
          base: branch('integration'),
          head: branch('worker'),
        },
        c('worker-pr'),
      );
      await expect(
        f.scm.mergePR(worker, {
          method: 'merge',
          expectedHeadSha: 'f'.repeat(40),
        }),
      ).rejects.toMatchObject({ category: 'conflict' });
      expect(
        (await f.scm.mergePR(worker, { method: 'merge', expectedHeadSha: sha }))
          .mergeCommitSha,
      ).toMatch(/^[0-9a-f]{40}$/);
    });
    it('hashes body only: labels and comments do not invalidate approval', async () => {
      const issue = await f.scm.createIssue(
        f.repo,
        { title: 'Conclusion', body: 'Original', labels: [] },
        c('conclusion'),
      );
      const original = await f.scm.getIssue(issue);
      expect(original.bodyHash).toMatch(/^[0-9a-f]{64}$/);
      await f.scm.setLabels(issue, ['ai-office:pending']);
      await f.scm.comment(issue, 'Decision', c('decision'));
      expect((await f.scm.getIssue(issue)).bodyHash).toBe(original.bodyHash);
      await f.editBody(issue, 'Edited externally');
      expect((await f.scm.getIssue(issue)).bodyHash).not.toBe(
        original.bodyHash,
      );
    });
    it('polls only changes and replays an uncommitted cursor', async () => {
      const initial = await f.scm.poll(f.repo, null);
      expect((await f.scm.poll(f.repo, initial.cursor)).events).toEqual([]);
      const issue = await f.scm.createIssue(
        f.repo,
        { title: 'Issue', body: '', labels: [] },
        c('new'),
      );
      const created = await f.scm.poll(f.repo, initial.cursor);
      expect(created.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'repo.object_created',
            ref: { repo: issue.repo, number: issue.number },
            hasMarker: true,
          }),
        ]),
      );
      for (const event of created.events)
        expect(ScmEventSchema.safeParse(event).success).toBe(true);
      expect(await f.scm.poll(f.repo, initial.cursor)).toEqual(created);
      expect((await f.scm.poll(f.repo, created.cursor)).events).toEqual([]);
      await f.editBody(issue, 'Changed');
      const edited = await f.scm.poll(f.repo, created.cursor);
      expect(edited.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'issue.edited',
            bodyHash: (await f.scm.getIssue(issue)).bodyHash,
          }),
        ]),
      );
    });
    it('compares branches and guards deletion', async () => {
      await branches();
      expect(
        await f.scm.compareBranch(
          f.repo,
          branch('integration'),
          branch('worker'),
        ),
      ).toMatchObject({ ahead: 1 });
      expect(
        await f.scm.compareBranch(f.repo, 'missing', branch('worker')),
      ).toBeNull();
      await expect(
        f.scm.deleteBranch(f.repo, f.defaultBranch),
      ).rejects.toMatchObject({ category: 'guard' });
      await expect(
        f.scm.deleteBranch(f.repo, 'user-branch'),
      ).rejects.toMatchObject({ category: 'guard' });
      await f.scm.deleteBranch(f.repo, branch('worker'));
      expect(
        await f.scm.compareBranch(f.repo, f.defaultBranch, branch('worker')),
      ).toBeNull();
    });
  });
}
