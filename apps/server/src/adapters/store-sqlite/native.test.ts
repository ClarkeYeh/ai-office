import Database from 'better-sqlite3';
import { expect, test } from 'vitest';

test('native SQLite opens an in-memory database on Node 24', () => {
  const db = new Database(':memory:');
  try {
    expect(db.prepare('select 1 as value').get()).toEqual({ value: 1 });
  } finally {
    db.close();
  }
});
