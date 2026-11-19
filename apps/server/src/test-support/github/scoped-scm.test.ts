import { expect, it } from 'vitest';
import { FakeScm } from '../../adapters/scm-fake/index.js';
import { bodyHash } from '@ai-office/domain';
import { scopeGithubScm } from './scoped-scm.js';
import { githubBranches } from './branch-namespace.js';
import { assertBranch, assertCommand, marker } from './safety.js';

const repo = { owner: 'ClarkeYeh', name: 'ai-office-spike' };
const runId = '123456abcdef';
const shortId = 'ab12';
const c = (commandId: string) => ({ workflowId: '01WORKFLOW', commandId });

it('bridges contract IDs to guarded test resources and restores observed IDs', async () => {
  const underlying = new FakeScm();
  underlying.addRepo(repo);
  const scm = scopeGithubScm(underlying, runId, shortId);
  const integration = `ai-office/${shortId}-integration`;
  const worker = `ai-office/${shortId}/feature`;
  await scm.ensureBranch(
    repo,
    integration,
    'main',
    c('01WORKFLOW/integration'),
  );
  const base = (await scm.compareBranch(repo, integration, integration))!
    .headSha;
  const remoteWorker = githubBranches(runId, shortId).remote(worker);
  underlying.pushBranch(repo, remoteWorker, base);
  const commandId = '01WORKFLOW/pr';
  const pr = await scm.openPR(
    repo,
    {
      title: 'Worker',
      body: `Refs #4\n${marker(commandId)}`,
      head: worker,
      base: integration,
    },
    c(commandId),
  );
  const object = underlying.inspectObject(pr);
  expect(object.head).toBe(remoteWorker);
  expect(() => assertBranch(object.head!, runId)).not.toThrow();
  expect(object.title).toBe(`[aio-test ${runId}] Worker`);
  expect(object.body).toContain(marker(`t${runId}:${commandId}`));
  expect(object.body).not.toContain(marker(commandId));
  expect(() => assertCommand(`t${runId}:${commandId}`, runId)).not.toThrow();
  expect((await scm.getPR(pr)).base).toBe(integration);
  expect((await scm.findByMarker(repo, commandId))?.number).toBe(pr.number);
  const draft = { title: 'Conclusion', body: 'Synthetic body', labels: [] };
  const issue = await scm.createIssue(repo, draft, c('01WORKFLOW/issue'));
  const read = await scm.getIssue(issue);
  expect(read.bodyHash).toBe(bodyHash(read.body));
  expect(read.body).toContain(marker(`t${runId}:01WORKFLOW/issue`));
  await scm.createIssue(repo, draft, c('01WORKFLOW/issue'));
  const polled = await scm.poll(repo, null);
  expect(polled.events).toContainEqual(
    expect.objectContaining({
      type: 'object.duplicate',
      commandId: '01WORKFLOW/issue',
    }),
  );
  expect(polled.events).toContainEqual(
    expect.objectContaining({
      type: 'pr.state',
      head: worker,
      base: integration,
    }),
  );
  await scm.comment(
    issue,
    marker('01WORKFLOW/comment'),
    c('01WORKFLOW/comment'),
  );
  expect((await scm.findByMarker(repo, '01WORKFLOW/comment'))?.kind).toBe(
    'comment',
  );
  await scm.updateIssue(issue, {
    body: marker('01WORKFLOW/issue'),
    title: 'Updated',
  });
  expect((await scm.getIssue(issue)).body).toBe(
    marker(`t${runId}:01WORKFLOW/issue`),
  );
  await scm.updatePR(pr, { body: marker(commandId), title: 'Updated PR' });
  expect(underlying.inspectObject(pr).body).toBe(
    marker(`t${runId}:${commandId}`),
  );
  await scm.deleteBranch(repo, worker);
  expect(await scm.compareBranch(repo, worker, worker)).toBeNull();
});

it('only maps exact namespace boundaries, keeping SHA and main references intact', () => {
  const branches = githubBranches(runId, shortId);
  for (const ref of ['main', 'a'.repeat(40), 'ai-office/ab123/feature'])
    expect(branches.remote(ref)).toBe(ref);
  const retry = `ai-office/${shortId}/dependent-a2`;
  expect(branches.logical(branches.remote(retry))).toBe(retry);
  expect(() => githubBranches(runId, `t${runId}`)).toThrow('shortId');
});

it('maps a recorded logical expectedBase to the test-namespace base when merging', async () => {
  const underlying = new FakeScm();
  underlying.addRepo(repo);
  const scm = scopeGithubScm(underlying, runId, shortId);
  const integration = `ai-office/${shortId}-integration`;
  const worker = `ai-office/${shortId}/merge`;
  await scm.ensureBranch(repo, integration, 'main', c('01WORKFLOW/int'));
  const head = underlying.pushBranch(
    repo,
    githubBranches(runId, shortId).remote(worker),
    githubBranches(runId, shortId).remote(integration),
  );
  const commandId = '01WORKFLOW/merge-pr';
  const pr = await scm.openPR(
    repo,
    {
      title: 'Merge me',
      body: `Refs #4\n${marker(commandId)}`,
      head: worker,
      base: integration,
    },
    c(commandId),
  );
  await expect(
    scm.mergePR(pr, {
      method: 'merge',
      expectedHeadSha: head,
      expectedBase: integration,
    }),
  ).resolves.toMatchObject({ mergeCommitSha: expect.any(String) });
});
