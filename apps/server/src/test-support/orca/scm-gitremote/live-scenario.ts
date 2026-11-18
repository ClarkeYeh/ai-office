import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { OrcaHarness } from '../harness.js';
import { GitRemoteScm } from './index.js';
import { git, TestGitRemote } from './git.js';

/** Invoked only by the gated live suite/runner; the runner owns janitor cleanup. */
export async function run(harness: OrcaHarness): Promise<void> {
  const options = { remote: harness.ledger.repoPath, harness };
  const scm = await GitRemoteScm.create(options);
  let writer: TestGitRemote | undefined;
  try {
    writer = await TestGitRemote.create(options);
    const repo = { owner: 'ClarkeYeh', name: 'ai-office-spike' };
    const prefix = `ai-office-test/scm-${randomUUID()}`;
    const base = `${prefix}/integration`,
      head = `${prefix}/worker`;
    const correlation = (commandId: string) => ({
      workflowId: prefix,
      commandId,
    });
    await scm.ensureBranch(repo, base, 'main', correlation('base'));
    await scm.ensureBranch(repo, head, base, correlation('worker'));
    const initial = (await scm.compareBranch(repo, head, head))!.headSha;
    await writer.fetch();
    await git(writer.path, ['checkout', '--detach', initial]);
    await git(writer.path, [
      'commit',
      '--allow-empty',
      '-m',
      'SCM smoke change',
    ]);
    const sha = await git(writer.path, ['rev-parse', 'HEAD']);
    await writer.push(head, sha, initial);
    assert.deepEqual(await scm.compareBranch(repo, initial, head), {
      ahead: 1,
      headSha: sha,
    });
    const pr = await scm.openPR(
      repo,
      { title: 'SCM smoke', body: '', base, head },
      correlation('pr'),
    );
    const result = await scm.mergePR(pr, {
      method: 'merge',
      expectedHeadSha: sha,
    });
    assert.equal(
      (await scm.compareBranch(repo, base, base))!.headSha,
      result.mergeCommitSha,
    );
    await writer.fetch();
    assert.equal(
      await git(writer.path, [
        'merge-base',
        '--is-ancestor',
        sha,
        result.mergeCommitSha,
      ]),
      '',
    );
    assert.equal(
      (
        await git(writer.path, [
          'rev-list',
          '--parents',
          '-n',
          '1',
          result.mergeCommitSha,
        ])
      ).split(' ').length,
      3,
    );
  } finally {
    await writer?.dispose();
    await scm.dispose();
  }
}
