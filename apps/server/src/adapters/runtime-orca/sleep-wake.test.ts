import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import type { RuntimePort } from '../../ports/runtime.js';
import { MemoryLogger } from '../../test-support/index.js';
import type { OrcaCli } from './cli/types.js';
import { sessionRef } from './refs.js';
import { DispatchLedger } from './ledger.js';
import { withSleepWake } from './sleep-wake.js';

function setup(overrides: { preventSleep?: boolean; platform?: string } = {}) {
  const run = sessionRef('run-test');
  const children: (EventEmitter & { kill: ReturnType<typeof vi.fn> })[] = [];
  const spawn = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    children.push(child);
    return child;
  });
  const identity = {
    ensure: vi.fn(async () => ({ handle: 'shim', restored: false })),
    checkOwnership: vi.fn(async () => 'owned' as const),
    drainEvents: () => [],
  };
  const ledger = new DispatchLedger({ read: () => undefined, write: () => {} });
  ledger.pending({ commandId: 'cmd', run, keepOpen: true });
  ledger.started('cmd', 'dispatch');
  let exited = false;
  const cli = {
    run: vi.fn(async <T = Record<string, unknown>>(args: readonly string[]) => {
      let result: Record<string, unknown>;
      switch (args[1]) {
        case 'request-show':
          result = { state: 'completed' };
          break;
        case 'inbox':
          result = {
            messages: exited
              ? [
                  {
                    id: 'wake-mail',
                    type: 'worker_done',
                    sequence: 1,
                    created_at: '2026-11-18T00:00:00Z',
                    payload: JSON.stringify({
                      dispatchId: 'dispatch',
                      taskId: 'task',
                      outcome: 'succeeded',
                    }),
                  },
                ]
              : [],
          };
          break;
        case 'check':
          result = { messages: [] };
          break;
        case 'worker-list':
          result = {
            workers: [
              {
                dispatchId: 'dispatch',
                taskId: 'task',
                runId: run,
                terminalState: exited ? 'exited' : 'running',
                projection: {
                  liveness: { verdict: exited ? 'exited' : 'alive' },
                },
              },
            ],
          };
          break;
        case 'worker-show':
          result = { observation: { agentWait: null } };
          break;
        case 'worker-read':
          result = { source: 'transcript', transcript: [] };
          break;
        default:
          throw new Error('Unexpected operation');
      }
      return { exitCode: 0, result: result as T };
    }),
  };
  const runtime = {
    openSession: vi.fn(async () => run),
    closeSession: vi.fn(async () => {}),
    spawnAgent: vi.fn(),
    send: vi.fn(),
  } as unknown as RuntimePort;
  const version = { check: vi.fn(async () => ({})) };
  const wrapped = withSleepWake(runtime, {
    observer: { cli: cli as OrcaCli, identity, ledger, now: () => 0 },
    version,
    logger: new MemoryLogger(),
    platform: 'darwin',
    pid: 123,
    spawn,
    ...overrides,
  });
  return {
    wrapped,
    run,
    spawn,
    children,
    cli,
    runtime,
    identity,
    version,
    exit: () => {
      exited = true;
    },
  };
}
const request = {
  workflowId: 'wf',
  repo: 'repo' as never,
  objective: 'test',
  correlation: { workflowId: 'wf', commandId: 'cmd' },
};
describe('Orca sleep/wake', () => {
  it('rechecks identity and version, then backfills and detects exited workers without respawning', async () => {
    const h = setup();
    const before = await h.wrapped.observe(h.run, null);
    h.exit();
    await h.wrapped.forceRecheck();
    expect(h.identity.ensure).toHaveBeenCalledWith({ force: true });
    expect(h.identity.checkOwnership).toHaveBeenCalledWith(h.run, {
      force: true,
    });
    expect(h.version.check).toHaveBeenCalledWith(true);
    h.cli.run.mockClear();
    const after = await h.wrapped.observe(h.run, before.cursor);
    expect(after.events).toContainEqual(
      expect.objectContaining({ type: 'agent.exited' }),
    );
    expect(h.cli.run.mock.calls.map(([args]) => args[1])).toEqual(
      expect.arrayContaining(['inbox', 'worker-list']),
    );
    expect(after.events).toContainEqual(
      expect.objectContaining({
        type: 'agent.done',
        externalKey: 'orca:msg:wake-mail',
      }),
    );
    expect(h.runtime.spawnAgent).not.toHaveBeenCalled();
    expect(h.runtime.send).not.toHaveBeenCalled();
    await h.wrapped.close();
  });
  it('holds one assertion across sessions and releases on last close or shutdown', async () => {
    const h = setup();
    await h.wrapped.openSession(request);
    await h.wrapped.openSession(request);
    expect(h.spawn).toHaveBeenCalledExactlyOnceWith('/usr/bin/caffeinate', [
      '-i',
      '-w',
      '123',
    ]);
    const second = sessionRef('run-second');
    await h.wrapped.observe(second, null);
    await h.wrapped.closeSession(h.run);
    expect(h.children[0]?.kill).not.toHaveBeenCalled();
    await h.wrapped.closeSession(second);
    expect(h.children[0]?.kill).toHaveBeenCalledTimes(1);
    await h.wrapped.openSession(request);
    await h.wrapped.close();
    await h.wrapped.close();
    expect(h.children[1]?.kill).toHaveBeenCalledTimes(1);
  });
  it.each([{ preventSleep: false }, { platform: 'linux' }])(
    'does not spawn when disabled or unsupported: %j',
    async (options) => {
      const h = setup(options);
      await h.wrapped.openSession(request);
      expect(h.spawn).not.toHaveBeenCalled();
      await h.wrapped.close();
    },
  );
  it('handles a missing caffeinate executable without killing the backend', async () => {
    const h = setup();
    await h.wrapped.openSession(request);
    h.children[0]!.emit('error', new Error('missing'));
    await h.wrapped.close();
    expect(h.children[0]?.kill).not.toHaveBeenCalled();
  });
});
