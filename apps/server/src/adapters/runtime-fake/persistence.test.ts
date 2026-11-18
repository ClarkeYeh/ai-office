import { expect, it } from 'vitest';
import { FakeClock } from '../../test-support/services.js';
import { createFakeRuntime } from './index.js';
import type { SpawnRequest } from './scenario.js';

it('round-trips mailbox replay, questions, generation, absolute deadlines and function-backed turns', async () => {
  const clock = new FakeClock();
  const scenario = {
    roles: {
      worker: {
        spawn: [{ type: 'ask' as const, body: 'Continue?', afterMs: 100 }],
        answer: () => [{ type: 'done' as const, afterMs: 50 }],
        send: () => [{ type: 'done' as const, afterMs: 10 }],
      },
    },
  };
  const original = createFakeRuntime({ clock, scenario });
  const session = await original.openSession({
    workflowId: 'wf',
    repo: { orcaRepoId: 'repo', localPath: '/repo' },
    objective: 'test',
    correlation: { workflowId: 'wf', commandId: 'open' },
  });
  const request: SpawnRequest = {
    session,
    agent: 'codex',
    title: 'worker',
    prompt: 'Read a spec',
    workspace: {
      kind: 'new-worktree',
      baseBranch: 'main',
      name: 'worker',
      branch: 'work',
    },
    correlation: { workflowId: 'wf', commandId: 'spawn' },
    keepOpen: true,
  };
  const agent = await original.spawnAgent(request);
  const first = await original.observe(session, null);
  clock.advance(150);
  const restored = createFakeRuntime({ clock, scenario });
  restored.restore(JSON.parse(JSON.stringify(original.snapshot())));
  expect(await restored.spawnAgent(request)).toBe(agent);
  expect(restored.identity(agent)).toEqual(original.identity(agent));
  expect(await restored.observe(session, null)).toEqual(first);
  const delivery = await restored.observe(session, first.cursor);
  const question = delivery.events.find(
    (event) => event.type === 'agent.question',
  );
  expect(question?.occurredAt).toBe(
    new Date(clock.now().getTime() - 50).toISOString(),
  );
  if (question?.type !== 'agent.question') throw new Error('Missing question');
  await restored.answer(question.question, 'yes', {
    workflowId: 'wf',
    commandId: 'answer',
  });
  clock.advance(50);
  await restored.runDue();
  expect(
    (await restored.observe(session, delivery.cursor)).events.some(
      (e) => e.type === 'agent.done',
    ),
  ).toBe(true);
  await restored.send(agent, {
    subject: 'next',
    body: 'again',
    correlation: { workflowId: 'wf', commandId: 'send' },
  });
  expect(restored.snapshot().agents[0]?.turn).toBe(2);
  const detached = restored.snapshot();
  detached.agents[0]!.state = 'lost';
  expect(restored.activeAgents()).toEqual([agent]);
});

it('restores the side effect of a held spawn without serializing its promise', async () => {
  const clock = new FakeClock();
  const original = createFakeRuntime({ clock });
  const session = await original.openSession({
    workflowId: 'wf',
    repo: { orcaRepoId: 'repo', localPath: '/repo' },
    objective: 'test',
    correlation: { workflowId: 'wf', commandId: 'open' },
  });
  original.holdSpawn();
  const request: SpawnRequest = {
    session,
    agent: 'codex',
    title: 'worker',
    prompt: '',
    workspace: {
      kind: 'new-worktree',
      baseBranch: 'main',
      name: 'worker',
      branch: 'work',
    },
    correlation: { workflowId: 'wf', commandId: 'spawn' },
    keepOpen: true,
  };
  const pending = original.spawnAgent(request);
  const restored = createFakeRuntime({ clock });
  restored.restore(JSON.parse(JSON.stringify(original.snapshot())));
  expect(await restored.spawnAgent(request)).toBe(restored.activeAgents()[0]);
  expect((await restored.observe(session, null)).events).toHaveLength(1);
  original.finishPendingSpawns();
  await pending;
});
