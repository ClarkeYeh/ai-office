import { expect, test, vi } from 'vitest';
import { DomainEventSchema } from '@ai-office/contracts/events';
import { external } from '@ai-office/engine';
import {
  harness,
  startWorkflow,
  StubWorld,
} from '../runner/test-support/harness.js';

test.each([true, false])(
  'routes explicit reclamation and preserves reclaimed=%s without a request ID',
  async (reclaimed) => {
    const world = new StubWorld();
    const reclaim = vi.fn().mockResolvedValue({ reclaimed });
    world.runtime.reclaimSession = reclaim;
    const h = harness({
      world,
      react: (_state, event) =>
        event.type === 'workflow.started'
          ? [
              external('reclaim', {
                kind: 'runtime.reclaimSession',
                args: { session: 'session-1' },
              }),
            ]
          : [],
    });
    await h.runners.start(startWorkflow());
    await h.runners.idle();
    expect(reclaim).toHaveBeenCalledExactlyOnceWith('session-1');
    const issued = h.events().find((e) => e.type === 'command.issued');
    expect(issued?.payload).toEqual({
      commandId: 'reclaim',
      kind: 'runtime.reclaimSession',
      args: { session: 'session-1' },
    });
    const succeeded = h.events().find((e) => e.type === 'command.succeeded');
    expect(succeeded?.payload).toEqual({
      commandId: 'reclaim',
      kind: 'runtime.reclaimSession',
      result: { reclaimed },
    });
    expect(DomainEventSchema.safeParse(succeeded).success).toBe(true);
  },
);
