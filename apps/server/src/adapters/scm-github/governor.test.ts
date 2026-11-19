import { describe, expect, it } from 'vitest';
import { GithubGovernor } from './governor.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const clock = { now: () => new Date(now) };
  const waits: { until: number; resolve: () => void }[] = [];
  const governor = new GithubGovernor(
    clock,
    (ms) =>
      new Promise<void>((resolve) => waits.push({ until: now + ms, resolve })),
  );
  const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  const advance = async (ms: number) => {
    now += ms;
    const due = waits.filter((w) => w.until <= now);
    for (const wait of due) {
      waits.splice(waits.indexOf(wait), 1);
      wait.resolve();
    }
    await flush();
  };
  return { governor, clock, advance, flush, waits };
}

describe('GitHub governor scheduling', () => {
  it('caps reads at four, hands slots to queued reads, and releases after failure', async () => {
    const f = setup();
    let active = 0,
      maximum = 0;
    const starts: number[] = [];
    const gates = Array.from({ length: 8 }, () => deferred<void>());
    const requests = gates.map((gate, index) =>
      f.governor
        .run('read', false, async () => {
          starts.push(index);
          maximum = Math.max(maximum, ++active);
          try {
            await gate.promise;
            return index;
          } finally {
            active--;
          }
        })
        .catch(() => -1),
    );
    await f.flush();
    expect(starts).toEqual([0, 1, 2, 3]);
    gates[0]!.reject(new Error('network failure'));
    await f.flush();
    expect(starts).toEqual([0, 1, 2, 3, 4]);
    for (const gate of gates) gate.resolve();
    expect(await Promise.all(requests)).toEqual([-1, 1, 2, 3, 4, 5, 6, 7]);
    expect(maximum).toBe(4);
    expect(active).toBe(0);
  });
  it('serializes writes, spaces starts by one second, and keeps reads independent', async () => {
    const f = setup(),
      first = deferred<void>();
    const starts: number[] = [];
    const a = f.governor.run('write', false, async () => {
      starts.push(f.clock.now().getTime());
      await first.promise;
    });
    const b = f.governor.run('write', false, async () => {
      starts.push(f.clock.now().getTime());
    });
    await f.flush();
    await f.advance(500);
    expect(starts).toHaveLength(1);
    expect(await f.governor.run('read', false, async () => 42)).toBe(42);
    first.resolve();
    await f.flush();
    await f.advance(499);
    expect(starts).toHaveLength(1);
    await f.advance(1);
    await Promise.all([a, b]);
    expect(starts[1]! - starts[0]!).toBe(1000);
  });
  it('does not overlap a slow write even when the spacing interval has elapsed', async () => {
    const f = setup(),
      gate = deferred<void>();
    let count = 0;
    const first = f.governor.run('write', false, async () => {
      count++;
      await gate.promise;
    });
    const second = f.governor.run('write', false, async () => {
      count++;
    });
    await f.flush();
    await f.advance(2000);
    expect(count).toBe(1);
    gate.resolve();
    await Promise.all([first, second]);
    expect(count).toBe(2);
  });
  it('continues the write queue after failure without skipping its spacing budget', async () => {
    const f = setup();
    const first = f.governor
      .run('write', false, async () => {
        throw new Error('failed');
      })
      .catch(() => undefined);
    let ran = false;
    const second = f.governor.run('write', false, async () => {
      ran = true;
    });
    await f.flush();
    expect(ran).toBe(false);
    await f.advance(1000);
    await Promise.all([first, second]);
    expect(ran).toBe(true);
  });
  it('allows twenty content creations in a rolling minute, including failed attempts', async () => {
    const f = setup();
    const starts: number[] = [];
    const requests = Array.from({ length: 21 }, (_, i) =>
      f.governor
        .run('write', true, async () => {
          starts.push(f.clock.now().getTime());
          if (i === 0) throw new Error('ambiguous creation');
        })
        .catch(() => undefined),
    );
    await f.flush();
    for (let i = 0; i < 19; i++) await f.advance(1000);
    expect(starts).toHaveLength(20);
    await f.advance(40999);
    expect(starts).toHaveLength(20);
    await f.advance(1);
    await Promise.all(requests);
    expect(starts[20]! - starts[0]!).toBe(60000);
  });
  it('does not spend the content budget on ordinary writes', async () => {
    const f = setup();
    let count = 0;
    const requests = Array.from({ length: 21 }, () =>
      f.governor.run('write', false, async () => {
        count++;
      }),
    );
    await f.flush();
    for (let i = 0; i < 20; i++) await f.advance(1000);
    await Promise.all(requests);
    expect(count).toBe(21);
  });
  it('rejects queued reads after secondary throttling, but allows writes', async () => {
    const f = setup(),
      gate = deferred<void>();
    const first = Array.from({ length: 4 }, () =>
      f.governor.run('read', false, () => gate.promise),
    );
    let ran = false;
    const queued = f.governor
      .run('read', false, async () => {
        ran = true;
      })
      .catch((error) => error as unknown);
    f.governor.failure(429, new Headers({ 'retry-after': '10' }), '', 'read');
    gate.resolve();
    await Promise.all(first);
    expect(await queued).toMatchObject({
      category: 'rate_limited',
      retryAfterMs: 10000,
    });
    expect(ran).toBe(false);
    expect(await f.governor.run('write', false, async () => 42)).toBe(42);
    await f.advance(10000);
    expect(await f.governor.run('read', false, async () => 42)).toBe(42);
  });
  it('checks cooldown again after a queued write wakes from its spacing timer', async () => {
    const f = setup();
    await f.governor.run('write', false, async () => undefined);
    let ran = false;
    const next = f.governor
      .run('write', false, async () => {
        ran = true;
      })
      .catch((error) => error as unknown);
    await f.flush();
    f.governor.failure(429, new Headers({ 'retry-after': '30' }), '', 'write');
    await f.advance(1000);
    expect(await next).toMatchObject({
      category: 'rate_limited',
      retryAfterMs: 29000,
    });
    expect(ran).toBe(false);
  });
  it('reports polling thresholds, rate-limit degradation and server clock offset', () => {
    const f = setup();
    f.governor.observe(
      new Headers({
        'x-ratelimit-remaining': '999',
        date: 'Thu, 01 Jan 2026 00:00:05 GMT',
      }),
    );
    expect(f.governor.snapshot()).toMatchObject({
      pollIntervalMs: 60000,
      criticalReadsOnly: false,
      clockOffsetMs: 5000,
      warnings: ['rate_limit_low'],
    });
    f.governor.observe(new Headers({ 'x-ratelimit-remaining': '199' }));
    expect(f.governor.snapshot()).toMatchObject({
      status: 'degraded',
      criticalReadsOnly: true,
    });
  });
});

describe('GitHub quota and concurrent cooldowns', () => {
  it('pauses both classes after a successful response exhausts the primary budget', async () => {
    const f = setup();
    f.governor.observe(
      new Headers({
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(f.clock.now().getTime() / 1000 + 30),
      }),
    );
    for (const kind of ['read', 'write'] as const)
      await expect(
        f.governor.run(kind, false, async () => undefined),
      ).rejects.toMatchObject({
        category: 'rate_limited',
        retryAfterMs: 30000,
      });
    await f.advance(30000);
    await expect(f.governor.run('read', false, async () => 42)).resolves.toBe(
      42,
    );
  });
  it('never shortens a cooldown when concurrent responses arrive out of order', async () => {
    const f = setup();
    f.governor.failure(429, new Headers({ 'retry-after': '60' }), '', 'read');
    await f.advance(1000);
    expect(
      f.governor.failure(429, new Headers({ 'retry-after': '1' }), '', 'read'),
    ).toMatchObject({ retryAfterMs: 59000 });
    await expect(
      f.governor.run('read', false, async () => undefined),
    ).rejects.toMatchObject({ retryAfterMs: 59000 });
  });
  it('uses server Date to honor primary reset despite a local clock offset', () => {
    const f = setup();
    const headers = new Headers({
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(f.clock.now().getTime() / 1000 + 70),
      date: 'Thu, 01 Jan 2026 00:00:10 GMT',
    });
    f.governor.observe(headers);
    expect(f.governor.failure(403, headers, '', 'read')).toMatchObject({
      retryAfterMs: 60000,
    });
  });
  it('ignores malformed numeric headers rather than creating infinite cooldowns', () => {
    const f = setup();
    f.governor.observe(
      new Headers({
        'x-ratelimit-remaining': '9'.repeat(400),
        'x-ratelimit-reset': '9'.repeat(400),
      }),
    );
    expect(f.governor.snapshot()).toMatchObject({
      remaining: undefined,
      resetAt: undefined,
    });
    const headers = new Headers({
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '9'.repeat(400),
    });
    f.governor.observe(headers);
    expect(f.governor.failure(403, headers, '', 'read')).toMatchObject({
      retryAfterMs: 60000,
    });
  });
});

describe('GitHub interleaved counters and recovery', () => {
  it('uses a monotonic minimum until the active reset window expires', async () => {
    const f = setup();
    const start = f.clock.now().getTime() / 1000;
    const headers = (remaining: number, reset: number) =>
      new Headers({
        'x-ratelimit-remaining': String(remaining),
        'x-ratelimit-reset': String(start + reset),
      });
    f.governor.observe(headers(190, 60));
    f.governor.observe(headers(4000, 60));
    f.governor.observe(headers(4900, 65));
    expect(f.governor.snapshot()).toMatchObject({
      remaining: 190,
      criticalReadsOnly: true,
      resetAt: (start + 65) * 1000,
    });
    await f.advance(65000);
    f.governor.observe(headers(4999, 3600));
    expect(f.governor.snapshot()).toMatchObject({
      remaining: 4999,
      criticalReadsOnly: false,
      status: 'healthy',
    });
    f.governor.observe(headers(0, 60));
    expect(f.governor.snapshot()).toMatchObject({
      remaining: 4999,
      retryAfterMs: 0,
    });
  });
  it('resets secondary fallback after a clean response, without cancelling active cooldown', async () => {
    const f = setup();
    expect(f.governor.failure(429, new Headers(), '', 'read')).toMatchObject({
      retryAfterMs: 60000,
    });
    await f.advance(60000);
    expect(f.governor.failure(429, new Headers(), '', 'read')).toMatchObject({
      retryAfterMs: 120000,
    });
    f.governor.success();
    expect(f.governor.snapshot().retryAfterMs).toBe(120000);
    await f.advance(120000);
    expect(f.governor.failure(429, new Headers(), '', 'read')).toMatchObject({
      retryAfterMs: 60000,
    });
  });
  it('corrects HTTP-date Retry-After and health reset timestamps for clock offset', () => {
    const f = setup();
    f.governor.observe(
      new Headers({
        date: 'Thu, 01 Jan 2026 00:00:10 GMT',
        'x-ratelimit-reset': String(f.clock.now().getTime() / 1000 + 70),
      }),
    );
    expect(
      f.governor.failure(
        429,
        new Headers({ 'retry-after': 'Thu, 01 Jan 2026 00:00:30 GMT' }),
        '',
        'read',
      ),
    ).toMatchObject({ retryAfterMs: 20000 });
    expect(f.governor.snapshot().resetAt).toBe(f.clock.now().getTime() + 60000);
  });
});

it('honors the longer deadline when primary reset and Retry-After are both present', () => {
  const f = setup();
  const headers = new Headers({
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': String(f.clock.now().getTime() / 1000 + 10),
    'retry-after': '60',
  });
  f.governor.observe(headers);
  expect(f.governor.failure(403, headers, '', 'read')).toMatchObject({
    code: 'primary_rate_limit',
    retryAfterMs: 60000,
  });
  expect(f.governor.snapshot().retryAfterMs).toBe(60000);
});
