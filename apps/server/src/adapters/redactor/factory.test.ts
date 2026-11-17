import { expect, it } from 'vitest';
import { RawAgentOutputSchema } from '../../ports/runtime-events.js';
import { createRedactorFactory } from './index.js';

it('builds isolated attempt policy contexts and preserves explicitly configured repository URLs', () => {
  const factory = createRedactorFactory({
    preservedRepoUrls: ['https://github.com/example/project'],
  });
  const context = {
    attemptId: 'attempt',
    defaultBranch: 'main',
    integrationBranch: 'ai-office/integration',
  };
  const worker = factory.forAttempt({
    ...context,
    currentBranch: 'ai-office/worker',
  });
  const main = factory.forAttempt({ ...context, currentBranch: 'main' });
  const unknown = factory.forAttempt({ ...context, currentBranch: null });
  const output = RawAgentOutputSchema.parse({
    type: 'agent.output',
    agent: 'agent',
    externalKey: 'message',
    occurredAt: '2026-11-17T00:00:00Z',
    messageId: 'message',
    role: 'assistant',
    blocks: [
      {
        type: 'tool_use',
        id: 'tool',
        name: 'shell',
        input: { command: 'git push' },
      },
    ],
  });
  expect(worker.toActivity(output).policyHits).toEqual([]);
  expect(main.toActivity(output).policyHits).toMatchObject([
    { rule: 'push-default-branch', severity: 'high' },
  ]);
  expect(unknown.toActivity(output).policyHits).toMatchObject([
    { rule: 'push-default-branch' },
  ]);
  expect(worker.maskSecrets('https://github.com/example/project/pull/1')).toBe(
    'https://github.com/example/project/pull/1',
  );
});
