import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openSqliteStores } from './index.js';
import { FakeClock, SeqIdGen } from '../../test-support/services.js';
import { MemoryAdapterStateStore } from '../../test-support/adapter-state.js';
import { eventDraft } from '../../test-support/contracts.js';
import type { AdapterStateStore } from '../../ports/stores.js';

function roundTrip(store: AdapterStateStore) {
  expect(store.read('missing')).toBeNull();
  const value = { shim: 'synthetic-shim', nested: [1, 2] };
  store.write('orca:shim', value);
  value.nested.push(3);
  expect(store.read('orca:shim')).toEqual({
    shim: 'synthetic-shim',
    nested: [1, 2],
  });
  const read = store.read('orca:shim') as typeof value;
  read.nested.push(4);
  expect(store.read('orca:shim')).not.toEqual(read);
  store.write('orca:shim', { shim: 'replacement' });
  expect(store.read('orca:shim')).toEqual({ shim: 'replacement' });
  expect(() => store.write('orca:shim', undefined)).toThrow(TypeError);
  expect(store.read('orca:shim')).toEqual({ shim: 'replacement' });
  store.write('null', null);
  expect(store.read('null')).toBeNull();
}

describe('AdapterStateStore', () => {
  it('round trips and isolates in-memory state', () =>
    roundTrip(new MemoryAdapterStateStore()));
  it('persists namespaced state without events and coexists with atomic ingestion', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aio-adapter-state-'));
    const options = {
      filename: join(directory, 'state.db'),
      clock: new FakeClock(),
      ids: new SeqIdGen(),
      projectionVersion: 1,
    };
    let stores = openSqliteStores(options);
    try {
      const notifications: unknown[] = [];
      stores.events.subscribe((event) => notifications.push(event));
      expect(() => stores.adapterState(' ')).toThrow(TypeError);
      const state = stores.adapterState('orca');
      roundTrip(state);
      stores.adapterState('other').write('orca:shim', 'other');
      expect(stores.events.lastSeq()).toBe(0);
      expect(notifications).toEqual([]);
      expect(stores.events.readCursor('adapter.orca', 'orca:shim')).toEqual({
        shim: 'replacement',
      });
      stores.events.append([eventDraft('ingested')], {
        cursors: [{ source: 'runtime', scope: 'orca:shim', value: 'cursor' }],
      });
      state.write('ledger', { pending: ['command'] });
      expect(stores.events.lastSeq()).toBe(1);
      expect(notifications).toHaveLength(1);
      expect(() =>
        stores.events.append([eventDraft('bad')], {
          cursors: [
            { source: 'runtime', scope: 'orca:shim', value: undefined },
          ],
        }),
      ).toThrow();
      expect(stores.events.lastSeq()).toBe(1);
      expect(stores.events.readCursor('runtime', 'orca:shim')).toBe('cursor');
      stores.close();
      stores = openSqliteStores(options);
      expect(stores.adapterState('orca').read('orca:shim')).toEqual({
        shim: 'replacement',
      });
      expect(stores.adapterState('orca').read('ledger')).toEqual({
        pending: ['command'],
      });
      expect(stores.adapterState('other').read('orca:shim')).toBe('other');
      expect(stores.events.lastSeq()).toBe(1);
    } finally {
      stores.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
