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
import { readConfig, DB_FILE, encryptDatabase, isPlaintextDatabase } from '@nexus/core';

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
        return;
      }
      log.info(`Encrypted: ${DB_FILE}`);
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

      const config = readConfig();

      try {
        const result = encryptDatabase(DB_FILE, config.encryptionKey, Date.now());
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

  return cmd;
}
