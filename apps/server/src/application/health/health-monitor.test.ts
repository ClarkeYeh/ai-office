import { describe, expect, it, vi } from 'vitest';
import { HealthViewSchema } from '@ai-office/contracts/api';
import { evolveGlobal, initialGlobalReadModel } from '@ai-office/projection';
import { PortError } from '../../ports/errors.js';
import {
  FakeClock,
  ManualScheduler,
  MemoryLogger,
  InMemoryEventStore,
  InMemorySeatTokenStore,
  SeqIdGen,
} from '../../test-support/index.js';
import { CommandExecutor } from '../commands/executor.js';
import type { CommandHandlers, IssuedCommand } from '../commands/executor.js';
import type { RunnerReact } from '../runner/workflow-runner.js';
import { WorkflowRunners } from '../runner/runners.js';
import {
  MemorySpecStore,
  startWorkflow,
  flush,
} from '../runner/test-support/harness.js';
import { HEALTH_TIMER_PREFIX, HealthMonitor } from './health-monitor.js';
import type { HealthComponent } from './health-monitor.js';

const transient = () =>
  new PortError('transient', 'unavailable', 'sensitive raw error');
function setup(
  handlers: CommandHandlers = {},
  react: RunnerReact = () => [],
  store = new InMemoryEventStore(),
  probeTimeoutMs?: number,
) {
  const clock = new FakeClock();
  const probes = {
    runtime: vi.fn(async () => {}),
    scm: vi.fn(async () => {}),
    store: vi.fn(async () => {}),
    usage: vi.fn(async () => {}),
  };
  const scheduler = new ManualScheduler(clock, (timer) => {
    if (timer.id.startsWith(HEALTH_TIMER_PREFIX)) void health.onTimer(timer);
    else runners.onTimer(timer);
  });
  const health: HealthMonitor = new HealthMonitor({
    clock,
    scheduler,
    store,
    probes,
    workflows: () => runners.all(),
    runtime: { mode: 'fake', verified: true },
    ...(probeTimeoutMs === undefined ? {} : { probeTimeoutMs }),
  });
  const executor = new CommandExecutor({
    handlers,
    health,
    clock,
    scheduler,
    logger: new MemoryLogger(),
    random: () => 0,
  });
  const runners = new WorkflowRunners({
    executor,
    clock,
    scheduler,
    store,
    logger: new MemoryLogger(),
    ids: new SeqIdGen(),
    seatTokens: new InMemorySeatTokenStore(),
    specStore: new MemorySpecStore(),
    cliPath: '/app/cli.js',
    react,
  });
  return {
    clock,
    store,
    probes,
    scheduler,
    health,
    executor,
    runners,
    async fail(component: HealthComponent, count = 5) {
      for (let i = 0; i < count; i++)
        await health.record(component, clock.now().getTime(), 'transient');
    },
    async advance(ms: number) {
      clock.advance(ms);
      scheduler.runDue();
      await flush();
    },
  };
}
const issued: IssuedCommand = {
  workflowId: 'wf-1',
  commandId: 'cmd-1',
  command: { kind: 'runtime.stop', args: { agent: 'agent-1' } },
};

describe('HealthMonitor', () => {
  it('opens at five consecutive transients in 60 seconds, probes at 10 seconds, and resumes only its reason', async () => {
    const h = setup();
    await h.runners.start(startWorkflow());
    await h.runners.dispatch('wf-1', {
      type: 'PauseWorkflow',
      reason: 'budget',
      meta: { occurredAt: h.clock.now().toISOString(), source: 'system' },
    });
    await h.fail('runtime', 4);
    expect(h.health.dispatchBlocked).toBe(false);
    await h.fail('runtime', 1);
    expect(h.runners.get('wf-1')?.state.workflow?.pausedReasons).toEqual([
      'budget',
      'runtime_unhealthy',
    ]);
    await h.advance(9_999);
    expect(h.probes.runtime).not.toHaveBeenCalled();
    await h.advance(1);
    expect(h.health.snapshot().runtime.breaker).toBe('closed');
    expect(h.runners.get('wf-1')?.state.workflow?.pausedReasons).toEqual([
      'budget',
    ]);
    expect(
      h.store
        .read({})
        .filter((e) => e.type === 'health.changed')
        .map((e) => e.payload),
    ).toEqual([
      { component: 'runtime', status: 'unhealthy', breaker: 'open' },
      { component: 'runtime', status: 'unhealthy', breaker: 'half_open' },
      { component: 'runtime', status: 'healthy', breaker: 'closed' },
    ]);
    expect(h.store.read({}).some((e) => e.type === 'gate.opened')).toBe(false);
    expect(JSON.stringify(h.store.read({}))).not.toContain(
      'sensitive raw error',
    );
  });

  it('resets the streak on success and non-transient errors, and expires old failures', async () => {
    const h = setup();
    await h.fail('runtime', 4);
    await h.health.record('runtime', 0);
    await h.fail('runtime', 4);
    await h.health.record('runtime', 0, 'permanent');
    await h.fail('runtime', 4);
    h.clock.advance(60_001);
    await h.fail('runtime', 1);
    expect(h.health.dispatchBlocked).toBe(false);
    await h.fail('runtime', 4);
    expect(h.health.dispatchBlocked).toBe(true);
  });

  it('admits only one probe, retries a failed probe, and blocks until every required system recovers', async () => {
    const h = setup();
    let finish!: () => void;
    h.probes.runtime.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    h.probes.scm.mockRejectedValueOnce(transient());
    await h.fail('runtime');
    await h.fail('scm');
    const admitted = vi.fn();
    void h.health.waitUntilDispatchable().then(admitted);
    await h.advance(10_000);
    expect(h.health.snapshot().runtime.breaker).toBe('half_open');
    await h.health.onTimer({
      id: `${HEALTH_TIMER_PREFIX}runtime`,
      workflowId: '__health__',
      fireAt: h.clock.now().toISOString(),
    });
    expect(h.probes.runtime).toHaveBeenCalledTimes(1);
    finish();
    await flush();
    expect(admitted).not.toHaveBeenCalled();
    await h.advance(10_000);
    expect(admitted).toHaveBeenCalledTimes(1);
  });

  it('usage outage is degraded with fallback budgets and does not pause dispatch', async () => {
    const h = setup();
    await h.runners.start(startWorkflow());
    await h.fail('usage');
    await h.health.waitUntilDispatchable();
    expect(h.health.snapshot().status).toBe('degraded');
    expect(h.health.snapshot().usage.detail).toContain('wall-clock');
    expect(h.store.read({}).some((e) => e.type === 'workflow.paused')).toBe(
      false,
    );
    await h.advance(10_000);
    expect(h.health.snapshot().status).toBe('healthy');
  });

  it('reports nearest-rank p50/p95, failure ratio and five-minute eviction, without raw errors', async () => {
    const h = setup();
    for (let duration = 1; duration <= 20; duration++) {
      const started = h.clock.now().getTime();
      h.clock.advance(duration);
      await h.health.record(
        'runtime',
        started,
        duration % 2 === 0 ? 'permanent' : undefined,
      );
    }
    const view = HealthViewSchema.parse(h.health.snapshot());
    expect(view.adapters[0]).toMatchObject({
      calls: 20,
      failures: 10,
      p50Ms: 10,
      p95Ms: 19,
      failureRate: 0.5,
      lastErrorCategory: 'permanent',
    });
    h.clock.advance(300_000);
    expect(h.health.snapshot().adapters[0]).toMatchObject({
      calls: 0,
      failures: 0,
      p50Ms: 0,
      p95Ms: 0,
      failureRate: 0,
    });
  });

  it('keeps memory blocking when the store fails, then flushes health events after recovery', async () => {
    const h = setup();
    await h.runners.start(startWorkflow());
    const append = vi.spyOn(h.store, 'append').mockImplementation(() => {
      throw transient();
    });
    await h.fail('store');
    expect(h.health.dispatchBlocked).toBe(true);
    append.mockRestore();
    await h.advance(10_000);
    expect(
      h.store.read({}).filter((e) => e.type === 'health.changed'),
    ).toHaveLength(3);
    expect(
      h.store.read({}).filter((e) => e.type === 'workflow.paused'),
    ).toHaveLength(1);
    expect(
      h.store.read({}).filter((e) => e.type === 'workflow.resumed'),
    ).toHaveLength(1);
  });

  it('counts retries, keeps the fifth failed attempt pending and retries identical args after recovery', async () => {
    const handler = vi
      .fn()
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(transient())
      .mockResolvedValue({});
    const h = setup({ 'runtime.stop': handler });
    await h.fail('runtime', 3);
    const result = vi.fn();
    void h.executor.execute(issued).then(result);
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);
    await h.advance(1_000);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(h.health.dispatchBlocked).toBe(true);
    expect(result).not.toHaveBeenCalled();
    await h.advance(10_000);
    expect(result).toHaveBeenCalledWith({
      ok: true,
      attempts: 3,
      result: { kind: 'runtime.stop', result: {} },
    });
    expect(
      handler.mock.calls.every((call) => call[0] === issued.command.args),
    ).toBe(true);
    expect(h.health.snapshot().adapters[0]?.calls).toBe(7); // three seed failures + three attempts + probe
  });

  it('holds new commands across systems without consuming retry budgets', async () => {
    const handler = vi.fn(async () => ({}));
    const h = setup({ 'runtime.stop': handler });
    await h.fail('scm');
    const result = h.executor.execute(issued);
    await flush();
    expect(handler).not.toHaveBeenCalled();
    await h.advance(10_000);
    expect(await result).toMatchObject({ ok: true, attempts: 1 });
  });
  it('leaves runner outbox commands issued without failed events or exception gates through an outage', async () => {
    const handler = vi
      .fn()
      .mockRejectedValueOnce(transient())
      .mockResolvedValue({});
    const h = setup({ 'runtime.stop': handler }, (_state, event) =>
      event.type === 'workflow.started'
        ? [
            {
              kind: 'external',
              commandId: issued.commandId,
              command: issued.command,
            },
          ]
        : [],
    );
    await h.fail('runtime', 4);
    await h.runners.start(startWorkflow());
    await flush();
    expect(h.runners.get('wf-1')?.state.commands['cmd-1']?.status).toBe(
      'issued',
    );
    expect(h.runners.get('wf-1')?.state.workflow?.pausedReasons).toContain(
      'runtime_unhealthy',
    );
    expect(
      h.store
        .read({})
        .filter((e) => e.type === 'command.failed' || e.type === 'gate.opened'),
    ).toEqual([]);
    await h.advance(10_000);
    await h.runners.idle();
    expect(
      h.store.read({}).filter((e) => e.type === 'command.succeeded'),
    ).toHaveLength(1);
    expect(
      h.store.read({}).filter((e) => e.type === 'workflow.resumed'),
    ).toHaveLength(1);
  });
  it('pauses a workflow created while a required breaker is already open', async () => {
    const handler = vi.fn(async () => ({}));
    const h = setup({ 'runtime.stop': handler }, (_state, event) =>
      event.type === 'workflow.started'
        ? [
            {
              kind: 'external',
              commandId: issued.commandId,
              command: issued.command,
            },
          ]
        : [],
    );
    await h.fail('scm');
    await h.runners.start(startWorkflow());
    await flush();
    expect(h.runners.get('wf-1')?.state.workflow?.pausedReasons).toContain(
      'scm_unhealthy',
    );
    expect(handler).not.toHaveBeenCalled();
    await h.advance(10_000);
    await h.runners.idle();
  });
  it('restores durable unhealthy pauses and requires a probe before resuming them', async () => {
    const h = setup();
    await h.runners.start(startWorkflow());
    await h.runners.dispatch('wf-1', {
      type: 'PauseWorkflow',
      reason: 'runtime_unhealthy',
      meta: { occurredAt: h.clock.now().toISOString(), source: 'system' },
    });
    await h.health.restore();
    expect(h.health.dispatchBlocked).toBe(true);
    expect(
      h.store.read({}).filter((e) => e.type === 'workflow.resumed'),
    ).toHaveLength(0);
    await h.advance(10_000);
    expect(h.health.dispatchBlocked).toBe(false);
    expect(
      h.store.read({}).filter((e) => e.type === 'workflow.resumed'),
    ).toHaveLength(1);
  });

  describe('initial publication (FX5)', () => {
    const healthEvents = (store: InMemoryEventStore) =>
      store
        .read({})
        .filter((e) => e.type === 'health.changed')
        .map((e) => e.payload);
    const projected = (store: InMemoryEventStore) =>
      store.read({}).reduce(evolveGlobal, initialGlobalReadModel('fake'))
        .health;

    it('publishes every healthy component and runtimeVerified, so the projection shows no banners', async () => {
      const h = setup();
      await h.health.runtimeIdentityVerified(true);
      expect(healthEvents(h.store)).toEqual([]);
      await h.health.publishInitial();
      expect(healthEvents(h.store)).toEqual([
        {
          component: 'runtime',
          status: 'healthy',
          breaker: 'closed',
          runtimeVerified: true,
        },
        { component: 'scm', status: 'healthy', breaker: 'closed' },
        { component: 'store', status: 'healthy', breaker: 'closed' },
        { component: 'usage', status: 'healthy', breaker: 'closed' },
      ]);
      for (const probe of Object.values(h.probes))
        expect(probe).toHaveBeenCalledTimes(1);
      const view = projected(h.store);
      expect(view.status).toBe('healthy');
      for (const component of ['runtime', 'scm', 'store', 'usage'] as const) {
        expect(view[component].status).toBe('healthy');
        expect(view[component].checkedAt).toBe(h.clock.now().toISOString());
      }
      expect(view.runtime.verified).toBe(true);
    });

    it('does not republish an unchanged state after a restart', async () => {
      const first = setup();
      await first.health.runtimeIdentityVerified(true);
      await first.health.publishInitial();
      const restarted = setup(undefined, undefined, first.store);
      await restarted.health.restore();
      await restarted.health.runtimeIdentityVerified(true);
      await restarted.health.publishInitial();
      await restarted.health.runtimeIdentityVerified(true);
      expect(healthEvents(restarted.store)).toHaveLength(4);
      // A changed verdict is published once.
      await restarted.health.runtimeIdentityVerified(false);
      await restarted.health.runtimeIdentityVerified(false);
      expect(healthEvents(restarted.store).slice(4)).toEqual([
        {
          component: 'runtime',
          status: 'healthy',
          breaker: 'closed',
          runtimeVerified: false,
        },
      ]);
      expect(projected(restarted.store).runtime.verified).toBe(false);
    });

    it('corrects a stale persisted outage on restart', async () => {
      const first = setup();
      await first.health.publishInitial();
      await first.fail('scm');
      expect(projected(first.store).scm.status).toBe('unhealthy');
      const restarted = setup(undefined, undefined, first.store);
      await restarted.health.publishInitial();
      expect(healthEvents(restarted.store).at(-1)).toEqual({
        component: 'scm',
        status: 'healthy',
        breaker: 'closed',
      });
      expect(projected(restarted.store).status).toBe('healthy');
    });

    it('publishes a failed initial probe as degraded, then healthy on the next success', async () => {
      const h = setup();
      h.probes.scm.mockRejectedValueOnce(transient());
      await h.health.publishInitial();
      expect(projected(h.store).scm.status).toBe('degraded');
      expect(h.health.dispatchBlocked).toBe(false);
      await h.health.record('scm', h.clock.now().getTime());
      await h.health.record('scm', h.clock.now().getTime());
      expect(
        healthEvents(h.store).filter((p) => p.component === 'scm'),
      ).toEqual([
        { component: 'scm', status: 'degraded', breaker: 'closed' },
        { component: 'scm', status: 'healthy', breaker: 'closed' },
      ]);
    });

    it('publishes a hung initial probe as degraded after its timeout and still finishes startup', async () => {
      const h = setup(undefined, undefined, undefined, 20);
      h.probes.scm.mockImplementationOnce(() => new Promise<void>(() => {}));
      await h.health.publishInitial();
      expect(healthEvents(h.store)).toEqual([
        { component: 'runtime', status: 'healthy', breaker: 'closed' },
        { component: 'scm', status: 'degraded', breaker: 'closed' },
        { component: 'store', status: 'healthy', breaker: 'closed' },
        { component: 'usage', status: 'healthy', breaker: 'closed' },
      ]);
      const scm = h.health.snapshot().adapters.find((a) => a.adapter === 'scm');
      expect(scm).toMatchObject({
        failures: 1,
        lastErrorCategory: 'transient',
      });
      expect(h.health.dispatchBlocked).toBe(false);
    });

    it('re-opens the breaker when the half-open probe hangs', async () => {
      const h = setup(undefined, undefined, undefined, 20);
      await h.fail('runtime');
      h.probes.runtime.mockImplementationOnce(
        () => new Promise<void>(() => {}),
      );
      h.clock.advance(10_000);
      h.scheduler.runDue();
      await vi.waitFor(() => {
        expect(h.probes.runtime).toHaveBeenCalledTimes(1);
        expect(
          h.store
            .read({})
            .filter(
              (e) =>
                e.type === 'health.changed' &&
                e.payload.component === 'runtime',
            )
            .map((e) => e.type === 'health.changed' && e.payload.breaker),
        ).toEqual(['open', 'half_open', 'open']);
      });
      expect(h.health.dispatchBlocked).toBe(true);
    });

    it('still publishes a breaker trip as unhealthy (degraded for usage) after the initial publication', async () => {
      const h = setup();
      await h.health.runtimeIdentityVerified(true);
      await h.health.publishInitial();
      await h.fail('runtime');
      await h.fail('usage');
      expect(healthEvents(h.store).slice(4)).toEqual([
        {
          component: 'runtime',
          status: 'unhealthy',
          breaker: 'open',
          runtimeVerified: true,
        },
        { component: 'usage', status: 'degraded', breaker: 'open' },
      ]);
      const view = projected(h.store);
      expect(view.runtime.status).toBe('unhealthy');
      expect(view.usage.status).toBe('degraded');
      expect(view.status).toBe('unhealthy');
    });
  });
});
