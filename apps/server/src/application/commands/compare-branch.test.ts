import { expect, test, vi } from 'vitest';
import { DomainEventSchema } from '@ai-office/contracts/events';
import { external } from '@ai-office/engine';
import {
  harness,
  startWorkflow,
  StubWorld,
  WORKFLOW_ID,
} from '../runner/test-support/harness.js';

const args = {
  repo: { owner: 'octo', name: 'demo' },
  base: 'ai-office/integration',
  head: 'ai-office/worker',
};

test.each([
  null,
  { ahead: 0, headSha: 'a'.repeat(40) },
  { ahead: 2, headSha: 'b'.repeat(40) },
])(
  'routes compareBranch and delivers its result to engine reaction: %j',
  async (result) => {
    const world = new StubWorld();
    const compare = vi.fn().mockResolvedValue(result);
    world.scm.compareBranch = compare;
    const reacted: unknown[] = [];
    const h = harness({
      world,
      react: (_state, event) => {
        if (event.type === 'workflow.started')
          return [external('compare', { kind: 'scm.compareBranch', args })];
        if (event.type === 'command.succeeded') reacted.push(event.payload);
        return [];
      },
    });
    await h.runners.start(startWorkflow());
    await h.runners.idle();
    expect(compare).toHaveBeenCalledExactlyOnceWith(
      args.repo,
      args.base,
      args.head,
    );
    const issued = h.events().find((e) => e.type === 'command.issued');
    expect(issued?.payload).toEqual({
      commandId: 'compare',
      kind: 'scm.compareBranch',
      args,
    });
    const succeeded = h.events().find((e) => e.type === 'command.succeeded');
    expect(succeeded?.payload).toEqual({
      commandId: 'compare',
      kind: 'scm.compareBranch',
      result,
    });
    expect(DomainEventSchema.safeParse(succeeded).success).toBe(true);
    expect(reacted).toEqual([succeeded?.payload]);
    // Read-only replay uses the same three arguments, with no mutation correlation.
    expect(
      await h.executor.execute({
        workflowId: WORKFLOW_ID,
        commandId: 'compare',
        command: { kind: 'scm.compareBranch', args },
      }),
    ).toEqual({
      ok: true,
      attempts: 1,
      result: { kind: 'scm.compareBranch', result },
    });
    expect(compare.mock.calls).toEqual([
      [args.repo, args.base, args.head],
      [args.repo, args.base, args.head],
    ]);
  },
);

test('passes existing-branch checkout arguments unchanged to RuntimePort', async () => {
  const world = new StubWorld();
  const prepare = vi.spyOn(world.runtime, 'prepareWorkspace');
  const h = harness({ world });
  const checkout = {
    session: 'session-1',
    repo: { orcaRepoId: 'repo', localPath: '/repo' },
    baseBranch: 'a'.repeat(40),
    fetchBranch: args.head,
    branch: args.head,
    name: 'worker-r1',
    checkoutExisting: true as const,
  };
  await h.executor.execute({
    workflowId: WORKFLOW_ID,
    commandId: 'rework',
    command: { kind: 'runtime.prepareWorkspace', args: checkout },
  });
  expect(prepare).toHaveBeenCalledExactlyOnceWith({
    ...checkout,
    correlation: { workflowId: WORKFLOW_ID, commandId: 'rework' },
  });
});
