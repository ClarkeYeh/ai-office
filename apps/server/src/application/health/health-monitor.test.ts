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
import type { HealthComponent, HealthMonitorDeps } from './health-monitor.js';
import type { ScmHealth } from '../../ports/scm.js';

const transient = () =>
  new PortError('transient', 'unavailable', 'sensitive raw error');
function setup(
  handlers: CommandHandlers = {},
  react: RunnerReact = () => [],
  store = new InMemoryEventStore(),
  probeTimeoutMs?: number,
  extra: Partial<HealthMonitorDeps> = {},
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
    ...extra,
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
    dataDir: '/app/home',
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
    h.probes.store.mockRejectedValueOnce(transient());
    await h.fail('runtime');
    await h.fail('store');
    const admitted = vi.fn();
    void h.health.waitUntilDispatchable('runtime.send').then(admitted);
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
    await h.health.waitUntilDispatchable('runtime.send');
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
    const h = setup({ 'runtime.send': handler });
    await h.fail('store');
    const send: IssuedCommand = {
      ...issued,
      command: {
        kind: 'runtime.send',
        args: { agent: 'agent-1', subject: 's', body: 'b' },
      },
    };
    const result = h.executor.execute(send);
    await flush();
    expect(handler).not.toHaveBeenCalled();
    await h.advance(10_000);
    expect(await result).toMatchObject({ ok: true, attempts: 1 });
  });

  describe('per-component dispatch blocking (S21)', () => {
    const repo = { owner: 'o', name: 'r' };
    const commands = {
      stop: { kind: 'runtime.stop', args: { agent: 'a' } },
      release: {
        kind: 'runtime.release',
        args: { agent: 'a', removeWorkspace: false },
      },
      send: {
        kind: 'runtime.send',
        args: { agent: 'a', subject: 's', body: 'b' },
      },
      label: { kind: 'scm.ensureLabels', args: { repo, labels: [] } },
    } as const satisfies Record<string, IssuedCommand['command']>;
    const blocked = (h: ReturnType<typeof setup>) =>
      Object.fromEntries(
        Object.entries(commands).map(([name, command]) => [
          name,
          h.health.dispatchBlockedFor(command.kind),
        ]),
      );

    it('maps each command kind to the breakers it needs', async () => {
      const scm = setup();
      await scm.fail('scm');
      expect(blocked(scm)).toEqual({
        stop: false,
        release: false,
        send: false,
        label: true,
      });
      const store = setup();
      await store.fail('store');
      expect(blocked(store)).toEqual({
        stop: false,
        release: false,
        send: true,
        label: true,
      });
      const runtime = setup();
      await runtime.fail('runtime');
      expect(blocked(runtime)).toEqual({
        stop: true,
        release: true,
        send: true,
        label: false,
      });
      const usage = setup();
      await usage.fail('usage');
      expect(Object.values(blocked(usage))).not.toContain(true);
    });

    it('sends runtime.stop and runtime.release while the scm breaker is open', async () => {
      const stop = vi.fn(async () => ({}));
      const release = vi.fn(async () => ({}));
      const label = vi.fn(async () => ({}));
      const h = setup({
        'runtime.stop': stop,
        'runtime.release': release,
        'scm.ensureLabels': label,
      });
      await h.runners.start(startWorkflow());
      await h.fail('scm');
      expect(h.runners.get('wf-1')?.state.workflow?.pausedReasons).toEqual([
        'scm_unhealthy',
      ]);
      const run = (command: IssuedCommand['command']) =>
        h.executor.execute({ ...issued, command });
      const scmOutcome = vi.fn();
      void run(commands.label).then(scmOutcome);
      expect(await run(commands.stop)).toMatchObject({ ok: true });
      expect(await run(commands.release)).toMatchObject({ ok: true });
      expect(stop).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
      expect(label).not.toHaveBeenCalled();
      expect(scmOutcome).not.toHaveBeenCalled();
      await h.advance(10_000);
      expect(scmOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true }),
      );
    });

    it('sends runtime.stop while the store breaker is open, but not runtime.send', async () => {
      const stop = vi.fn(async () => ({}));
      const send = vi.fn(async () => ({}));
      const h = setup({ 'runtime.stop': stop, 'runtime.send': send });
      await h.fail('store');
      void h.executor.execute({ ...issued, command: commands.send });
      expect(
        await h.executor.execute({ ...issued, command: commands.stop }),
      ).toMatchObject({ ok: true });
      await flush();
      expect(send).not.toHaveBeenCalled();
    });

    it('keeps a transient scm failure pending on the scm outage only', async () => {
      const label = vi
        .fn()
        .mockRejectedValueOnce(transient())
        .mockResolvedValue({});
      const h = setup({ 'scm.ensureLabels': label });
      await h.fail('scm', 4);
      const outcome = h.executor.execute({
        ...issued,
        command: commands.label,
      });
      await flush();
      expect(h.health.dispatchBlockedFor('scm.ensureLabels')).toBe(true);
      expect(h.health.dispatchBlockedFor('runtime.send')).toBe(false);
      await h.advance(10_000);
      expect(await outcome).toMatchObject({ ok: true, attempts: 2 });
    });

    it('wakes a waiter only once every breaker its kind needs is closed', async () => {
      const send = vi.fn(async () => ({}));
      const h = setup({ 'runtime.send': send });
      h.probes.runtime.mockRejectedValueOnce(transient());
      await h.fail('store');
      await h.fail('runtime');
      const outcome = vi.fn();
      void h.executor
        .execute({ ...issued, command: commands.send })
        .then(outcome);
      await h.advance(10_000);
      expect(h.health.snapshot().store.breaker).toBe('closed');
      expect(outcome).not.toHaveBeenCalled();
      await h.advance(10_000);
      expect(outcome).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true, attempts: 1 }),
      );
    });
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
    const h = setup({ 'scm.ensureLabels': handler }, (_state, event) =>
      event.type === 'workflow.started'
        ? [
            {
              kind: 'external',
              commandId: issued.commandId,
              command: {
                kind: 'scm.ensureLabels',
                args: { repo: { owner: 'o', name: 'r' }, labels: [] },
              },
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

  describe('SCM status, slowdown and the active login (M3-T9)', () => {
    const scmHealth = (remaining: number, extra: Partial<ScmHealth> = {}) => ({
      available: true,
      viewerLogin: 'owner',
      rateLimitRemaining: remaining,
      rateLimitResetAt: '2026-01-01T01:00:00.000Z',
      ...extra,
    });
    const paused = (h: ReturnType<typeof setup>) =>
      h.runners.get('wf-1')?.state.workflow?.pausedReasons;

    it('maps the adapter report into HealthView and publishes degraded below 200', async () => {
      const scmStatus = vi
        .fn<() => Promise<ScmHealth>>()
        .mockResolvedValue(
          scmHealth(4_000, { tokenSource: 'gh', warnings: ['token_reloaded'] }),
        );
      const h = setup({}, () => [], undefined, undefined, { scmStatus });
      await h.health.publishInitial();
      const view = h.health.snapshot();
      expect(view.scm).toMatchObject({
        status: 'healthy',
        login: 'owner',
        tokenSource: 'gh',
        warnings: ['token_reloaded'],
        rateLimit: {
          limit: 5_000,
          remaining: 4_000,
          resetAt: '2026-01-01T01:00:00.000Z',
        },
      });
      expect(HealthViewSchema.safeParse(view).success).toBe(true);
      scmStatus.mockResolvedValue(scmHealth(150));
      await h.advance(60_000);
      expect(h.health.snapshot()).toMatchObject({
        status: 'degraded',
        scm: {
          status: 'degraded',
          breaker: 'closed',
          warnings: ['rate_limit_low'],
        },
      });
      expect(
        h.store
          .read({})
          .filter(
            (e) => e.type === 'health.changed' && e.payload.component === 'scm',
          )
          .map((e) => e.payload),
      ).toEqual([
        { component: 'scm', status: 'healthy', breaker: 'closed' },
        { component: 'scm', status: 'degraded', breaker: 'closed' },
      ]);
      expect(JSON.stringify(h.store.read({}))).not.toContain('token');
    });

    it('smooths the slowdown thresholds with hysteresis', async () => {
      const samples = [
        4_000, 999, 1_050, 1_099, 1_100, 199, 250, 299, 300, 1_099, 1_100,
      ];
      const scmStatus = vi.fn<() => Promise<ScmHealth>>();
      for (const remaining of samples)
        scmStatus.mockResolvedValueOnce(scmHealth(remaining));
      const h = setup({}, () => [], undefined, undefined, { scmStatus });
      await h.health.publishInitial();
      const paces = [h.health.scmPace()];
      for (let i = 1; i < samples.length; i++) {
        await h.advance(60_000);
        paces.push(h.health.scmPace());
      }
      expect(paces).toEqual([
        'normal',
        'slow',
        'slow',
        'slow',
        'normal',
        'critical',
        'critical',
        'critical',
        'slow',
        'slow',
        'normal',
      ]);
    });

    it('pauses with auth while the active login differs and resumes when it matches', async () => {
      const activeLoginProbe = vi.fn(async () => true);
      const h = setup({}, () => [], undefined, undefined, { activeLoginProbe });
      await h.runners.start(startWorkflow());
      await h.advance(5 * 60_000 - 1);
      expect(activeLoginProbe).not.toHaveBeenCalled();
      await h.advance(1);
      expect(activeLoginProbe).toHaveBeenCalledTimes(1);
      expect(paused(h)).toEqual([]);
      activeLoginProbe.mockResolvedValue(false);
      await h.advance(5 * 60_000);
      expect(paused(h)).toEqual(['auth']);
      expect(h.health.snapshot().scm).toMatchObject({
        status: 'degraded',
        breaker: 'closed',
        warnings: ['active_account_mismatch'],
      });
      expect(h.health.dispatchBlockedFor('runtime.stop')).toBe(false);
      // gh unavailable: the verdict stands.
      activeLoginProbe.mockRejectedValueOnce(new Error('gh missing'));
      await h.advance(5 * 60_000);
      expect(paused(h)).toEqual(['auth']);
      activeLoginProbe.mockResolvedValue(true);
      await h.advance(5 * 60_000);
      expect(paused(h)).toEqual([]);
      expect(
        h.store
          .read({})
          .filter((e) => e.type === 'workflow.paused')
          .map((e) => e.payload),
      ).toEqual([{ reason: 'auth', detail: 'active_account_mismatch' }]);
    });

    it('never resumes an auth pause it did not make', async () => {
      const activeLoginProbe = vi.fn(async () => true);
      const h = setup({}, () => [], undefined, undefined, { activeLoginProbe });
      await h.runners.start(startWorkflow());
      await h.runners.dispatch('wf-1', {
        type: 'PauseWorkflow',
        reason: 'auth',
        meta: { occurredAt: h.clock.now().toISOString(), source: 'system' },
      });
      activeLoginProbe.mockResolvedValue(false);
      await h.advance(5 * 60_000);
      activeLoginProbe.mockResolvedValue(true);
      await h.advance(5 * 60_000);
      expect(paused(h)).toEqual(['auth']);
    });

    it('pauses scm_unhealthy once a command is rate limited past five minutes, without holding runtime commands', async () => {
      const rateLimited = () =>
        new PortError(
          'rate_limited',
          'primary_rate_limit',
          'limited',
          true,
          4 * 60_000,
        );
      const label = vi
        .fn()
        .mockRejectedValueOnce(rateLimited())
        .mockRejectedValueOnce(rateLimited())
        .mockResolvedValue({});
      const stop = vi.fn(async () => ({}));
      const h = setup({ 'scm.ensureLabels': label, 'runtime.stop': stop });
      await h.runners.start(startWorkflow());
      const outcome = vi.fn();
      void h.executor
        .execute({
          ...issued,
          command: {
            kind: 'scm.ensureLabels',
            args: { repo: { owner: 'o', name: 'r' }, labels: [] },
          },
        })
        .then(outcome);
      await flush();
      expect(paused(h)).toEqual([]);
      await h.advance(4 * 60_000);
      // The second wait takes the streak past five minutes.
      expect(paused(h)).toEqual(['scm_unhealthy']);
      expect(h.health.snapshot().scm.breaker).toBe('closed');
      expect(await h.executor.execute(issued)).toMatchObject({ ok: true });
      await h.advance(4 * 60_000);
      expect(outcome).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true, attempts: 3 }),
      );
      expect(paused(h)).toEqual([]);
      expect(
        h.store
          .read({})
          .filter((e) => e.type === 'workflow.paused')
          .map((e) => e.payload),
      ).toEqual([{ reason: 'scm_unhealthy', detail: 'rate_limited' }]);
    });
  });
});
