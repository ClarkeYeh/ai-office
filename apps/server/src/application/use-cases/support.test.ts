import { expect, it, vi } from 'vitest';
import type { ExternalCommand } from '@ai-office/contracts/events';
import { harness, startWorkflow } from '../runner/test-support/harness.js';
import { draft, issueBatch } from './support.js';

it('redoes only stored command IDs when an idempotent batch is repeated', async () => {
  const h = harness({ react: () => [] });
  await h.runners.start(startWorkflow());
  const runner = h.runners.get('wf-1')!;
  const redo = vi.spyOn(runner, 'redo');
  const commands: ExternalCommand[] = [
    {
      kind: 'scm.deleteBranch',
      args: {
        repo: { owner: 'octo', name: 'demo' },
        name: 'ai-office/test/worker',
      },
    },
  ];
  const idempotency = {
    scope: 'test-batch',
    key: 'same-request',
    record: {
      requestHash: 'same-hash',
      response: { status: 200, body: {} },
      expiresAt: '2027-01-01T00:00:00.000Z',
    },
  };
  const events = [
    draft(h.clock, runner.workflowId, 'message.instruction', {
      seatId: 'test-seat',
      attemptId: 'test-attempt',
      subject: 'Continue',
      body: 'Continue',
    }),
  ];
  const storedIds = await issueBatch(
    runner,
    h.clock,
    h.ids,
    commands,
    events,
    idempotency,
  );
  await runner.idle();
  expect(storedIds).toHaveLength(1);
  expect(redo.mock.calls).toEqual(storedIds.map((id) => [id]));
  redo.mockClear();
  const repeatedIds = await issueBatch(
    runner,
    h.clock,
    h.ids,
    commands,
    events,
    idempotency,
  );
  expect(repeatedIds).toEqual([]);
  expect(redo).not.toHaveBeenCalled();
});
