import { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs';
import {
  isInitialized,
  initConfig,
  ensureNexusDir,
  NEXUS_DIR,
  DB_FILE,
  NexusService,
} from '@nexus/core';
import { log } from '../lib/output.js';

export function initCommand(): Command {
  return new Command('init')
    .description('Initialize Nexus — creates the encrypted database and config')
    .option('--force', 'Re-initialize even if already initialized (resets all data)')
    .action(async (opts: { force?: boolean }) => {
      if (isInitialized() && !opts.force) {
        log.warn('Nexus is already initialized.');
        log.dim(`  Database: ${DB_FILE}`);
        log.dim(`  Config:   ${path.join(NEXUS_DIR, 'config.json')}`);
        log.info('Run with --force to re-initialize (this will erase all data).');
        return;
      }

      if (opts.force && isInitialized()) {
        log.warn('Force re-initializing — existing data will be lost.');
        fs.rmSync(DB_FILE, { force: true });
      }

      log.info('Initializing Nexus...');
      ensureNexusDir();

      // 1. Generate config + encryption key
      const config = initConfig();
      log.success('Generated encryption key');
      log.dim(`  Config: ${path.join(NEXUS_DIR, 'config.json')}`);

      // 2. Open DB — this runs migrations and creates all tables
      const svc = NexusService.open();
      svc.close();
      log.success('Created encrypted database');
      log.dim(`  Database: ${DB_FILE}`);

      console.log('');
      log.success('Nexus initialized successfully!');
      console.log('');
      log.plain('  Next steps:');
      log.plain('    nexus project add <path>   Register your first project');
      log.plain('    nexus project list          View registered projects');
      console.log('');
      log.warn(
        'Your encryption key is stored in ' +
          path.join(NEXUS_DIR, 'config.json') +
          '\n  Back it up — without it, your database cannot be decrypted.',
      );

      void config; // key is in the config file
    });
}
