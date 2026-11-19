import { describe, expect, it, vi } from 'vitest';
import { PortError } from '../../ports/errors.js';
import { CREATE_RETRY_AFTER_MS } from '../../ports/scm.js';
import {
  FakeClock,
  InMemoryEventStore,
  ManualScheduler,
  MemoryLogger,
} from '../../test-support/index.js';
import { flush } from '../runner/test-support/harness.js';
import {
  HEALTH_TIMER_PREFIX,
  HealthMonitor,
} from '../health/health-monitor.js';
import {
  CommandExecutor,
  RETRY_AFTER_TOTAL_MS,
  RETRY_TIMER_PREFIX,
} from './executor.js';
import type { CommandHandlers, IssuedCommand } from './executor.js';

const repo = { owner: 'o', name: 'r' };
const createIssue: IssuedCommand = {
  workflowId: 'wf-1',
  commandId: 'cmd-1',
  command: {
    kind: 'scm.createIssue',
    args: { repo, title: 't', body: 'b', labels: [] },
  },
};
const stop: IssuedCommand = {
  workflowId: 'wf-1',
  commandId: 'cmd-2',
  command: { kind: 'runtime.stop', args: { agent: 'a' } },
};
const unknownOutcome = () =>
  new PortError(
    'transient',
    'create_outcome_unknown',
    'GitHub creation outcome is unknown',
    true,
    CREATE_RETRY_AFTER_MS,
  );
const rateLimited = (code: string, retryAfterMs: number) =>
  new PortError(
    'rate_limited',
    code,
    'GitHub request budget is temporarily unavailable',
    true,
    retryAfterMs,
  );
const transient = () =>
  new PortError('transient', 'github_unavailable', 'GitHub is unavailable');

function setup(handlers: CommandHandlers) {
  const clock = new FakeClock();
  const scheduler = new ManualScheduler(clock, (timer) => {
    if (timer.id.startsWith(RETRY_TIMER_PREFIX)) executor.wake(timer.id);
    else if (timer.id.startsWith(HEALTH_TIMER_PREFIX))
      void health.onTimer(timer);
  });
  const health = new HealthMonitor({
    clock,
    scheduler,
    store: new InMemoryEventStore(),
    probes: {
      runtime: async () => {},
      scm: async () => {},
      store: async () => {},
      usage: async () => {},
    },
    workflows: () => [],
    runtime: { mode: 'fake', verified: true },
  });
  const executor: CommandExecutor = new CommandExecutor({
    handlers,
    health,
    clock,
    scheduler,
    logger: new MemoryLogger(),
    random: () => 0,
  });
  return {
    clock,
    health,
    executor,
    /** Steps one second at a time so each rescheduled wait fires on time. */
    async advance(ms: number) {
      for (let left = ms; left > 0; left -= 1_000) {
        clock.advance(Math.min(1_000, left));
        scheduler.runDue();
        await flush();
      }
    },
  };
}

describe('CommandExecutor retryAfterMs (PP4, M3_PLAN §4.7)', () => {
  it('waits the stated time without spending the transient retries', async () => {
    const handler = vi.fn();
    for (let i = 0; i < 5; i++) handler.mockRejectedValueOnce(unknownOutcome());
    handler.mockResolvedValue({ issue: 7, url: 'u' });
    const h = setup({ 'scm.createIssue': handler });
    const outcome = vi.fn();
    void h.executor.execute(createIssue).then(outcome);
    await flush();
    for (let i = 1; i <= 5; i++) {
      expect(handler).toHaveBeenCalledTimes(i);
      await h.advance(CREATE_RETRY_AFTER_MS - 1);
      expect(handler).toHaveBeenCalledTimes(i);
      await h.advance(1);
    }
    expect(outcome).toHaveBeenCalledWith({
      ok: true,
      attempts: 6,
      result: { kind: 'scm.createIssue', result: { issue: 7, url: 'u' } },
    });
    expect(
      handler.mock.calls.every((call) => call[0] === createIssue.command.args),
    ).toBe(true);
  });

  it('fails once the total wait reaches its cap', async () => {
    const handler = vi.fn().mockRejectedValue(unknownOutcome());
    const h = setup({ 'scm.createIssue': handler });
    const outcome = vi.fn();
    void h.executor.execute(createIssue).then(outcome);
    await flush();
    const waits = Math.ceil(RETRY_AFTER_TOTAL_MS / CREATE_RETRY_AFTER_MS);
    await h.advance(RETRY_AFTER_TOTAL_MS - 1);
    expect(outcome).not.toHaveBeenCalled();
    await h.advance(1);
    expect(outcome).toHaveBeenCalledWith({
      ok: false,
      attempts: waits + 1,
      error: expect.objectContaining({
        category: 'transient',
        code: 'create_outcome_unknown',
      }),
    });
  });

  it('clamps a wait to what is left of the cap', async () => {
    const handler = vi
      .fn()
      .mockRejectedValueOnce(rateLimited('primary_rate_limit', 40 * 60_000))
      .mockResolvedValue({ issue: 1, url: 'u' });
    const h = setup({ 'scm.createIssue': handler });
    const outcome = vi.fn();
    void h.executor.execute(createIssue).then(outcome);
    await flush();
    await h.advance(RETRY_AFTER_TOTAL_MS - 1);
    expect(handler).toHaveBeenCalledTimes(1);
    await h.advance(1);
    expect(outcome).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, attempts: 2 }),
    );
  });

  it('keeps the transient budget separate from retryAfterMs waits', async () => {
    const handler = vi
      .fn()
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(unknownOutcome())
      .mockRejectedValueOnce(transient());
    const h = setup({ 'scm.createIssue': handler });
    const outcome = vi.fn();
    void h.executor.execute(createIssue).then(outcome);
    await flush();
    await h.advance(1_000);
    await h.advance(2_000);
    await h.advance(4_000);
    expect(handler).toHaveBeenCalledTimes(4);
    await h.advance(CREATE_RETRY_AFTER_MS);
    expect(outcome).toHaveBeenCalledWith({
      ok: false,
      attempts: 5,
      error: expect.objectContaining({ code: 'github_unavailable' }),
    });
  });

  it('treats a zero retryAfterMs as absent (the category backoff)', async () => {
    const handler = vi.fn().mockRejectedValue(rateLimited('primary', 0));
    const h = setup({ 'scm.createIssue': handler });
    const outcome = vi.fn();
    void h.executor.execute(createIssue).then(outcome);
    await flush();
    await h.advance(1_000);
    await h.advance(2_000);
    await h.advance(4_000);
    expect(outcome).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, attempts: 4 }),
    );
  });

  it.each(['primary_rate_limit', 'secondary_rate_limit'])(
    'never opens the scm breaker on a %s, and runtime commands still run',
    async (code) => {
      const label = vi.fn().mockRejectedValue(rateLimited(code, 15_000));
      const stopHandler = vi.fn(async () => ({}));
      const h = setup({
        'scm.ensureLabels': label,
        'runtime.stop': stopHandler,
      });
      const outcome = vi.fn();
      void h.executor
        .execute({
          ...createIssue,
          command: { kind: 'scm.ensureLabels', args: { repo, labels: [] } },
        })
        .then(outcome);
      await flush();
      await h.advance(150_000);
      expect(label.mock.calls.length).toBeGreaterThanOrEqual(10);
      expect(h.health.snapshot().scm.breaker).toBe('closed');
      expect(h.health.dispatchBlockedFor('scm.ensureLabels')).toBe(false);
      expect(await h.executor.execute(stop)).toMatchObject({ ok: true });
      await h.advance(RETRY_AFTER_TOTAL_MS - 150_000);
      expect(outcome).toHaveBeenCalledWith(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ category: 'rate_limited', code }),
        }),
      );
      expect(h.health.snapshot().scm.breaker).toBe('closed');
    },
  );
});
