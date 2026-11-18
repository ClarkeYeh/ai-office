import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DomainEventDraft } from '@ai-office/contracts/events';
import { DomainEventSchema } from '@ai-office/contracts/events';
import type {
  EventStore,
  ProjectionStore,
  SeatTokenStore,
} from '../ports/stores.js';
export type ContractFixture<T> = {
  store: T;
  dispose?: () => void | Promise<void>;
};
export type ContractFactory<T> = () =>
  ContractFixture<T> | Promise<ContractFixture<T>>;
export const eventDraft = (
  externalKey?: string,
  workflowId: string | null = 'wf',
): DomainEventDraft => ({
  type: 'workflow.resumed',
  payload: { reason: 'auth' },
  workflowId,
  occurredAt: '2026-01-01T00:00:00.000Z',
  schemaVersion: 1,
  source: 'user',
  provenance: 'decided',
  ...(externalKey === undefined ? {} : { externalKey }),
});
export function eventStoreContract(factory: ContractFactory<EventStore>): void {
  describe('EventStore contract', () => {
    let fixture: ContractFixture<EventStore>;
    beforeEach(async () => {
      fixture = await factory();
    });
    afterEach(async () => {
      await fixture.dispose?.();
    });
    it('assigns valid envelopes and deduplicates external keys across and within batches', () => {
      const store = fixture.store;
      expect(store.lastSeq()).toBe(0);
      const events = store.append([
        eventDraft('a'),
        eventDraft('a'),
        eventDraft('b'),
        eventDraft(),
        eventDraft(),
      ]);
      expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
      events.forEach((e) =>
        expect(DomainEventSchema.safeParse(e).success).toBe(true),
      );
      expect(new Set(events.map((e) => e.id)).size).toBe(4);
      expect(store.append([eventDraft('a')])).toEqual([]);
      expect(store.lastSeq()).toBe(4);
    });
    it('reads global, workflow and null-workflow pages in ascending seq order', () => {
      const store = fixture.store;
      store.append([
        eventDraft('a', 'a'),
        eventDraft('b', null),
        eventDraft('c', 'b'),
        eventDraft('d', 'a'),
      ]);
      expect(store.read({ afterSeq: 1, limit: 2 }).map((e) => e.seq)).toEqual([
        2, 3,
      ]);
      expect(
        store
          .read({ workflowId: 'a', afterSeq: 1, limit: 1 })
          .map((e) => e.seq),
      ).toEqual([4]);
      expect(store.read({ workflowId: null }).map((e) => e.seq)).toEqual([2]);
      expect(store.read({ limit: 0 })).toEqual([]);
      expect(store.read({ afterSeq: 4 })).toEqual([]);
    });
    it('commits cursors and all events before notification, even for empty or duplicate batches', () => {
      const store = fixture.store;
      const seen: { seq: number; lastSeq: number; cursor: unknown }[] = [];
      store.subscribe((e) => {
        seen.push({
          seq: e.seq,
          lastSeq: store.lastSeq(),
          cursor: store.readCursor('runtime', 'run'),
        });
      });
      store.append([eventDraft('a'), eventDraft('b')], {
        cursors: [{ source: 'runtime', scope: 'run', value: { next: 2 } }],
      });
      expect(seen).toEqual([
        { seq: 1, lastSeq: 2, cursor: { next: 2 } },
        { seq: 2, lastSeq: 2, cursor: { next: 2 } },
      ]);
      store.append([eventDraft('a')], {
        cursors: [{ source: 'runtime', scope: 'run', value: { next: 3 } }],
      });
      expect(store.readCursor('runtime', 'run')).toEqual({ next: 3 });
      store.append([], {
        cursors: [{ source: 'runtime', scope: 'other', value: 4 }],
      });
      expect(store.readCursor('runtime', 'other')).toBe(4);
      expect(store.readCursor('missing', 'run')).toBeNull();
      expect(store.lastSeq()).toBe(2);
    });
    it('does not publish any part of a rejected batch', () => {
      const store = fixture.store;
      const seen: number[] = [];
      store.subscribe((e) => seen.push(e.seq));
      const bad = { ...eventDraft('bad'), occurredAt: 'invalid' };
      expect(() =>
        store.append([eventDraft('good'), bad], {
          cursors: [{ source: 's', scope: 'x', value: 1 }],
        }),
      ).toThrow();
      expect(store.lastSeq()).toBe(0);
      expect(store.readCursor('s', 'x')).toBeNull();
      expect(seen).toEqual([]);
      expect(store.append([eventDraft('good')])[0]?.seq).toBe(1);
    });
    it('keeps subscriber order through reentrant append, isolates errors and unsubscribes', () => {
      const store = fixture.store,
        seen: number[] = [];
      const stop = store.subscribe((e) => {
        if (e.seq === 1) store.append([eventDraft('c')]);
      });
      store.subscribe(() => {
        throw new Error('listener failed');
      });
      const unsubscribe = store.subscribe((e) => seen.push(e.seq));
      expect(() =>
        store.append([eventDraft('a'), eventDraft('b')]),
      ).not.toThrow();
      expect(seen).toEqual([1, 2, 3]);
      stop();
      unsubscribe();
      unsubscribe();
      store.append([eventDraft('d')]);
      expect(seen).toEqual([1, 2, 3]);
    });
    it('isolates caller and subscriber mutations', () => {
      const store = fixture.store,
        draft = eventDraft('a');
      const cursor = { next: 1 };
      store.subscribe((e) => {
        e.workflowId = 'mutated';
      });
      const result = store.append([draft], {
        cursors: [{ source: 's', scope: 'x', value: cursor }],
      });
      draft.workflowId = 'changed';
      result[0]!.workflowId = 'changed';
      cursor.next = 9;
      const read = store.read({});
      read[0]!.workflowId = 'changed';
      expect(store.read({})[0]?.workflowId).toBe('wf');
      expect(store.readCursor('s', 'x')).toEqual({ next: 1 });
    });
  });
}
export type ContractReadModel = { status: string; nested: { count: number } };
export function projectionStoreContract(
  factory: ContractFactory<ProjectionStore<ContractReadModel>>,
): void {
  describe('ProjectionStore contract', () => {
    let fixture: ContractFixture<ProjectionStore<ContractReadModel>>;
    beforeEach(async () => {
      fixture = await factory();
    });
    afterEach(async () => {
      await fixture.dispose?.();
    });
    it('round trips checkpoints, replaces one workflow and isolates copies', () => {
      const store = fixture.store,
        rm = { status: 'running', nested: { count: 1 } };
      expect(store.load('a')).toBeNull();
      store.save('a', rm, 10, 1);
      store.save('b', rm, 20, 2);
      rm.nested.count = 9;
      expect(store.load('a')).toEqual({
        readModel: { status: 'running', nested: { count: 1 } },
        asOfSeq: 10,
        version: 1,
      });
      store.load('a')!.readModel.nested.count = 99;
      expect(store.load('a')!.readModel.nested.count).toBe(1);
      store.save('a', { status: 'done', nested: { count: 2 } }, 30, 2);
      expect(store.load('a')!.asOfSeq).toBe(30);
      expect(store.load('b')!.asOfSeq).toBe(20);
    });
  });
}
export type SeatTokenFixture = ContractFixture<SeatTokenStore> & {
  storedHashes: () => { hash: string; attemptId: string }[];
};
export function seatTokenStoreContract(
  factory: () => SeatTokenFixture | Promise<SeatTokenFixture>,
): void {
  describe('SeatTokenStore contract', () => {
    let fixture: SeatTokenFixture;
    beforeEach(async () => {
      fixture = await factory();
    });
    afterEach(async () => {
      await fixture.dispose?.();
    });
    it('issues independent secrets once and persists only hashes', () => {
      const a = fixture.store.issue('a'),
        b = fixture.store.issue('b');
      expect(a).toMatch(/^aio_seat_/);
      expect(a).not.toBe(b);
      expect(fixture.store.verify(a)).toBe('a');
      expect(fixture.store.verify(b)).toBe('b');
      expect(fixture.store.verify('invalid')).toBeNull();
      const rows = fixture.storedHashes();
      expect(rows).toHaveLength(2);
      rows.forEach((row) => expect(row.hash).toMatch(/^[a-f0-9]{64}$/));
      expect(JSON.stringify(rows)).not.toContain(a);
      expect(JSON.stringify(rows)).not.toContain(b);
      expect(() => fixture.store.issue('a')).toThrow();
      fixture.store.revoke('a');
      fixture.store.revoke('a');
      expect(fixture.store.verify(a)).toBeNull();
      expect(fixture.store.verify(b)).toBe('b');
      expect(() => fixture.store.issue('a')).toThrow();
    });
  });
}
