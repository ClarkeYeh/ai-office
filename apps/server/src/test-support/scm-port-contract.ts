import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bodyHash } from '@ai-office/domain';
import { PortError } from '../ports/errors.js';
import {
  CREATE_PENDING_WINDOW_MS,
  CREATE_RETRY_AFTER_MS,
} from '../ports/scm.js';
import type { ScmPort } from '../ports/scm.js';
import type { IssueRef, PrRef, RepoScmRef } from '../ports/refs.js';
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
  // PP6: optional controls; a case needing an absent control is skipped.
  // Live bindings must not supply controls that write the default branch
  // (`mergeExternally` of a final PR, `pushDefaultBranch`, M3_PLAN §1.4 GD).
  /** Let `ms` pass: advance the fake clock, or wait for the real service. */
  settle?: (ms: number) => Promise<void>;
  /** The next create of this kind succeeds remotely but its response is lost. */
  loseNextResponse?: (operation: 'createIssue' | 'comment') => void;
  /** New Issues and comments stay invisible to list scans for `ms`. */
  listLagMs?: (ms: number) => void;
  /** Someone else merges the PR (the owner merging the final PR). */
  mergeExternally?: (pr: PrRef) => Promise<void>;
  closeExternally?: (pr: PrRef) => Promise<void>;
  /** Changes the PR's base now, or between the merge's base read and merge. */
  retargetExternally?: (
    pr: PrRef,
    base: string,
    when: 'now' | 'during-next-merge',
  ) => Promise<void>;
  commentExternally?: (target: IssueRef | PrRef, body: string) => Promise<void>;
  createExternalIssue?: (draft: {
    title: string;
    body: string;
  }) => Promise<IssueRef>;
  /** Pushes a commit to the default branch outside AI Office; returns its SHA. */
  pushDefaultBranch?: () => Promise<string>;
};
type Control = Exclude<
  {
    [K in keyof ScmContractFixture]-?: undefined extends ScmContractFixture[K]
      ? K
      : never;
  }[keyof ScmContractFixture],
  'branchPrefix' | 'dispose'
>;
export function scmPortContract(
  factory: () => ScmContractFixture | Promise<ScmContractFixture>,
): void {
  // Git-backed and recorded bindings run many subprocesses or requests per case.
  describe('ScmPort contract', { timeout: 30_000 }, () => {
    let f: ScmContractFixture;
    const c = (commandId: string) => ({ workflowId: 'workflow', commandId });
    beforeEach(async () => {
      f = await factory();
    });
    afterEach(async () => {
      await f.dispose?.();
    });
    const branch = (name: string) => `${f.branchPrefix ?? 'ai-office/'}${name}`;
    /** Skips the case unless the binding supplies every named control. */
    function controls<K extends Control>(
      skip: (note?: string) => void,
      ...names: K[]
    ): Required<Pick<ScmContractFixture, K>> {
      const missing = names.filter((name) => f[name] === undefined);
      if (missing.length) skip(`binding lacks ${missing.join(', ')}`);
      return f as unknown as Required<Pick<ScmContractFixture, K>>;
    }
    /** The executor's rhythm: wait `retryAfterMs`, then retry the same command. */
    async function retrying<T>(
      settle: (ms: number) => Promise<void>,
      call: () => Promise<T>,
    ): Promise<T> {
      for (let attempt = 0; attempt < 100; attempt++)
        try {
          return await call();
        } catch (error) {
          if (!(error instanceof PortError) || error.retryAfterMs === undefined)
            throw error;
          expect(error).toMatchObject({
            category: 'transient',
            code: 'create_outcome_unknown',
          });
          await settle(error.retryAfterMs);
        }
      throw new Error('Create never settled');
    }
    const later = (iso: string, ms: number) =>
      new Date(Date.parse(iso) + ms).toISOString();
    async function workerPr(title = 'Work', commandId = 'worker-pr') {
      const sha = await branches();
      const pr = await f.scm.openPR(
        f.repo,
        {
          title,
          body: '',
          base: branch('integration'),
          head: branch('worker'),
        },
        c(commandId),
      );
      return { sha, pr };
    }
    async function headOf(name: string) {
      return (await f.scm.compareBranch(f.repo, name, name))!.headSha;
    }
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
      const created = (await f.scm.getIssue(issue)).updatedAt;
      expect(await f.scm.findByMarker(f.repo, 'issue')).toEqual({
        repo: issue.repo,
        number: issue.number,
        kind: 'issue',
        url: issue.url,
      });
      expect(
        await f.scm.findByMarker(f.repo, 'issue', {
          since: created,
          kind: 'issue',
        }),
      ).toMatchObject({ number: issue.number, url: issue.url });
      expect(
        await f.scm.findByMarker(f.repo, 'issue', {
          since: later(created, 24 * 3_600_000),
        }),
      ).toBeNull();
      expect(
        await f.scm.findByMarker(f.repo, 'issue', { kind: 'pr' }),
      ).toBeNull();
      expect(await f.scm.findByMarker(f.repo, 'issu')).toBeNull();
      await f.scm.comment(issue, 'Approved', c('comment'));
      const comment = await f.scm.findByMarker(f.repo, 'comment', {
        since: created,
      });
      expect(comment).toEqual({
        repo: issue.repo,
        number: issue.number,
        kind: 'comment',
        url: expect.stringMatching(/^https?:\/\//),
        commentId: expect.any(String),
      });
      expect(
        await f.scm.findByMarker(f.repo, 'comment', { kind: 'issue' }),
      ).toBeNull();
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
      expect(await f.scm.findByMarker(f.repo, 'pr', { kind: 'pr' })).toEqual({
        repo: pr.repo,
        number: pr.number,
        kind: 'pr',
        url: pr.url,
      });
    });
    it('deletes only its own marked comments, idempotently', async () => {
      const issue = await f.scm.createIssue(
        f.repo,
        { title: 'Issue', body: '', labels: [] },
        c('target'),
      );
      await f.scm.comment(issue, 'Note', c('note'));
      const found = await f.scm.findByMarker(f.repo, 'note');
      expect(found?.commentId).toEqual(expect.any(String));
      await f.scm.deleteComment(issue, found!.commentId!);
      expect(await f.scm.findByMarker(f.repo, 'note')).toBeNull();
      await f.scm.deleteComment(issue, found!.commentId!);
    });
    for (const operation of ['createIssue', 'comment'] as const)
      it(`retries a lost ${operation} response at retryAfterMs without duplicating`, async ({
        skip,
      }) => {
        const { settle, loseNextResponse } = controls(
          skip,
          'settle',
          'loseNextResponse',
        );
        f.listLagMs?.(CREATE_PENDING_WINDOW_MS / 2);
        const target = await f.scm.createIssue(
          f.repo,
          { title: 'Target', body: '', labels: [] },
          c('target'),
        );
        await settle(CREATE_PENDING_WINDOW_MS);
        const before = await f.scm.poll(f.repo, null);
        loseNextResponse(operation);
        const number =
          operation === 'createIssue'
            ? (
                await retrying(settle, () =>
                  f.scm.createIssue(
                    f.repo,
                    { title: 'Once', body: 'Body', labels: [] },
                    c('once'),
                  ),
                )
              ).number
            : (await retrying(settle, () =>
                f.scm.comment(target, 'Once', c('once')),
              ),
              target.number);
        await settle(CREATE_PENDING_WINDOW_MS);
        const found = await f.scm.findByMarker(f.repo, 'once');
        expect(found).toMatchObject({
          kind: operation === 'createIssue' ? 'issue' : 'comment',
          number,
        });
        expect(found?.duplicates ?? 0).toBe(0);
        expect(
          (await f.scm.poll(f.repo, before.cursor)).events,
        ).not.toContainEqual(
          expect.objectContaining({ type: 'object.duplicate' }),
        );
      });
    it('reports object.duplicate when list lag outlasts the pending window', async ({
      skip,
    }) => {
      const { settle, loseNextResponse, listLagMs } = controls(
        skip,
        'settle',
        'loseNextResponse',
        'listLagMs',
      );
      const lag = CREATE_PENDING_WINDOW_MS + 4 * CREATE_RETRY_AFTER_MS;
      listLagMs(lag);
      const before = await f.scm.poll(f.repo, null);
      loseNextResponse('createIssue');
      const kept = await retrying(settle, () =>
        f.scm.createIssue(
          f.repo,
          { title: 'Twice', body: '', labels: [] },
          c('twice'),
        ),
      );
      await settle(lag);
      const found = await f.scm.findByMarker(f.repo, 'twice');
      expect(found).toMatchObject({ kind: 'issue', duplicates: 1 });
      expect(found!.number).toBeLessThan(kept.number);
      const polled = await f.scm.poll(f.repo, before.cursor);
      expect(polled.events).toContainEqual(
        expect.objectContaining({
          type: 'object.duplicate',
          commandId: 'twice',
          kind: 'issue',
          numbers: [found!.number, kept.number],
        }),
      );
      for (const event of polled.events)
        expect(ScmEventSchema.safeParse(event).success).toBe(true);
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
    it('checks expectedBaseSha, reports the merged PR and stays idempotent', async () => {
      const { sha, pr } = await workerPr();
      const base = await headOf(branch('integration'));
      await expect(
        f.scm.mergePR(pr, {
          method: 'merge',
          expectedHeadSha: sha,
          expectedBaseSha: 'e'.repeat(40),
        }),
      ).rejects.toMatchObject({ category: 'conflict', code: 'base_moved' });
      expect(await f.scm.getPR(pr)).toMatchObject({
        state: 'open',
        headSha: sha,
        base: branch('integration'),
      });
      const opts = {
        method: 'merge' as const,
        expectedHeadSha: sha,
        expectedBaseSha: base,
      };
      const merged = await f.scm.mergePR(pr, opts);
      expect(await f.scm.mergePR(pr, opts)).toEqual(merged);
      expect(await f.scm.getPR(pr)).toEqual({
        state: 'merged',
        mergeCommitSha: merged.mergeCommitSha,
        headSha: sha,
        base: branch('integration'),
        mergedBy: expect.any(String),
      });
      expect(await headOf(branch('integration'))).toBe(merged.mergeCommitSha);
    });
    it('judges the actual base, never the requested one', async ({ skip }) => {
      const { retargetExternally } = controls(skip, 'retargetExternally');
      const { sha, pr } = await workerPr();
      await retargetExternally(pr, f.defaultBranch, 'now');
      await expect(
        f.scm.mergePR(pr, { method: 'merge', expectedHeadSha: sha }),
      ).rejects.toMatchObject({ category: 'guard' });
      expect(await f.scm.getPR(pr)).toMatchObject({
        state: 'open',
        base: f.defaultBranch,
      });
    });
    it('guards a base retargeted while merging (merge_base_changed)', async ({
      skip,
    }) => {
      const { retargetExternally } = controls(skip, 'retargetExternally');
      const { sha, pr } = await workerPr();
      await f.scm.ensureBranch(
        f.repo,
        branch('other'),
        branch('integration'),
        c('other'),
      );
      await retargetExternally(pr, branch('other'), 'during-next-merge');
      await expect(
        f.scm.mergePR(pr, { method: 'merge', expectedHeadSha: sha }),
      ).rejects.toMatchObject({
        category: 'guard',
        code: 'merge_base_changed',
      });
      expect((await f.scm.getPR(pr)).base).toBe(branch('other'));
    });
    it('observes an external merge of the final PR with mergedBy', async ({
      skip,
    }) => {
      const { mergeExternally } = controls(skip, 'mergeExternally');
      await branches();
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
      const before = await f.scm.poll(f.repo, null);
      await mergeExternally(final);
      expect((await f.scm.poll(f.repo, before.cursor)).events).toContainEqual(
        expect.objectContaining({
          type: 'pr.state',
          pr: { repo: final.repo, number: final.number },
          state: 'merged',
          mergedBy: expect.any(String),
        }),
      );
      expect(await f.scm.getPR(final)).toMatchObject({
        state: 'merged',
        base: f.defaultBranch,
        mergedBy: expect.any(String),
      });
    });
    it('observes an external close of a PR', async ({ skip }) => {
      const { closeExternally } = controls(skip, 'closeExternally');
      const { pr } = await workerPr();
      const before = await f.scm.poll(f.repo, null);
      await closeExternally(pr);
      expect((await f.scm.poll(f.repo, before.cursor)).events).toContainEqual(
        expect.objectContaining({
          type: 'pr.state',
          pr: { repo: pr.repo, number: pr.number },
          state: 'closed',
        }),
      );
      expect((await f.scm.getPR(pr)).state).toBe('closed');
    });
    it('reports branch heads: ai-office branches and external default-branch pushes', async ({
      skip,
    }) => {
      const before = await f.scm.poll(f.repo, null);
      const sha = await branches();
      const pushed = await f.scm.poll(f.repo, before.cursor);
      expect(pushed.events).toContainEqual(
        expect.objectContaining({
          type: 'branch.head_changed',
          branch: branch('worker'),
          sha,
        }),
      );
      for (const event of pushed.events)
        expect(ScmEventSchema.safeParse(event).success).toBe(true);
      const { pushDefaultBranch } = controls(skip, 'pushDefaultBranch');
      const previous = await headOf(f.defaultBranch);
      const next = await pushDefaultBranch();
      expect((await f.scm.poll(f.repo, pushed.cursor)).events).toContainEqual(
        expect.objectContaining({
          type: 'branch.head_changed',
          branch: f.defaultBranch,
          sha: next,
          previousSha: previous,
        }),
      );
    });
    it('hashes body only: labels and comments do not invalidate approval', async () => {
      const issue = await f.scm.createIssue(
        f.repo,
        { title: 'Conclusion', body: 'Original', labels: [] },
        c('conclusion'),
      );
      const original = await f.scm.getIssue(issue);
      expect(original.bodyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(original.bodyHash).toBe(bodyHash(original.body));
      await f.scm.setLabels(issue, ['ai-office:pending']);
      await f.scm.comment(issue, 'Decision', c('decision'));
      await f.commentExternally?.(issue, 'Looks good');
      expect((await f.scm.getIssue(issue)).bodyHash).toBe(original.bodyHash);
      await f.editBody(issue, original.body.replace(/\n/g, '\r\n'));
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
      if (!f.createExternalIssue) return;
      const external = await f.createExternalIssue({
        title: 'Manual',
        body: 'Filed by hand',
      });
      expect((await f.scm.poll(f.repo, edited.cursor)).events).toContainEqual(
        expect.objectContaining({
          type: 'repo.object_created',
          ref: { repo: external.repo, number: external.number },
          hasMarker: false,
        }),
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
      await f.scm.deleteBranch(f.repo, branch('worker'));
      await f.scm.deleteBranch(f.repo, branch('never-created'));
    });
    it('ensures ai-office branches idempotently, never moving an existing one', async () => {
      const sha = await branches();
      await f.scm.ensureBranch(
        f.repo,
        branch('worker'),
        f.defaultBranch,
        c('again'),
      );
      expect(await headOf(branch('worker'))).toBe(sha);
      await expect(
        f.scm.ensureBranch(f.repo, 'user-branch', f.defaultBranch, c('user')),
      ).rejects.toMatchObject({ category: 'guard' });
    });
    it('closes an open PR when its head branch is deleted', async () => {
      const { pr } = await workerPr();
      await f.scm.deleteBranch(f.repo, branch('worker'));
      expect((await f.scm.getPR(pr)).state).toBe('closed');
    });
  });
}
