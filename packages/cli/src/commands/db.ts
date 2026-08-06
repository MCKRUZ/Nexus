/**
 * nexus db — database maintenance.
 *
 * `nexus db encrypt` converts a plaintext database to an encrypted one. Needed
 * on any install created before the driver actually supported encryption: the
 * standard better-sqlite3 build ignores `PRAGMA key` silently, so those
 * databases were written in plaintext despite the code setting a key.
 */

import { Command } from 'commander';
import fs from 'node:fs';
import { log } from '../lib/output.js';
import {
  readConfig,
  writeConfig,
  DB_FILE,
  encryptDatabase,
  isPlaintextDatabase,
  openDatabase,
  isKeychainAvailable,
  readKeyFromKeychain,
  writeKeyToKeychain,
  deleteKeyFromKeychain,
  resolveEncryptionKey,
} from '@nexus/core';

export function dbCommand(): Command {
  const cmd = new Command('db');
  cmd.description('Database maintenance');

  cmd
    .command('status')
    .description('Report whether the database on disk is actually encrypted')
    .action(() => {
      if (!fs.existsSync(DB_FILE)) {
        log.warn(`No database at ${DB_FILE}. Run \`nexus init\` first.`);
        return;
      }
      if (isPlaintextDatabase(DB_FILE)) {
        log.error(`UNENCRYPTED: ${DB_FILE}`);
        log.dim('  Contents are readable by anything with file access.');
        log.dim('  Run `nexus db encrypt` to fix.');
      } else {
        log.info(`Encrypted: ${DB_FILE}`);
      }

      // Where the key lives matters as much as whether the file is encrypted:
      // a key beside the database travels with any copy of the folder.
      if (readKeyFromKeychain()) {
        log.info('Key: OS credential store');
      } else if (readConfig().encryptionKey) {
        log.warn('Key: config.json (plaintext, beside the database)');
        log.dim('  Run `nexus db secure-key` to move it into the OS credential store.');
      } else {
        log.error('Key: NOT FOUND — the database cannot be opened');
      }
    });

  cmd
    .command('encrypt')
    .description('Encrypt a plaintext database in place (original is backed up first)')
    .option('--dry-run', 'Report what would happen without changing anything')
    .action((opts: { dryRun?: boolean }) => {
      if (!fs.existsSync(DB_FILE)) {
        log.error(`No database at ${DB_FILE}. Run \`nexus init\` first.`);
        process.exitCode = 1;
        return;
      }

      if (!isPlaintextDatabase(DB_FILE)) {
        log.info('Database is already encrypted — nothing to do.');
        return;
      }

      if (opts.dryRun) {
        log.warn(`${DB_FILE} is plaintext and would be encrypted.`);
        log.dim('  The original would be copied to a .plaintext-backup-<timestamp> file first.');
        return;
      }

      const { key } = resolveEncryptionKey(readConfig().encryptionKey);

      try {
        const result = encryptDatabase(DB_FILE, key, Date.now());
        if (!result.migrated) {
          log.info(result.reason ?? 'Nothing to do.');
          return;
        }
        log.info(`Encrypted: ${DB_FILE}`);
        log.dim(`  Plaintext backup: ${result.backupPath}`);
        log.warn('Verify Nexus works, then delete the backup — it is unencrypted.');
      } catch (err) {
        log.error(
          `Encryption failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        log.dim('  The original database was left untouched.');
        process.exitCode = 1;
      }
    });

  cmd
    .command('secure-key')
    .description('Move the database key from config.json into the OS credential store')
    .option('--dry-run', 'Report what would happen without changing anything')
    .action((opts: { dryRun?: boolean }) => {
      if (!isKeychainAvailable()) {
        log.error('No OS credential store is available on this machine.');
        log.dim('  The key must stay in config.json here. Encryption still protects the');
        log.dim('  database file itself, but a copy of ~/.nexus carries its own key.');
        process.exitCode = 1;
        return;
      }

      const config = readConfig();

      if (readKeyFromKeychain()) {
        if (config.encryptionKey) {
          log.warn('A key is already in the credential store, but config.json still holds one.');
          log.dim('  Not touching either — resolve manually to avoid locking yourself out.');
          process.exitCode = 1;
          return;
        }
        log.info('Key is already in the OS credential store — nothing to do.');
        return;
      }

      if (!config.encryptionKey) {
        log.error('No key found in config.json or the credential store.');
        process.exitCode = 1;
        return;
      }

      if (opts.dryRun) {
        log.warn('Would move the key from config.json into the OS credential store.');
        return;
      }

      const key = config.encryptionKey;

      // Store first, prove the database still opens, and only then drop the copy
      // in config.json. Removing it before verifying risks an unopenable database.
      writeKeyToKeychain(key);

      try {
        const db = openDatabase({ dbPath: DB_FILE, encryptionKey: key });
        db.prepare('SELECT count(*) FROM sqlite_master').get();
        db.close();
      } catch (err) {
        deleteKeyFromKeychain();
        log.error(
          `Could not open the database with the stored key: ${err instanceof Error ? err.message : String(err)}`,
        );
        log.dim('  config.json was left untouched.');
        process.exitCode = 1;
        return;
      }

      const { encryptionKey: _removed, ...rest } = config;
      writeConfig(rest);

      log.info('Key moved to the OS credential store.');
      log.dim('  config.json no longer contains it — a copy of ~/.nexus is now inert.');
    });

  return cmd;
}
