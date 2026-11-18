import type Database from 'better-sqlite3';
import type { AdapterStateStore } from '../../ports/stores.js';
import { json } from './json.js';

/** Uses the shared connection; a single upsert is atomic, with no event append. */
export class SqliteAdapterStateStore implements AdapterStateStore {
  private readonly source: string;
  constructor(
    private readonly db: Database.Database,
    name: string,
  ) {
    if (!name.trim()) throw new TypeError('Adapter name must not be empty');
    this.source = 'adapter.' + name;
  }
  read(scope: string): unknown | null {
    const row = this.db
      .prepare(
        'SELECT value_json FROM ingest_cursors WHERE source = ? AND scope = ?',
      )
      .get(this.source, scope) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) : null;
  }
  write(scope: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO ingest_cursors (source, scope, value_json) VALUES (?, ?, ?) ON CONFLICT(source, scope) DO UPDATE SET value_json = excluded.value_json',
      )
      .run(this.source, scope, json(value));
  }
}
