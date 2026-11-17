import { chmodSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

/** SQL assets live alongside this module; tsc-only builds can use the source tree.
 * A dist-only deployment must copy migrations/*.sql or pass its asset directory.
 */
export function defaultMigrationDirectory(): string {
  const adjacent = import.meta.dirname;
  if (existsSync(join(adjacent, '0001_event_store.sql'))) return adjacent;
  return join(adjacent, '../../../../src/adapters/store-sqlite/migrations');
}

/** A consistent SQLite snapshot includes committed WAL pages, unlike copying the DB file. */
export function migrate(
  db: Database.Database,
  directory = defaultMigrationDirectory(),
): string | null {
  const files = readdirSync(directory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  if (!files.length) throw new Error('No SQLite migrations found');
  files.forEach((name, index) => {
    if (Number(name.slice(0, 4)) !== index + 1)
      throw new Error('SQLite migration sequence has a gap');
  });
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > files.length)
    throw new Error('SQLite schema is newer than this application');
  if (version === files.length) return null;
  const backupPath =
    db.name === ':memory:' || db.name === ''
      ? null
      : `${db.name}.backup-v${version}-${randomUUID()}.sqlite`;
  if (backupPath) {
    db.prepare('VACUUM INTO ?').run(backupPath);
    chmodSync(backupPath, 0o600);
  }
  db.transaction(() => {
    for (let index = version; index < files.length; index++) {
      db.exec(readFileSync(join(directory, files[index]!), 'utf8'));
      db.pragma(`user_version = ${index + 1}`);
    }
  }).immediate();
  return backupPath;
}
