import { initialState } from '@ai-office/domain';
import type { Attempt } from '@ai-office/domain';
import { describe, expect, test } from 'vitest';
import { releaseAttempt, stopAttempt } from './agents.js';
import type { ReactContext } from './context.js';
import { sessionRef } from './context.js';
import { startWorkflow } from './test-support/fixtures.js';
import { Simulator } from './test-support/simulator.js';

const ctx: ReactContext = {
  workflowId: 'wf-1',
  before: initialState(),
  state: initialState(),
  event: { occurredAt: '2026-11-17T00:00:00.000Z' } as ReactContext['event'],
};
const attempt = { attemptId: 'a-1', stageId: 's' } as Attempt;

describe('agent commands', () => {
  test('need the agent ref reported by the spawn', () => {
    expect(stopAttempt(ctx, attempt)).toEqual([]);
    expect(releaseAttempt(ctx, attempt, true)).toEqual([]);
  });

  test('are deterministic and scoped to the attempt', () => {
    const running = { ...attempt, agentRef: 'agent-1' };
    expect(stopAttempt(ctx, running, 'x', 1)).toEqual([
      {
        kind: 'external',
        commandId: 'wf-1/stop/a-1/x/1',
        command: { kind: 'runtime.stop', args: { agent: 'agent-1' } },
        stageId: 's',
        attemptId: 'a-1',
      },
    ]);
    expect(releaseAttempt(ctx, running, false)).toEqual([
      {
        kind: 'external',
        commandId: 'wf-1/release/a-1',
        command: {
          kind: 'runtime.release',
          args: { agent: 'agent-1', removeWorkspace: false },
        },
        stageId: 's',
        attemptId: 'a-1',
      },
    ]);
  });
});

describe('sessionRef', () => {
  test('is known only once runtime.openSession succeeded', () => {
    expect(sessionRef(initialState())).toBeUndefined();
    const hung = new Simulator({ world: () => undefined }).dispatch(
      startWorkflow(),
    );
    expect(Object.keys(hung.state.commands)).toHaveLength(2);
    expect(sessionRef(hung.state)).toBeUndefined();
  });
});
