import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrateDatabase } from './migrations.js';
import type { NexusDb } from './connection.js';

// Use in-memory DB for tests (no encryption needed)
function openTestDb(): NexusDb {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

describe('migrateDatabase', () => {
  let db: NexusDb;

  beforeEach(() => {
    db = openTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('creates all required tables', () => {
    migrateDatabase(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('projects');
    expect(tableNames).toContain('decisions');
    expect(tableNames).toContain('patterns');
    expect(tableNames).toContain('conflicts');
    expect(tableNames).toContain('preferences');
    expect(tableNames).toContain('audit_log');
    expect(tableNames).toContain('schema_version');
  });

  it('records schema version after migration', () => {
    migrateDatabase(db);

    const version = db
      .prepare('SELECT MAX(version) as v FROM schema_version')
      .get() as { v: number };

    expect(version.v).toBe(1);
  });

  it('is idempotent — running twice does not throw', () => {
    expect(() => {
      migrateDatabase(db);
      migrateDatabase(db);
    }).not.toThrow();
  });
});
