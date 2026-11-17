import Database from 'better-sqlite3';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  eventDraft,
  eventStoreContract,
  projectionStoreContract,
  seatTokenStoreContract,
  type ContractReadModel,
} from '../../test-support/contracts.js';
import { FakeClock, SeqIdGen } from '../../test-support/services.js';
import {
  openSqliteStores,
  SqliteEventStore,
  SqliteProjectionStore,
  SqliteSeatTokenStore,
  SqliteSessionStore,
} from './index.js';
import { defaultMigrationDirectory, migrate } from './migrations/index.js';
import { upcastEvent, type Upcasters } from './upcasters/index.js';

const connections: Database.Database[] = [];
const directories: string[] = [];
function database(filename = ':memory:') {
  const db = new Database(filename);
  connections.push(db);
  migrate(db);
  return db;
}
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'aio-sqlite-'));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const db of connections.splice(0)) if (db.open) db.close();
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

eventStoreContract(() => ({
  store: new SqliteEventStore(database(), new FakeClock(), new SeqIdGen()),
}));
projectionStoreContract(() => ({
  store: new SqliteProjectionStore<ContractReadModel>(database()),
}));
seatTokenStoreContract(() => {
  const db = database();
  return {
    store: new SqliteSeatTokenStore(db),
    storedHashes: () =>
      db
        .prepare(
          'SELECT hash, attempt_id AS attemptId FROM seat_tokens WHERE revoked = 0',
        )
        .all() as { hash: string; attemptId: string }[],
  };
});

function stores(filename = ':memory:', clock = new FakeClock()) {
  return openSqliteStores<{ status: string }>({
    filename,
    clock,
    ids: new SeqIdGen(),
    projectionVersion: 2,
  });
}

describe('SQLite persistence and transactions', () => {
  it('rolls back already inserted events and cursors on a late SQLite failure', () => {
    const db = database();
    const store = new SqliteEventStore(db, new FakeClock(), new SeqIdGen());
    store.append([eventDraft('existing')], {
      cursors: [{ source: 's', scope: 'x', value: 'old' }],
    });
    db.exec(
      "CREATE TRIGGER fail_cursor BEFORE INSERT ON ingest_cursors WHEN NEW.scope = 'fail' BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );
    const notifications: number[] = [];
    store.subscribe((e) => notifications.push(e.seq));
    expect(() =>
      store.append([eventDraft('new')], {
        cursors: [
          { source: 's', scope: 'x', value: 'new' },
          { source: 's', scope: 'fail', value: 'fail' },
        ],
      }),
    ).toThrow('injected failure');
    expect(store.lastSeq()).toBe(1);
    expect(store.readCursor('s', 'x')).toBe('old');
    expect(store.readCursor('s', 'fail')).toBeNull();
    expect(notifications).toEqual([]);
    expect(store.append([eventDraft('new')])[0]?.seq).toBe(2);
  });

  it('rolls back duplicate event IDs instead of silently dropping unrelated constraint errors', () => {
    const db = database();
    const id = new SeqIdGen().ulid();
    const store = new SqliteEventStore(db, new FakeClock(), { ulid: () => id });
    expect(() => store.append([eventDraft('a'), eventDraft('b')])).toThrow();
    expect(store.read({})).toEqual([]);
  });

  it('persists all stores, revocations and cursor checkpoints across reopen with WAL enabled', () => {
    const filename = join(directory(), 'office.sqlite');
    const clock = new FakeClock();
    let suite = stores(filename, clock);
    const token = suite.seatTokens.issue('attempt');
    const revoked = suite.seatTokens.issue('revoked');
    suite.seatTokens.revoke('revoked');
    const code = suite.sessions.issueBootstrapCode();
    const session = suite.sessions.exchangeBootstrapCode(code)!;
    const unconsumed = suite.sessions.issueBootstrapCode();
    suite.events.append([eventDraft('a')], {
      cursors: [{ source: 'runtime', scope: 'run', value: { next: 2 } }],
    });
    suite.projections.save('wf', { status: 'running' }, 1, 2);
    suite.idempotency.put('request', 'key', {
      requestHash: 'hash',
      response: { status: 201, body: { ok: true } },
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    suite.close();
    suite = stores(filename, clock);
    try {
      expect(suite.backupPath).toBeNull();
      expect(suite.events.lastSeq()).toBe(1);
      expect(suite.events.readCursor('runtime', 'run')).toEqual({ next: 2 });
      expect(suite.events.append([eventDraft('a')])).toEqual([]);
      expect(suite.projections.load('wf')).toEqual({
        readModel: { status: 'running' },
        asOfSeq: 1,
        version: 2,
      });
      expect(suite.seatTokens.verify(token)).toBe('attempt');
      expect(suite.seatTokens.verify(revoked)).toBeNull();
      expect(() => suite.seatTokens.issue('revoked')).toThrow();
      expect(suite.sessions.verify(session)).toBe(true);
      expect(suite.sessions.exchangeBootstrapCode(code)).toBeNull();
      expect(suite.sessions.exchangeBootstrapCode(unconsumed)).toMatch(
        /^aio_session_/,
      );
      expect(suite.idempotency.get('request', 'key')?.response.status).toBe(
        201,
      );
      const reader = new Database(filename);
      connections.push(reader);
      expect(reader.pragma('journal_mode', { simple: true })).toBe('wal');
      for (const file of readdirSync(join(filename, '..'))) {
        const bytes = readFileSync(join(filename, '..', file));
        for (const plaintext of [token, revoked, code, session, unconsumed])
          expect(bytes.includes(Buffer.from(plaintext))).toBe(false);
      }
    } finally {
      suite.close();
    }
  });

  it('makes committed events visible on another connection before notification', () => {
    const filename = join(directory(), 'office.sqlite');
    const suite = stores(filename);
    const reader = database(filename);
    try {
      const seen: unknown[] = [];
      suite.events.subscribe(() =>
        seen.push(reader.prepare('SELECT COUNT(*) AS count FROM events').get()),
      );
      suite.events.append([eventDraft('a'), eventDraft('b')]);
      expect(seen).toEqual([{ count: 2 }, { count: 2 }]);
    } finally {
      suite.close();
    }
  });

  it('returns null for incompatible projection versions until rebuilt', () => {
    const suite = stores();
    try {
      suite.projections.save('wf', { status: 'old' }, 10, 1);
      expect(suite.projections.load('wf')).toBeNull();
      suite.projections.save('wf', { status: 'new' }, 20, 2);
      expect(suite.projections.load('wf')?.asOfSeq).toBe(20);
    } finally {
      suite.close();
    }
  });
});

describe('SQLite migrations', () => {
  it('migrates an empty file, produces a usable backup, and is a no-op at the latest version', () => {
    const filename = join(directory(), 'office.sqlite');
    const suite = stores(filename);
    try {
      expect(suite.backupPath).toBeTruthy();
      const backup = new Database(suite.backupPath!);
      connections.push(backup);
      expect(backup.pragma('user_version', { simple: true })).toBe(0);
      const db = database(filename);
      expect(db.pragma('user_version', { simple: true })).toBe(2);
      expect(migrate(db)).toBeNull();
    } finally {
      suite.close();
    }
  });

  it('upgrades v1 and backs up committed WAL content before changing the schema', () => {
    const filename = join(directory(), 'office.sqlite');
    const db = new Database(filename);
    connections.push(db);
    db.pragma('journal_mode = WAL');
    db.exec(
      readFileSync(
        join(defaultMigrationDirectory(), '0001_event_store.sql'),
        'utf8',
      ),
    );
    db.pragma('user_version = 1');
    const writer = new SqliteEventStore(db, new FakeClock(), new SeqIdGen());
    writer.append([eventDraft('before')]);
    const backupPath = migrate(db)!;
    const backup = new Database(backupPath);
    connections.push(backup);
    expect(backup.pragma('user_version', { simple: true })).toBe(1);
    expect(
      backup.prepare('SELECT COUNT(*) AS count FROM events').get(),
    ).toEqual({ count: 1 });
    expect(() => backup.prepare('SELECT * FROM sessions')).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    expect(writer.read({})[0]?.externalKey).toBe('before');
    expect(db.prepare('SELECT * FROM sessions').all()).toEqual([]);
  });

  it('rolls back schema and user_version if any migration fails and retains the pre-migration backup', () => {
    const path = directory();
    writeFileSync(
      join(path, '0001_good.sql'),
      'CREATE TABLE partial (id INTEGER);',
    );
    writeFileSync(join(path, '0002_bad.sql'), 'THIS IS NOT SQL;');
    const db = new Database(join(path, 'office.sqlite'));
    connections.push(db);
    expect(() => migrate(db, path)).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(0);
    expect(() => db.prepare('SELECT * FROM partial')).toThrow();
    expect(
      readdirSync(path).filter((name) => name.includes('.backup-v0-')),
    ).toHaveLength(1);
  });

  it('rejects future databases and non-contiguous migration sequences', () => {
    const db = database();
    db.pragma('user_version = 3');
    expect(() => migrate(db)).toThrow('newer');
    const path = directory();
    writeFileSync(join(path, '0002_gap.sql'), 'SELECT 1;');
    expect(() => migrate(db, path)).toThrow('gap');
  });
});

describe('event upcasting', () => {
  const registry: Upcasters = {
    'workflow.resumed': {
      currentVersion: 2,
      steps: { 1: () => ({ reason: 'auth' }) },
    },
  };
  it('requires current-version appends and publishes the same event that replay returns', () => {
    const store = new SqliteEventStore(
      database(),
      new FakeClock(),
      new SeqIdGen(),
      registry,
    );
    const seen: unknown[] = [];
    store.subscribe((event) => seen.push(event));
    expect(() => store.append([eventDraft('old')])).toThrow(
      'current schema version',
    );
    expect(store.lastSeq()).toBe(0);
    const result = store.append([
      { ...eventDraft('current'), schemaVersion: 2 },
    ]);
    expect(seen).toEqual(result);
    expect(store.read({})).toEqual(result);
    expect(() => store.read({ limit: -1 })).toThrow(RangeError);
    expect(() => store.read({ afterSeq: 0.5 })).toThrow(RangeError);
  });
  it('upcasts a historical v1 payload to v2 without rewriting the database', () => {
    const db = database();
    const writer = new SqliteEventStore(db, new FakeClock(), new SeqIdGen());
    const event = writer.append([eventDraft('old')])[0]!;
    const legacy = { ...event, payload: { legacyReason: 'login' } };
    db.prepare('UPDATE events SET event_json = ? WHERE seq = ?').run(
      JSON.stringify(legacy),
      event.seq,
    );
    const reader = new SqliteEventStore(
      db,
      new FakeClock(),
      new SeqIdGen(),
      registry,
    );
    expect(reader.read({})[0]).toEqual({
      ...event,
      schemaVersion: 2,
      payload: { reason: 'auth' },
    });
    expect(
      JSON.parse(
        (
          db.prepare('SELECT event_json FROM events').get() as {
            event_json: string;
          }
        ).event_json,
      ),
    ).toEqual(legacy);
    expect(() => writer.read({})).toThrow();
    expect(() => upcastEvent({ ...event, schemaVersion: 3 }, registry)).toThrow(
      'Unsupported',
    );
    expect(() =>
      upcastEvent(event, {
        'workflow.resumed': { currentVersion: 2, steps: {} },
      }),
    ).toThrow('Missing');
    expect(() =>
      upcastEvent(event, {
        'workflow.resumed': {
          currentVersion: 2,
          steps: { 1: () => ({ reason: 'invalid' }) },
        },
      }),
    ).toThrow();
  });
});

describe('sessions and idempotency', () => {
  it('restores a consumed bootstrap code if session insertion fails', () => {
    const db = database();
    const sessions = new SqliteSessionStore(db, new FakeClock());
    const code = sessions.issueBootstrapCode();
    db.exec(
      "CREATE TRIGGER fail_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );
    expect(() => sessions.exchangeBootstrapCode(code)).toThrow(
      'injected failure',
    );
    db.exec('DROP TRIGGER fail_session');
    const session = sessions.exchangeBootstrapCode(code)!;
    expect(sessions.verify(session)).toBe(true);
    expect(sessions.exchangeBootstrapCode(code)).toBeNull();
  });
  it('consumes bootstrap codes once, expires precisely at the boundary, and revokes sessions', () => {
    const clock = new FakeClock();
    const suite = stores(':memory:', clock);
    try {
      expect(suite.sessions.exchangeBootstrapCode('invalid')).toBeNull();
      const code = suite.sessions.issueBootstrapCode();
      clock.advance(59_999);
      const session = suite.sessions.exchangeBootstrapCode(code)!;
      expect(session).toMatch(/^aio_session_/);
      expect(suite.sessions.exchangeBootstrapCode(code)).toBeNull();
      expect(suite.sessions.verify(session)).toBe(true);
      clock.advance(30 * 24 * 60 * 60 * 1000);
      expect(suite.sessions.verify(session)).toBe(false);
      const expiredCode = suite.sessions.issueBootstrapCode();
      clock.advance(60_000);
      expect(suite.sessions.exchangeBootstrapCode(expiredCode)).toBeNull();
      const live = suite.sessions.exchangeBootstrapCode(
        suite.sessions.issueBootstrapCode(),
      )!;
      suite.sessions.revoke(live);
      suite.sessions.revoke(live);
      expect(suite.sessions.verify(live)).toBe(false);
    } finally {
      suite.close();
    }
  });

  it('retains first responses, detects hash conflicts, isolates scopes, and replaces expired records', () => {
    const clock = new FakeClock();
    const suite = stores(':memory:', clock);
    try {
      const record = {
        requestHash: 'a',
        response: { status: 201, body: { count: 1 } },
        expiresAt: new Date(clock.now().getTime() + 1000).toISOString(),
      };
      suite.idempotency.put('s', 'key', record);
      record.response.body.count = 9;
      suite.idempotency.put('s', 'key', record);
      expect(suite.idempotency.get('s', 'key')?.response.body).toEqual({
        count: 1,
      });
      expect(() =>
        suite.idempotency.put('s', 'key', { ...record, requestHash: 'b' }),
      ).toThrow(
        expect.objectContaining({
          category: 'conflict',
          code: 'idempotency_mismatch',
        }),
      );
      suite.idempotency.put('other', 'key', { ...record, requestHash: 'b' });
      expect(suite.idempotency.get('other', 'key')?.requestHash).toBe('b');
      expect(() =>
        suite.idempotency.put('s', 'bad', { ...record, expiresAt: 'invalid' }),
      ).toThrow();
      clock.advance(1000);
      expect(suite.idempotency.get('s', 'key')).toBeNull();
      suite.idempotency.put('s', 'key', {
        ...record,
        requestHash: 'b',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      expect(suite.idempotency.get('s', 'key')?.requestHash).toBe('b');
    } finally {
      suite.close();
    }
  });
});
