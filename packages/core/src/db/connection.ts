import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';

export type NexusDb = Database.Database;

const DEFAULT_DB_DIR = path.join(os.homedir(), '.nexus');
const DEFAULT_DB_FILE = 'nexus.db';

export interface OpenDatabaseOptions {
  dbPath?: string;
  encryptionKey: string; // REQUIRED — never open without encryption
}

/**
 * Open the Nexus SQLCipher-encrypted database.
 *
 * SECURITY: The encryption key is applied immediately after opening.
 * Never call this without an encryptionKey — that would create an unencrypted DB.
 */
export function openDatabase(opts: OpenDatabaseOptions): NexusDb {
  const dbPath = opts.dbPath ?? path.join(DEFAULT_DB_DIR, DEFAULT_DB_FILE);

  const db = new Database(dbPath);

  // Apply SQLCipher encryption key immediately — this MUST be the first operation
  db.pragma(`key="${escapeKey(opts.encryptionKey)}"`);

  // Perf pragmas (safe to set after key)
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  return db;
}

/** Escape single quotes in key to prevent pragma injection */
function escapeKey(key: string): string {
  return key.replace(/'/g, "''");
}
