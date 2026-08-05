import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { NEXUS_CIPHER, isPlaintextDatabase } from './connection.js';

export interface EncryptMigrationResult {
  /** False when the database was already encrypted and nothing was done. */
  migrated: boolean;
  /** Where the original plaintext file was kept before being replaced. */
  backupPath?: string;
  reason?: string;
}

/** Escape single quotes for safe interpolation into a pragma string literal. */
function escape(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Convert a plaintext Nexus database into an encrypted one.
 *
 * Works on a copy: the original is never modified until an encrypted version has
 * been produced, reopened with its key, and read back. `PRAGMA rekey` encrypts
 * every page in place, so full-text search tables and triggers survive intact —
 * a schema-and-rows copy would not survive FTS5 shadow tables.
 */
export function encryptDatabase(
  dbPath: string,
  encryptionKey: string,
  timestamp: number,
): EncryptMigrationResult {
  if (!fs.existsSync(dbPath)) {
    return { migrated: false, reason: 'Database file does not exist' };
  }
  if (!isPlaintextDatabase(dbPath)) {
    return { migrated: false, reason: 'Database is already encrypted' };
  }

  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath);
  const backupPath = path.join(dir, `${base}.plaintext-backup-${timestamp}`);
  const workPath = path.join(dir, `${base}.encrypting-${timestamp}`);

  // Fold any pending WAL content back into the main file so the copy is complete.
  checkpointAndCloseWal(dbPath);

  fs.copyFileSync(dbPath, backupPath);
  if (fs.existsSync(workPath)) fs.rmSync(workPath);
  fs.copyFileSync(dbPath, workPath);

  try {
    const db = new Database(workPath);
    try {
      db.pragma(`cipher='${NEXUS_CIPHER}'`);
      db.pragma(`rekey='${escape(encryptionKey)}'`);
    } finally {
      db.close();
    }

    verifyEncryptedCopy(workPath, encryptionKey);
  } catch (err) {
    // The original is still the live database — leave it that way.
    if (fs.existsSync(workPath)) fs.rmSync(workPath, { force: true });
    throw err;
  }

  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${suffix}`;
    if (fs.existsSync(sidecar)) fs.rmSync(sidecar, { force: true });
  }
  fs.rmSync(dbPath);
  fs.renameSync(workPath, dbPath);

  return { migrated: true, backupPath };
}

/** Merge the write-ahead log into the main file and drop the sidecars. */
function checkpointAndCloseWal(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.pragma('journal_mode = delete');
  } finally {
    db.close();
  }
}

/** Reopen an encrypted file with its key and confirm it reads. Throws if not. */
function verifyEncryptedCopy(dbPath: string, encryptionKey: string): void {
  if (isPlaintextDatabase(dbPath)) {
    throw new Error(
      `Encryption produced a plaintext file at ${dbPath}. The original was not modified.`,
    );
  }

  const db = new Database(dbPath);
  try {
    db.pragma(`cipher='${NEXUS_CIPHER}'`);
    db.pragma(`key='${escape(encryptionKey)}'`);
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } finally {
    db.close();
  }
}
