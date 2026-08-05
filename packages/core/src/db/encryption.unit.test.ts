import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openDatabase,
  isPlaintextDatabase,
  UnencryptedDatabaseError,
  NEXUS_CIPHER,
} from './connection.js';
import { encryptDatabase } from './encrypt-migration.js';

const KEY = 'test-encryption-key-12345';
const CANARY = 'canary-decision-summary-do-not-leak';

let workDir: string;
let dbPath: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-enc-'));
  dbPath = path.join(workDir, 'nexus.db');
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** Write a plaintext database of the kind the unencrypted driver produced. */
function writePlaintextDb(target: string): void {
  const db = new Database(target);
  db.exec(`CREATE TABLE decisions (id INTEGER PRIMARY KEY, summary TEXT)`);
  db.prepare('INSERT INTO decisions (summary) VALUES (?)').run(CANARY);
  db.close();
}

describe('the driver can actually encrypt', () => {
  it('reports a cipher, unlike the standard better-sqlite3 build', () => {
    const db = new Database(':memory:');
    const cipher = db.pragma('cipher') as unknown[];
    db.close();
    expect(Array.isArray(cipher)).toBe(true);
    expect(cipher.length).toBeGreaterThan(0);
  });
});

describe('openDatabase', () => {
  it('writes a file that is not a plaintext SQLite database', () => {
    const db = openDatabase({ dbPath, encryptionKey: KEY });
    db.exec('CREATE TABLE t (a TEXT)');
    db.prepare('INSERT INTO t VALUES (?)').run(CANARY);
    db.close();

    expect(isPlaintextDatabase(dbPath)).toBe(false);
  });

  it('does not leave record content readable in the raw file', () => {
    const db = openDatabase({ dbPath, encryptionKey: KEY });
    db.exec('CREATE TABLE t (a TEXT)');
    db.prepare('INSERT INTO t VALUES (?)').run(CANARY);
    db.close();

    const raw = fs.readFileSync(dbPath).toString('latin1');
    expect(raw).not.toContain(CANARY);
  });

  it('cannot be read without the key', () => {
    const db = openDatabase({ dbPath, encryptionKey: KEY });
    db.exec('CREATE TABLE t (a TEXT)');
    db.close();

    expect(() => {
      const plain = new Database(dbPath);
      try {
        plain.prepare('SELECT * FROM t').all();
      } finally {
        plain.close();
      }
    }).toThrow();
  });

  it('rejects the wrong key instead of returning empty results', () => {
    const db = openDatabase({ dbPath, encryptionKey: KEY });
    db.exec('CREATE TABLE t (a TEXT)');
    db.close();

    expect(() => openDatabase({ dbPath, encryptionKey: 'wrong-key' })).toThrow();
  });

  it('round-trips data with the correct key', () => {
    const db = openDatabase({ dbPath, encryptionKey: KEY });
    db.exec('CREATE TABLE t (a TEXT)');
    db.prepare('INSERT INTO t VALUES (?)').run(CANARY);
    db.close();

    const reopened = openDatabase({ dbPath, encryptionKey: KEY });
    const rows = reopened.prepare('SELECT a FROM t').all() as { a: string }[];
    reopened.close();
    expect(rows[0]?.a).toBe(CANARY);
  });

  it('refuses to open a plaintext database rather than pretending it is encrypted', () => {
    writePlaintextDb(dbPath);
    expect(() => openDatabase({ dbPath, encryptionKey: KEY })).toThrow(UnencryptedDatabaseError);
  });
});

describe('isPlaintextDatabase', () => {
  it('detects an unencrypted file', () => {
    writePlaintextDb(dbPath);
    expect(isPlaintextDatabase(dbPath)).toBe(true);
  });

  it('returns false for a missing file', () => {
    expect(isPlaintextDatabase(path.join(workDir, 'nope.db'))).toBe(false);
  });
});

describe('encryptDatabase', () => {
  it('converts a plaintext database in place and preserves its rows', () => {
    writePlaintextDb(dbPath);
    expect(isPlaintextDatabase(dbPath)).toBe(true);

    const result = encryptDatabase(dbPath, KEY, 1700000000000);

    expect(result.migrated).toBe(true);
    expect(isPlaintextDatabase(dbPath)).toBe(false);

    const db = openDatabase({ dbPath, encryptionKey: KEY });
    const rows = db.prepare('SELECT summary FROM decisions').all() as { summary: string }[];
    db.close();
    expect(rows[0]?.summary).toBe(CANARY);
  });

  it('keeps a readable backup of the original', () => {
    writePlaintextDb(dbPath);
    const result = encryptDatabase(dbPath, KEY, 1700000000000);

    expect(result.backupPath).toBeDefined();
    expect(fs.existsSync(result.backupPath!)).toBe(true);
    expect(isPlaintextDatabase(result.backupPath!)).toBe(true);
  });

  it('removes the canary from the encrypted file', () => {
    writePlaintextDb(dbPath);
    encryptDatabase(dbPath, KEY, 1700000000000);
    expect(fs.readFileSync(dbPath).toString('latin1')).not.toContain(CANARY);
  });

  it('is a no-op on an already encrypted database', () => {
    const db = openDatabase({ dbPath, encryptionKey: KEY });
    db.exec('CREATE TABLE t (a TEXT)');
    db.close();

    const result = encryptDatabase(dbPath, KEY, 1700000000000);
    expect(result.migrated).toBe(false);
    expect(result.reason).toContain('already encrypted');
  });

  it('reports rather than throws when there is no database to migrate', () => {
    const result = encryptDatabase(path.join(workDir, 'absent.db'), KEY, 1700000000000);
    expect(result.migrated).toBe(false);
    expect(result.reason).toContain('does not exist');
  });

  it('uses the named cipher so the file is not tied to a driver default', () => {
    writePlaintextDb(dbPath);
    encryptDatabase(dbPath, KEY, 1700000000000);

    const db = new Database(dbPath);
    db.pragma(`cipher='${NEXUS_CIPHER}'`);
    db.pragma(`key='${KEY}'`);
    const rows = db.prepare('SELECT summary FROM decisions').all() as { summary: string }[];
    db.close();
    expect(rows[0]?.summary).toBe(CANARY);
  });
});
