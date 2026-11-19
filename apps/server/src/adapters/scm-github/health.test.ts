import { describe, expect, it } from 'vitest';
import { HealthMonitor } from '../../application/health/health-monitor.js';
import { InMemoryEventStore } from '../../test-support/stores.js';
import { FakeClock, ManualScheduler } from '../../test-support/services.js';
import { createGithubScm, RepoAllowlist, viewerSchema } from './index.js';

describe('GitHub rate limits and the application breaker', () => {
  it.each([403, 429])(
    'never opens the breaker after repeated %s throttles',
    async (status) => {
      const clock = new FakeClock();
      const store = new InMemoryEventStore(clock);
      const scheduler = new ManualScheduler(clock, () => {});
      const health = new HealthMonitor({
        clock,
        store,
        scheduler,
        probes: {
          runtime: async () => {},
          scm: async () => {},
          store: async () => {},
          usage: async () => {},
        },
        workflows: () => [],
        runtime: { mode: 'fake', verified: true },
      });
      const scm = createGithubScm({
        clock,
        tokenProvider: async () => 'test',
        repoAllowlist: new RepoAllowlist(),
        maskSecrets: (value) => value,
        fetch: async () =>
          new Response(JSON.stringify({ message: 'secondary rate limit' }), {
            status,
            headers: { 'retry-after': '10' },
          }),
      });
      for (let i = 0; i < 10; i++) {
        await expect(
          health.call('scm', () =>
            scm.http.request('user.get', {}, { schema: viewerSchema }),
          ),
        ).rejects.toMatchObject({
          category: 'rate_limited',
          retryAfterMs: 10000,
        });
        expect(health.snapshot().scm.breaker).toBe('closed');
        expect(scm.diagnostics().rateLimit.status).toBe('degraded');
        clock.advance(10000);
      }
      expect(
        store
          .read({})
          .filter(
            (e) => e.type === 'health.changed' && e.payload.breaker === 'open',
          ),
      ).toEqual([]);
    },
  );
});
