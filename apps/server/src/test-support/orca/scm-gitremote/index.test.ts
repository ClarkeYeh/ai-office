import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { IssueRef, PrRef } from '../../../ports/refs.js';
import { scmPortContract } from '../../scm-port-contract.js';
import { FakeClock } from '../../services.js';
import { GitRemoteScm } from './index.js';
import { git, TestGitRemote } from './git.js';

const repo = { owner: 'ClarkeYeh', name: 'ai-office-spike' };
const c = (commandId: string) => ({ workflowId: 'test', commandId });
const integration = 'ai-office-test/integration',
  worker = 'ai-office-test/worker';
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'aio-test-bare-'));
  const remote = join(dir, 'remote.git'),
    clone = join(dir, 'writer');
  await git(dir, ['init', '--bare', '--initial-branch=main', remote]);
  await mkdir(clone);
  await git(clone, ['clone', '--', remote, '.']);
  await writeFile(join(clone, 'shared.txt'), 'initial\n');
  await git(clone, ['add', '.']);
  await git(clone, ['commit', '-m', 'Initial']);
  await git(clone, ['push', 'origin', 'HEAD:refs/heads/main']);
  const clock = new FakeClock(new Date().toISOString());
  const scm = await GitRemoteScm.create({ remote, clock });
  async function pushBranch(branch: string, content?: string) {
    await git(clone, ['fetch', 'origin']);
    await git(clone, ['checkout', '--detach', '--force', `origin/${branch}`]);
    await writeFile(
      join(clone, content ? 'shared.txt' : 'worker.txt'),
      content ?? 'worker\n',
    );
    await git(clone, ['add', '.']);
    await git(clone, ['commit', '--allow-empty', '-m', 'Test change']);
    await git(clone, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
    return git(clone, ['rev-parse', 'HEAD']);
  }
  return {
    scm,
    repo,
    defaultBranch: 'main',
    branchPrefix: 'ai-office-test/',
    remote,
    clone,
    pushBranch,
    editBody: (ref: Parameters<GitRemoteScm['updateIssue']>[0], body: string) =>
      scm.updateIssue(ref, { body }),
    settle: async (ms: number) => clock.advance(ms),
    loseNextResponse: (operation: 'createIssue' | 'comment') =>
      scm.loseNextResponse(operation),
    listLagMs: (ms: number) => scm.setListLag(ms),
    // The owner's final-PR merge is simulated; main is never written by the SCM.
    mergeExternally: async (pr: PrRef) => scm.simulateOwnerMerge(pr),
    closeExternally: (pr: PrRef) => scm.updatePR(pr, { state: 'closed' }),
    retargetExternally: (
      pr: PrRef,
      base: string,
      when: 'now' | 'during-next-merge',
    ) => scm.retargetExternally(pr, base, when),
    commentExternally: async (target: IssueRef | PrRef, body: string) =>
      scm.addExternalComment(target, body),
    createExternalIssue: async (draft: { title: string; body: string }) =>
      scm.createExternalIssue(draft),
    pushDefaultBranch: () => pushBranch('main'),
    dispose: async () => {
      await scm.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
scmPortContract(fixture);

// Each case runs dozens of git subprocesses; 5 s is too tight on a loaded machine.
describe('git remote SCM', { timeout: 30_000 }, () => {
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  afterEach(async () => {
    await f?.dispose();
    f = undefined;
  });
  async function setup() {
    f = await fixture();
    await f.scm.ensureBranch(repo, integration, 'main', c('base'));
    await f.scm.ensureBranch(repo, worker, integration, c('worker'));
    return f;
  }
  it('uses remote heads and accepts a commit base (CP4), including missing refs', async () => {
    const f = await setup();
    const before = (await f.scm.compareBranch(repo, worker, worker))!.headSha;
    const sha = await f.pushBranch(worker);
    expect(await f.scm.compareBranch(repo, before, worker)).toEqual({
      ahead: 1,
      headSha: sha,
    });
    expect(await f.scm.compareBranch(repo, worker, worker)).toEqual({
      ahead: 0,
      headSha: sha,
    });
    expect(await f.scm.compareBranch(repo, 'f'.repeat(40), worker)).toBeNull();
    expect(await f.scm.compareBranch(repo, 'main', 'missing')).toBeNull();
    await f.scm.ensureBranch(repo, worker, 'main', c('again'));
    expect((await f.scm.compareBranch(repo, worker, worker))!.headSha).toBe(
      sha,
    );
  });
  it('creates a two-parent merge and the next worker inherits the change', async () => {
    const f = await setup();
    const base = (await f.scm.compareBranch(repo, integration, integration))!
      .headSha;
    const sha = await f.pushBranch(worker);
    const pr = await f.scm.openPR(
      repo,
      { title: 'Work', body: '', base: integration, head: worker },
      c('pr'),
    );
    expect(pr).toMatchObject({
      number: 1,
      head: worker,
      base: integration,
      url: 'https://github.com/ClarkeYeh/ai-office-spike/pull/1',
    });
    const merged = await f.scm.mergePR(pr, {
      method: 'merge',
      expectedHeadSha: sha,
    });
    expect(
      await f.scm.mergePR(pr, { method: 'merge', expectedHeadSha: sha }),
    ).toEqual(merged);
    expect(
      await git(f.remote, [
        'rev-list',
        '--parents',
        '-n',
        '1',
        merged.mergeCommitSha,
      ]),
    ).toBe(`${merged.mergeCommitSha} ${base} ${sha}`);
    await f.scm.ensureBranch(
      repo,
      'ai-office-test/next',
      integration,
      c('next'),
    );
    expect(
      await git(f.remote, [
        'show',
        'refs/heads/ai-office-test/next:worker.txt',
      ]),
    ).toBe('worker');
    expect(await f.scm.getPR(pr)).toEqual({
      state: 'merged',
      ...merged,
      headSha: sha,
      base: integration,
      mergedBy: 'scm-test',
    });
    expect((await f.scm.poll(repo, null)).events).toContainEqual(
      expect.objectContaining({ type: 'pr.state', state: 'merged', ...merged }),
    );
  });
  it('rejects conflicts and a stale head without changing the base, then can merge another PR', async () => {
    const f = await setup();
    const old = await f.pushBranch(worker, 'worker\n');
    const base = await f.pushBranch(integration, 'base\n');
    const pr = await f.scm.openPR(
      repo,
      { title: 'Conflict', body: '', base: integration, head: worker },
      c('pr'),
    );
    const sha = await f.pushBranch(worker, 'worker again\n');
    await expect(
      f.scm.mergePR(pr, { method: 'merge', expectedHeadSha: old }),
    ).rejects.toMatchObject({ category: 'conflict' });
    await expect(
      f.scm.mergePR(pr, { method: 'merge', expectedHeadSha: sha }),
    ).rejects.toMatchObject({ category: 'conflict' });
    expect(
      (await f.scm.compareBranch(repo, integration, integration))!.headSha,
    ).toBe(base);
    expect(await f.scm.getPR(pr)).toEqual({
      state: 'open',
      headSha: sha,
      base: integration,
    });
    await f.scm.ensureBranch(
      repo,
      'ai-office-test/next',
      integration,
      c('next'),
    );
    const next = await f.pushBranch('ai-office-test/next');
    const good = await f.scm.openPR(
      repo,
      {
        title: 'Good',
        body: '',
        base: integration,
        head: 'ai-office-test/next',
      },
      c('good'),
    );
    await expect(
      f.scm.mergePR(good, { method: 'merge', expectedHeadSha: next }),
    ).resolves.toHaveProperty('mergeCommitSha');
  });
  it('guards writes and reports external pushes without repeating committed events', async () => {
    const f = await setup();
    for (const name of [
      'main',
      'ai-office/worker',
      'user',
      'ai-office-test/x:main',
      'ai-office-test/../main',
      '--all',
    ]) {
      await expect(
        f.scm.ensureBranch(repo, name, 'main', c('bad')),
      ).rejects.toMatchObject({ category: 'guard' });
      await expect(f.scm.deleteBranch(repo, name)).rejects.toMatchObject({
        category: 'guard',
      });
    }
    const pr = await f.scm.openPR(
      repo,
      { title: 'Work', body: '', base: integration, head: worker },
      c('pr'),
    );
    const initial = await f.scm.poll(repo, null);
    const sha = await f.pushBranch(worker);
    const changed = await f.scm.poll(repo, initial.cursor);
    expect(changed.events).toEqual([
      expect.objectContaining({
        type: 'branch.head_changed',
        branch: worker,
        sha,
        previousSha: expect.any(String),
      }),
      expect.objectContaining({ type: 'pr.state', headSha: sha }),
    ]);
    expect(await f.scm.poll(repo, initial.cursor)).toEqual(changed);
    expect((await f.scm.poll(repo, changed.cursor)).events).toEqual([]);
    await f.scm.updatePR(pr, { state: 'closed' });
    await expect(
      f.scm.mergePR(pr, { method: 'merge', expectedHeadSha: sha }),
    ).rejects.toMatchObject({ category: 'conflict' });
    await f.scm.deleteBranch(repo, worker);
    await f.scm.deleteBranch(repo, worker);
  });
  it('refuses non-bare local repositories without a live harness', async () => {
    const f = await setup();
    await expect(
      GitRemoteScm.create({ remote: f.clone }),
    ).rejects.toMatchObject({ category: 'guard' });
    await expect(
      GitRemoteScm.create({ remote: 'https://github.com/ClarkeYeh/ai-office' }),
    ).rejects.toMatchObject({ category: 'guard' });
  });
  it('refuses to overwrite a base that moved after merge preparation', async () => {
    const f = await setup();
    const old = (await f.scm.compareBranch(repo, integration, integration))!
      .headSha;
    const writer = await TestGitRemote.create({ remote: f.remote });
    try {
      await expect(
        writer.push(integration, '--mirror', old),
      ).rejects.toMatchObject({ category: 'guard' });
      await writer.fetch();
      const moved = await f.pushBranch(integration);
      await expect(writer.push(integration, old, old)).rejects.toMatchObject({
        category: 'conflict',
      });
      expect(
        (await f.scm.compareBranch(repo, integration, integration))!.headSha,
      ).toBe(moved);
    } finally {
      await writer.dispose();
    }
  });
});
