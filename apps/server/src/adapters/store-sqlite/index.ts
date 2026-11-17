import { chmodSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { Clock, IdGen } from '../../ports/services.js';
import { SqliteEventStore } from './events.js';
import { migrate } from './migrations/index.js';
import {
  SqliteIdempotencyStore,
  SqliteProjectionStore,
  SqliteSeatTokenStore,
  SqliteSessionStore,
} from './stores.js';
import type { Upcasters } from './upcasters/index.js';

export type SqliteStoreOptions = {
  filename: string;
  clock: Clock;
  ids: Pick<IdGen, 'ulid'>;
  projectionVersion: number;
  migrationDirectory?: string;
  upcasters?: Upcasters;
};

/** One shared connection owned by the composition root. Close only after consumers stop. */
export function openSqliteStores<T = unknown>(options: SqliteStoreOptions) {
  const db = new Database(options.filename);
  try {
    if (options.filename !== ':memory:' && options.filename !== '')
      chmodSync(options.filename, 0o600);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    const backupPath = migrate(db, options.migrationDirectory);
    return {
      events: new SqliteEventStore(
        db,
        options.clock,
        options.ids,
        options.upcasters,
      ),
      projections: new SqliteProjectionStore<T>(db, options.projectionVersion),
      seatTokens: new SqliteSeatTokenStore(db),
      sessions: new SqliteSessionStore(db, options.clock),
      idempotency: new SqliteIdempotencyStore(db, options.clock),
      backupPath,
      close: () => {
        if (db.open) db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
export { SqliteEventStore } from './events.js';
export {
  SqliteProjectionStore,
  SqliteSeatTokenStore,
  SqliteSessionStore,
  SqliteIdempotencyStore,
} from './stores.js';
export {
  upcastEvent,
  type Upcasters,
  type UpcastPlan,
} from './upcasters/index.js';
