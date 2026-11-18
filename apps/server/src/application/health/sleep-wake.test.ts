import { describe, it, expect, vi } from 'vitest';
import {
  FakeClock,
  ManualScheduler,
  InMemoryEventStore,
} from '../../test-support/index.js';
import { HealthMonitor, HEALTH_TIMER_PREFIX } from './health-monitor.js';

function setup() {
  const clock = new FakeClock();
  let mono = 0;
  const scheduler = new ManualScheduler(clock, () => {});
  const store = new InMemoryEventStore();
  const forceRecheck = vi.fn(async () => {});
  const health = new HealthMonitor({
    clock,
    scheduler,
    store,
    forceRecheck,
    monotonicNow: () => mono,
    workflows: () => [],
    probes: {
      runtime: async () => {},
      scm: async () => {},
      store: async () => {},
      usage: async () => {},
    },
    runtime: { mode: 'orca', verified: true },
  });
  const tick = (ms: number, elapsed = ms) => {
    const timer = {
      id: HEALTH_TIMER_PREFIX + 'clock',
      workflowId: '__health__',
      fireAt: new Date(clock.now().getTime() + 10_000).toISOString(),
    };
    clock.advance(ms);
    mono += elapsed;
    return { timer, run: () => health.onTimer(timer) };
  };
  return { health, forceRecheck, store, tick };
}
describe('sleep/wake health', () => {
  it('rechecks once for a ten-minute jump and publishes only safe details', async () => {
    const h = setup();
    const wake = h.tick(600_000, 10_000);
    await wake.run();
    await wake.run();
    expect(h.forceRecheck).toHaveBeenCalledTimes(1);
    expect(h.health.snapshot().runtime.warnings).toEqual(['host_slept']);
    expect(h.store.read({}).map((e) => e.payload)).toEqual([
      {
        component: 'runtime',
        breaker: 'closed',
        status: 'healthy',
        detail: 'host_slept',
      },
    ]);
    await h.tick(10_000).run();
    expect(h.forceRecheck).toHaveBeenCalledTimes(1);
  });
  it('uses a strict 30-second threshold and detects a delayed tick when both clocks advance', async () => {
    const h = setup();
    await h.tick(40_000, 10_000).run();
    expect(h.forceRecheck).not.toHaveBeenCalled();
    await h.tick(40_001).run();
    expect(h.forceRecheck).toHaveBeenCalledTimes(1);
  });
  it('detects wall/monotonic divergence and ignores deliveries after shutdown', async () => {
    const h = setup();
    await h.tick(10_000, 50_001).run();
    expect(h.forceRecheck).toHaveBeenCalledTimes(1);
    h.health.close();
    await h.tick(600_000).run();
    expect(h.forceRecheck).toHaveBeenCalledTimes(1);
  });
  it('records failed rechecks without an unhandled timer rejection', async () => {
    const h = setup();
    h.forceRecheck.mockRejectedValueOnce(new Error('private message'));
    await h.tick(600_000).run();
    expect(h.health.snapshot().adapters[0]?.failures).toBe(1);
    expect(JSON.stringify(h.store.read({}))).not.toContain('private message');
  });
});
