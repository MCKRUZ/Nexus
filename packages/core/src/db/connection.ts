import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type NexusDb = Database.Database;

const DEFAULT_DB_DIR = path.join(os.homedir(), '.nexus');
const DEFAULT_DB_FILE = 'nexus.db';

/** Cipher scheme. Named explicitly rather than relying on the driver default. */
export const NEXUS_CIPHER = 'sqlcipher';

/** First bytes of an UNencrypted SQLite file. An encrypted file cannot start with these. */
const PLAINTEXT_SQLITE_MAGIC = 'SQLite format 3';

export interface OpenDatabaseOptions {
  dbPath?: string;
  encryptionKey: string; // REQUIRED — never open without encryption
}

export class EncryptionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionUnavailableError';
  }
}

export class UnencryptedDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnencryptedDatabaseError';
  }
}

/**
 * True when the file exists and is a plaintext SQLite database.
 *
 * The standard build of better-sqlite3 silently ignores `PRAGMA key` — an
 * unknown pragma is not an error in SQLite — so a misconfigured driver produces
 * a readable database while every call site believes it is encrypted. Checking
 * the file header is the one test that cannot be fooled by that.
 */
export function isPlaintextDatabase(dbPath: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dbPath, 'r');
    const buf = Buffer.alloc(PLAINTEXT_SQLITE_MAGIC.length);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    if (read < buf.length) return false; // too short to be a populated DB
    return buf.toString('latin1') === PLAINTEXT_SQLITE_MAGIC;
  } catch {
    return false; // missing or unreadable — not our problem to diagnose here
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Throws unless the linked SQLite build can actually encrypt. */
function assertDriverSupportsEncryption(db: NexusDb): void {
  const result = db.pragma('cipher') as unknown[];
  if (!Array.isArray(result) || result.length === 0) {
    throw new EncryptionUnavailableError(
      'The installed SQLite driver has no encryption support, so the database would be ' +
        'written in plaintext. Nexus requires better-sqlite3-multiple-ciphers ' +
        '(package.json aliases better-sqlite3 to it). Run `pnpm install` and retry.',
    );
  }
}

/**
 * Open the Nexus encrypted database.
 *
 * SECURITY: encryption is verified, not assumed. Opening fails loudly if the
 * driver cannot encrypt, if the file on disk is plaintext, or if the key is wrong.
 */
export function openDatabase(opts: OpenDatabaseOptions): NexusDb {
  const dbPath = opts.dbPath ?? path.join(DEFAULT_DB_DIR, DEFAULT_DB_FILE);
  const isMemory = dbPath === ':memory:' || dbPath.startsWith('file::memory:');

  if (!isMemory && isPlaintextDatabase(dbPath)) {
    throw new UnencryptedDatabaseError(
      `${dbPath} is a plaintext SQLite database. It was created by a driver without ` +
        'encryption support. Run `nexus db encrypt` to migrate it (the original is ' +
        'backed up first). Refusing to open it as though it were encrypted.',
    );
  }

  const db = new Database(dbPath);

  try {
    assertDriverSupportsEncryption(db);

    // Cipher must be selected before the key is applied.
    db.pragma(`cipher='${NEXUS_CIPHER}'`);
    db.pragma(`key='${escapeKey(opts.encryptionKey)}'`);

    // Prove the key decrypts this file. With a wrong key SQLite reports
    // "file is not a database" on the first real read, not on the pragma.
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch (err) {
    db.close();
    throw err;
  }

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
