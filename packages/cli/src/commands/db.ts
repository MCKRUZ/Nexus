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
import path from 'node:path';
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
  NexusService,
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

  cmd
    .command('retire-advisories')
    .description('Close out the retired advisory tier (rows are kept, not deleted)')
    .option('--dry-run', 'Report how many would be retired without changing anything')
    .action((opts: { dryRun?: boolean }) => {
      const svc = NexusService.open();
      try {
        const open = svc
          .checkConflicts(svc.listProjects().map((p) => p.id))
          .advisories.filter((a) => !a.resolvedAt);

        if (open.length === 0) {
          log.info('No open advisories — nothing to do.');
          return;
        }
        if (opts.dryRun) {
          log.warn(`${open.length} open advisories would be marked resolved.`);
          log.dim('  The rows stay in the database; only resolved_at is set.');
          return;
        }

        const count = svc.retireOpenAdvisories('cli');
        log.info(`Retired ${count} advisories.`);
        log.dim('  Rows kept with resolution "tier-retired" — reversible if you want them back.');
      } finally {
        svc.close();
      }
    });

  cmd
    .command('proposals')
    .description('List decisions flagged as possibly out of date, and act on them')
    .option('-p, --project <path>', 'Project path (defaults to current directory)')
    .option('--accept <id>', 'Retire the older decision named by this proposal')
    .option('--reject <id>', 'Keep it, and never raise this pair again')
    .action((opts: { project?: string; accept?: string; reject?: string }) => {
      const svc = NexusService.open();
      try {
        if (opts.accept || opts.reject) {
          const id = (opts.accept ?? opts.reject) as string;
          const proposal = svc.getProposal(id);
          if (!proposal) {
            log.error(`No proposal ${id}`);
            process.exitCode = 1;
            return;
          }
          if (opts.accept) {
            svc.acceptProposal(id, 'cli');
            log.info('Decision retired. The row stays, so this can be undone.');
          } else {
            svc.rejectProposal(id, 'cli');
            log.info('Kept. This pair will not be raised again.');
          }
          return;
        }

        const projectPath = path.resolve(opts.project ?? process.cwd());
        const project = svc.getProjectByPath(projectPath);
        if (!project) {
          log.warn(`No Nexus project registered at ${projectPath}`);
          return;
        }

        const proposals = svc.listPendingProposals(project.id);
        if (proposals.length === 0) {
          log.info('Nothing flagged as out of date.');
          return;
        }

        const decisions = svc.getDecisionsForProject(project.id);
        const summary = (id: string) => decisions.find((d) => d.id === id)?.summary ?? '(unknown)';

        log.info(`${proposals.length} decision(s) flagged as possibly out of date:`);
        for (const p of proposals) {
          console.log('');
          log.warn(`  ${summary(p.supersededId)}`);
          log.dim(`    possibly replaced by: ${summary(p.supersedingId)}`);
          if (p.reason) log.dim(`    ${p.reason}`);
          log.dim(`    nexus db proposals --accept ${p.id}   (retire it)`);
          log.dim(`    nexus db proposals --reject ${p.id}   (keep it)`);
        }
      } finally {
        svc.close();
      }
    });

  return cmd;
}
