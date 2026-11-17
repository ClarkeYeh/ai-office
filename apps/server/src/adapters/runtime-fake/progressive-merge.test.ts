import { describe, expect, it } from 'vitest';
import { AgentSubmissionSchema } from '@ai-office/contracts/agent-submission';
import type { AgentSubmission } from '@ai-office/contracts/agent-submission';
import { FakeScm } from '../scm-fake/index.js';
import { FakeClock } from '../../test-support/services.js';
import { FakeRuntime } from './index.js';
import { mainlineScenario } from './mainline.js';

const repo = { orcaRepoId: 'repo', localPath: '/repo' };
const github = { owner: 'owner', name: 'repo' };
const integration = 'ai-office/integration';
const c = (commandId: string) => ({ workflowId: 'wf', commandId });

async function fixture() {
  const clock = new FakeClock();
  const runtime = new FakeRuntime({ clock });
  const session = await runtime.openSession({
    repo,
    workflowId: 'wf',
    objective: 'test',
    correlation: c('open'),
  });
  const sha = 'a'.repeat(40);
  runtime.setRemoteBranch(repo, integration, sha);
  const request = {
    repo,
    session,
    baseBranch: sha,
    baseSha: sha,
    fetchBranch: integration,
    branch: 'ai-office/feature',
    name: 'feature',
    correlation: c('prepare'),
  };
  return { runtime, request, sha };
}

describe('pinned workspace preparation', () => {
  it('fetches the existing worker branch and preserves its pin after a lost response', async () => {
    const { runtime, request } = await fixture();
    const headSha = 'd'.repeat(40);
    runtime.setRemoteBranch(repo, request.branch, headSha);
    const rework = {
      ...request,
      checkoutExisting: true as const,
      baseSha: headSha,
      baseBranch: headSha,
      fetchBranch: request.branch,
      name: 'feature-r1',
    };
    runtime.injectFault('prepareWorkspace', 'response-lost');
    await expect(runtime.prepareWorkspace(rework)).rejects.toMatchObject({
      code: 'response_lost',
    });
    runtime.setRemoteBranch(repo, request.branch, 'e'.repeat(40));
    expect((await runtime.prepareWorkspace(rework)).baseSha).toBe(headSha);
    expect(runtime.fetchedBranches()).toEqual([
      { repo, branch: request.branch, headSha },
    ]);
  });

  it('rejects existing-branch checkout without the matching fetch or an available remote branch', async () => {
    const { runtime, request } = await fixture();
    for (const fetchBranch of [undefined, integration]) {
      await expect(
        runtime.prepareWorkspace({
          ...request,
          checkoutExisting: true,
          fetchBranch,
        }),
      ).rejects.toMatchObject({ code: 'invalid_existing_branch' });
    }
    await expect(
      runtime.prepareWorkspace({
        ...request,
        checkoutExisting: true,
        fetchBranch: request.branch,
      }),
    ).rejects.toMatchObject({ code: 'remote_branch_not_found' });
    expect(runtime.fetchedBranches()).toEqual([]);
  });

  it('fetches the remote but preserves the SCM-resolved commit across head movement and lost-response replay', async () => {
    const { runtime, request, sha } = await fixture();
    runtime.setRemoteBranch(repo, integration, 'b'.repeat(40));
    runtime.injectFault('prepareWorkspace', 'response-lost');
    await expect(runtime.prepareWorkspace(request)).rejects.toMatchObject({
      code: 'response_lost',
    });
    runtime.setRemoteBranch(repo, integration, 'c'.repeat(40));
    const result = await runtime.prepareWorkspace(request);
    expect(result.baseSha).toBe(sha);
    expect(result.path).not.toBe(result.workspace);
    expect(runtime.fetchedBranches()).toEqual([
      { repo, branch: integration, headSha: 'b'.repeat(40) },
    ]);
    result.path = '/mutated';
    expect((await runtime.prepareWorkspace(request)).path).not.toBe('/mutated');
  });

  it('resolves an unpinned origin/<fetchBranch> base to the fetched head', async () => {
    const { runtime, request } = await fixture();
    const head = 'b'.repeat(40);
    runtime.setRemoteBranch(repo, integration, head);
    const { baseSha: _pinned, ...rest } = request;
    void _pinned;
    const result = await runtime.prepareWorkspace({
      ...rest,
      baseBranch: `origin/${integration}`,
      name: 'merge-1',
      branch: 'ai-office/merge-1',
      correlation: c('merge-workspace'),
    });
    expect(result.baseSha).toBe(head);
    expect(runtime.fetchedBranches()).toEqual([
      { repo, branch: integration, headSha: head },
    ]);
  });

  it('accepts the concrete command schema shape with the pinned SHA in baseBranch', async () => {
    const { runtime, request, sha } = await fixture();
    const { baseSha: _baseSha, ...commandArgs } = request;
    void _baseSha;
    expect((await runtime.prepareWorkspace(commandArgs)).baseSha).toBe(sha);
  });

  it('rejects mismatched, missing and unavailable pinned bases before creating a workspace', async () => {
    const { runtime, request } = await fixture();
    await expect(
      runtime.prepareWorkspace({
        ...request,
        baseBranch: 'origin/ai-office/integration',
      }),
    ).rejects.toMatchObject({ category: 'bug' });
    await expect(
      runtime.prepareWorkspace({ ...request, fetchBranch: undefined }),
    ).rejects.toMatchObject({ category: 'bug' });
    await expect(
      runtime.prepareWorkspace({ ...request, fetchBranch: 'missing' }),
    ).rejects.toMatchObject({ code: 'remote_branch_not_found' });
    await expect(
      runtime.prepareWorkspace({
        ...request,
        baseBranch: 'f'.repeat(40),
        baseSha: 'f'.repeat(40),
      }),
    ).rejects.toMatchObject({ code: 'base_sha_unavailable' });
    await expect(runtime.prepareWorkspace(request)).resolves.toMatchObject({
      baseSha: request.baseSha,
    });
  });

  it('does not fetch on a disconnected attempt and isolates remote repositories', async () => {
    const { runtime, request } = await fixture();
    runtime.injectFault('prepareWorkspace', 'disconnect');
    await expect(runtime.prepareWorkspace(request)).rejects.toMatchObject({
      category: 'transient',
    });
    expect(runtime.fetchedBranches()).toEqual([]);
    await expect(
      runtime.prepareWorkspace({
        ...request,
        repo: { ...repo, localPath: '/other' },
      }),
    ).rejects.toMatchObject({ code: 'remote_branch_not_found' });
  });
});

describe('progressive mainline adapter scenario', () => {
  it('reworks the same PR, merges multiple PRs through one keepOpen reviewer and prepares the dependent from the merged head', async () => {
    const scm = new FakeScm();
    scm.addRepo(github);
    await scm.ensureBranch(github, integration, 'main', c('integration'));
    const clock = new FakeClock();
    const submissions: AgentSubmission[] = [];
    const runtime = new FakeRuntime({
      clock,
      scenario: mainlineScenario,
      submitter: async ({ submission }) => {
        submissions.push(AgentSubmissionSchema.parse(submission));
        if (submission.kind === 'merge-request') {
          const { mergeCommitSha } = await scm.mergePR(
            { repo: github, number: submission.payload.pr },
            {
              method: 'merge',
              expectedHeadSha: submission.payload.expectedHeadSha,
            },
          );
          runtime.setRemoteBranch(repo, integration, mergeCommitSha);
        }
      },
    });
    const session = await runtime.openSession({
      repo,
      workflowId: 'wf',
      objective: 'progressive',
      correlation: c('open'),
    });
    const prepare = async (item: string) => {
      const comparison = await scm.compareBranch(
        github,
        integration,
        integration,
      );
      if (!comparison) throw new Error('Missing remote integration branch');
      runtime.setRemoteBranch(repo, integration, comparison.headSha);
      return runtime.prepareWorkspace({
        repo,
        session,
        baseBranch: comparison.headSha,
        baseSha: comparison.headSha,
        fetchBranch: integration,
        name: item,
        branch: `ai-office/${item}`,
        correlation: c(`prepare-${item}`),
      });
    };
    const first = await prepare('feature');
    const reviewer = await runtime.spawnAgent({
      session,
      agent: 'codex',
      title: 'merge-queue',
      prompt: 'aio_seat_test',
      workspace: {
        kind: 'existing-worktree',
        workspace: first.workspace,
        readOnly: false,
      },
      correlation: c('reviewer'),
      keepOpen: true,
    });
    const pump = async () => {
      clock.advance(30);
      await runtime.runDue();
    };
    await pump();
    await scm.ensureBranch(
      github,
      'ai-office/feature',
      integration,
      c('feature'),
    );
    let head = scm.pushBranch(github, 'ai-office/feature');
    const pr = await scm.openPR(
      github,
      {
        title: 'Feature',
        body: '',
        base: integration,
        head: 'ai-office/feature',
      },
      c('feature-pr'),
    );
    const review = async (
      id: string,
      number: number,
      sha: string,
      rework = false,
    ) => {
      await runtime.send(reviewer, {
        subject: 'Review PR',
        body: JSON.stringify({ pr: number, headSha: sha, rework }),
        correlation: c(id),
      });
      await pump();
    };
    await review('rework', pr.number, head, true);
    expect(scm.inspectObject(pr).state).toBe('open');
    expect(
      (await scm.compareBranch(github, integration, integration))?.headSha,
    ).toBe(first.baseSha);
    // The new attempt pushes the same branch and retains the same PR.
    head = scm.pushBranch(github, 'ai-office/feature');
    await review('accept-feature', pr.number, head);
    const mergedHead = (
      await scm.compareBranch(github, integration, integration)
    )?.headSha;
    expect(mergedHead).not.toBe(first.baseSha);
    const dependent = await prepare('dependent');
    expect(dependent.baseSha).toBe(mergedHead);
    await scm.ensureBranch(
      github,
      'ai-office/dependent',
      dependent.baseSha!,
      c('dependent'),
    );
    expect(
      (
        await scm.compareBranch(
          github,
          'ai-office/feature',
          'ai-office/dependent',
        )
      )?.ahead,
    ).toBeGreaterThan(0);
    const dependentHead = scm.pushBranch(github, 'ai-office/dependent');
    const dependentPr = await scm.openPR(
      github,
      {
        title: 'Dependent',
        body: '',
        base: integration,
        head: 'ai-office/dependent',
      },
      c('dependent-pr'),
    );
    clock.advance(120_001);
    await review('accept-dependent', dependentPr.number, dependentHead);
    expect(scm.inspectObject(dependentPr).state).toBe('merged');
    expect(submissions.map((s) => s.kind)).toEqual([
      'rework-request',
      'merge-request',
      'merge-request',
    ]);
    await runtime.stop(reviewer);
    await runtime.release(reviewer, { removeWorkspace: false });
    const finalizer = await runtime.spawnAgent({
      session,
      agent: 'codex',
      title: 'integrator',
      prompt: 'aio_seat_test',
      workspace: {
        kind: 'existing-worktree',
        workspace: dependent.workspace,
        readOnly: false,
      },
      correlation: c('finalizer'),
      keepOpen: false,
    });
    await pump();
    expect(submissions.at(-1)?.kind).toBe('integration-report');
    expect(submissions.filter((s) => s.kind === 'merge-request')).toHaveLength(
      2,
    );
    await runtime.stop(finalizer);
    await runtime.release(finalizer, { removeWorkspace: false });
    expect(runtime.activeAgents()).toEqual([]);
  });
});
