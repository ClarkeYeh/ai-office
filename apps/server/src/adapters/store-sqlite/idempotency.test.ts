import Database from 'better-sqlite3';
import { ProcessGroups, SpawnExec } from '../runtime-orca/cli/process.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DomainEventDraft } from '@ai-office/contracts/events';
import type { IdempotencyWrite } from '../../ports/stores.js';
import { eventDraft } from '../../test-support/contracts.js';
import { FakeClock, SeqIdGen } from '../../test-support/services.js';
import { InMemoryEventStore } from '../../test-support/stores.js';
import {
  openSqliteStores,
  SqliteEventStore,
  SqliteIdempotencyStore,
} from './index.js';
import { migrate } from './migrations/index.js';

const write: IdempotencyWrite = {
  scope: 'gate:g',
  key: 'key',
  record: {
    requestHash: 'hash',
    response: { status: 200, body: { gateId: 'g' } },
    expiresAt: '2026-12-01T00:00:00.000Z',
  },
};
const paths: string[] = [];
const close: (() => void)[] = [];
afterEach(() => {
  for (const dispose of close.splice(0)) dispose();
  for (const path of paths.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const options = (filename: string) => ({
  filename,
  clock: new FakeClock(),
  ids: new SeqIdGen(),
  projectionVersion: 1,
});

for (const kind of ['sqlite', 'memory'] as const) {
  describe(`${kind} atomic idempotency`, () => {
    const setup = () => {
      if (kind === 'memory') {
        const events = new InMemoryEventStore();
        return { events, idempotency: events.idempotency };
      }
      const stores = openSqliteStores(options(':memory:'));
      close.push(stores.close);
      return stores;
    };
    it('publishes only after the record commits, skips whole duplicate batches and rejects mismatches', () => {
      const s = setup();
      const listener = vi.fn(() => s.idempotency.get(write.scope, write.key));
      s.events.subscribe(listener);
      expect(
        s.events.append([eventDraft()], { idempotency: write }),
      ).toHaveLength(1);
      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.results[0]).toEqual({
        type: 'return',
        value: write.record,
      });
      expect(
        s.events.append([eventDraft()], {
          idempotency: write,
          cursors: [{ source: 's', scope: 'x', value: 1 }],
        }),
      ).toEqual([]);
      expect(s.events.readCursor('s', 'x')).toBeNull();
      expect(() =>
        s.events.append([eventDraft()], {
          idempotency: {
            ...write,
            record: { ...write.record, requestHash: 'other' },
          },
        }),
      ).toThrow('Key reused');
      expect(s.events.lastSeq()).toBe(1);
      expect(listener).toHaveBeenCalledOnce();
    });
    it('rolls back events and cursors if the record is invalid, then permits retry', () => {
      const s = setup();
      const listener = vi.fn();
      s.events.subscribe(listener);
      expect(() =>
        s.events.append([eventDraft()], {
          cursors: [{ source: 's', scope: 'x', value: 1 }],
          idempotency: {
            ...write,
            record: { ...write.record, expiresAt: 'invalid' },
          },
        }),
      ).toThrow('Invalid expiry');
      expect(s.events.lastSeq()).toBe(0);
      expect(s.events.readCursor('s', 'x')).toBeNull();
      expect(s.idempotency.get(write.scope, write.key)).toBeNull();
      expect(listener).not.toHaveBeenCalled();
      s.events.append([eventDraft()], { idempotency: write });
      expect(s.events.lastSeq()).toBe(1);
    });
    it('replaces expired records and supports record-only commits', () => {
      const s = setup();
      s.idempotency.put(write.scope, write.key, {
        ...write.record,
        expiresAt: '2020-01-01T00:00:00.000Z',
      });
      expect(s.events.append([], { idempotency: write })).toEqual([]);
      expect(s.idempotency.get(write.scope, write.key)).toEqual(write.record);
    });
  });
}

it('rolls back all events and cursors on a SQLite failure at the idempotency insert', () => {
  const db = new Database(':memory:');
  close.push(() => db.close());
  migrate(db);
  const events = new SqliteEventStore(db, new FakeClock(), new SeqIdGen());
  db.exec(
    "CREATE TRIGGER fail_idempotency BEFORE INSERT ON idempotency_keys BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
  );
  expect(() =>
    events.append([eventDraft()], {
      idempotency: write,
      cursors: [{ source: 's', scope: 'x', value: 1 }],
    }),
  ).toThrow('injected failure');
  expect(events.read({})).toEqual([]);
  expect(events.readCursor('s', 'x')).toBeNull();
  expect(
    new SqliteIdempotencyStore(db, new FakeClock()).get(write.scope, write.key),
  ).toBeNull();
});

it.each(['before-record', 'after-commit'])(
  'recovers after SIGKILL %s without losing or duplicating the batch',
  async (point) => {
    const directory = mkdtempSync(join(tmpdir(), 'aio-idempotency-'));
    paths.push(directory);
    const filename = join(directory, 'store.sqlite');
    const batch: DomainEventDraft[] = [
      {
        ...eventDraft(),
        type: 'gate.decided',
        payload: { gateId: 'g', version: 1, decision: 'approve', by: 'user' },
      },
      {
        ...eventDraft(),
        type: 'command.issued',
        payload: {
          commandId: 'comment-1',
          kind: 'scm.comment',
          args: {
            target: {
              type: 'issue',
              repo: { owner: 'octo', name: 'demo' },
              number: 3,
            },
            body: 'approved',
          },
        },
      },
      {
        ...eventDraft(),
        type: 'command.issued',
        payload: {
          commandId: 'labels-1',
          kind: 'scm.setLabels',
          args: {
            target: {
              type: 'issue',
              repo: { owner: 'octo', name: 'demo' },
              number: 3,
            },
            labels: ['ai-office:approved'],
          },
        },
      },
    ];
    // Load the actual TS adapter in a separate process, without relying on a stale build.
    const script = `
    import { registerHooks } from 'node:module';
    import ts from 'typescript';
    import { existsSync, readFileSync, writeSync } from 'node:fs';
    registerHooks({
      resolve(specifier, context, next) {
        if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {
          const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
          if (existsSync(url)) return { url: url.href, shortCircuit: true };
        }
        return next(specifier, context);
      },
      load(url, context, next) {
        if (url.endsWith('.ts')) return { format: 'module', source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText, shortCircuit: true };
        return next(url, context);
      }
    });
    const { default: Database } = await import('better-sqlite3');
    const { SqliteEventStore } = await import(${JSON.stringify(new URL('./events.ts', import.meta.url).href)});
    const { migrate } = await import(${JSON.stringify(new URL('./migrations/index.ts', import.meta.url).href)});
    const db = new Database(${JSON.stringify(filename)});
    db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL'); migrate(db);
    let id = 0;
    const events = new SqliteEventStore(db, { now: () => new Date('2026-01-01') }, { ulid: () => String(++id).padStart(26, '0') });
    const kill = () => { writeSync(1, 'SIGKILL'); process.kill(process.pid, 'SIGKILL'); };
    if (${JSON.stringify(point)} === 'before-record') {
      db.function('crash', kill);
      db.exec('CREATE TEMP TRIGGER crash_before_record BEFORE INSERT ON idempotency_keys BEGIN SELECT crash(); END');
    } else events.subscribe(kill);
    events.append(${JSON.stringify(batch)}, { idempotency: ${JSON.stringify(write)}, cursors: [{ source: 's', scope: 'x', value: 1 }] });
    process.exit(99);
  `;
    // Reuse the existing subprocess boundary; this runs Node, never the Orca CLI.
    const exec = new SpawnExec(
      new ProcessGroups({ read: () => null, write: () => {} }),
    );
    const child = await exec.run({
      bin: process.execPath,
      args: ['--input-type=module', '-e', script],
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      env: {},
      timeoutMs: 10_000,
    });
    expect(child.stdout).toBe('SIGKILL');
    expect(child.exitCode).toBeNull();
    const s = openSqliteStores(options(filename));
    close.push(s.close);
    const committed = point === 'after-commit';
    expect(s.events.lastSeq()).toBe(committed ? batch.length : 0);
    expect(s.idempotency.get(write.scope, write.key)).toEqual(
      committed ? write.record : null,
    );
    expect(s.events.readCursor('s', 'x')).toBe(committed ? 1 : null);
    s.events.append(batch, { idempotency: write });
    s.events.append(batch, { idempotency: write });
    expect(s.events.read({}).map((e) => e.type)).toEqual([
      'gate.decided',
      'command.issued',
      'command.issued',
    ]);
    expect(s.events.lastSeq()).toBe(batch.length);
    expect(s.idempotency.get(write.scope, write.key)).toEqual(write.record);
  },
);
