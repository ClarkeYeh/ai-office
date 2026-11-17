import { describe, expect, it } from 'vitest';
import {
  eventStoreContract,
  projectionStoreContract,
  seatTokenStoreContract,
} from './contracts.js';
import {
  InMemoryEventStore,
  InMemoryProjectionStore,
  InMemorySeatTokenStore,
  InMemorySessionStore,
  InMemoryIdempotencyStore,
} from './stores.js';
import { FakeClock } from './services.js';
eventStoreContract(() => ({ store: new InMemoryEventStore() }));
projectionStoreContract(() => ({ store: new InMemoryProjectionStore() }));
seatTokenStoreContract(() => {
  const store = new InMemorySeatTokenStore();
  return { store, storedHashes: () => store.snapshot() };
});
describe('security store helpers', () => {
  it('consumes bootstrap exactly once, checks expiry boundaries and stores no raw secrets', () => {
    const clock = new FakeClock(),
      store = new InMemorySessionStore(clock),
      code = store.issueBootstrapCode();
    expect(JSON.stringify(store.snapshot())).not.toContain(code);
    clock.advance(59_999);
    const session = store.exchangeBootstrapCode(code)!;
    expect(session).toMatch(/^aio_session_/);
    expect(store.exchangeBootstrapCode(code)).toBeNull();
    expect(store.verify(session)).toBe(true);
    expect(JSON.stringify(store.snapshot())).not.toContain(session);
    clock.advance(30 * 24 * 60 * 60 * 1000);
    expect(store.verify(session)).toBe(false);
    const expired = store.issueBootstrapCode();
    clock.advance(60_000);
    expect(store.exchangeBootstrapCode(expired)).toBeNull();
    const fresh = store.exchangeBootstrapCode(store.issueBootstrapCode())!;
    store.revoke(fresh);
    expect(store.verify(fresh)).toBe(false);
    expect(store.verify('unknown')).toBe(false);
  });
  it('scopes idempotency, protects the first response, rejects mismatches and expires records', () => {
    const clock = new FakeClock(),
      store = new InMemoryIdempotencyStore(clock);
    const record = {
      requestHash: 'a',
      response: { status: 201, body: { id: 1 } },
      expiresAt: '2026-01-01T00:00:01.000Z',
    };
    store.put('a', 'key', record);
    record.response.status = 500;
    store.put('a', 'key', record);
    expect(store.get('a', 'key')?.response.status).toBe(201);
    expect(store.get('b', 'key')).toBeNull();
    expect(() =>
      store.put('a', 'key', { ...record, requestHash: 'b' }),
    ).toThrow();
    clock.advance(1000);
    expect(store.get('a', 'key')).toBeNull();
    store.put('a', 'key', {
      ...record,
      requestHash: 'b',
      expiresAt: '2026-01-01T00:00:02.000Z',
    });
    expect(store.get('a', 'key')?.requestHash).toBe('b');
  });
});
