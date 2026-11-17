import { expect, it } from 'vitest';
import { ScmEventSchema } from '../../ports/scm-events.js';
import { FakeScm } from './index.js';

it('polls the actual final merge commit rather than the PR head commit', async () => {
  const scm = new FakeScm();
  const repo = { owner: 'owner', name: 'repo' };
  const c = { workflowId: 'workflow', commandId: 'branch' };
  scm.addRepo(repo);
  await scm.ensureBranch(repo, 'ai-office/integration', 'main', c);
  const headSha = scm.pushBranch(repo, 'ai-office/integration');
  const pr = await scm.openPR(
    repo,
    { title: 'Final', body: '', head: 'ai-office/integration', base: 'main' },
    { ...c, commandId: 'pr' },
  );
  const cursor = (await scm.poll(repo, null)).cursor;
  const { mergeCommitSha } = await scm.mergeExternally(pr);
  const result = await scm.poll(repo, cursor);
  const event = result.events.find((e) => e.type === 'pr.state');
  expect(ScmEventSchema.parse(event)).toMatchObject({
    state: 'merged',
    headSha,
    mergeCommitSha,
  });
  expect(mergeCommitSha).not.toBe(headSha);
  expect((await scm.compareBranch(repo, 'main', 'main'))?.headSha).toBe(
    mergeCommitSha,
  );
  expect(await scm.poll(repo, cursor)).toEqual(result);
});
