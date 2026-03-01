import { Command } from 'commander';
import chalk from 'chalk';
import { isInitialized, NEXUS_DIR, DB_FILE } from '@nexus/core';
import { log } from '../lib/output.js';
import { openService } from '../lib/service.js';
import fs from 'node:fs';
import path from 'node:path';

export function statusCommand(): Command {
  return new Command('status')
    .description('Show Nexus status and statistics')
    .action(() => {
      if (!isInitialized()) {
        log.warn('Nexus is not initialized.');
        log.info('Run `nexus init` to get started.');
        return;
      }

      const svc = openService();
      try {
        const projects = svc.listProjects();
        const dbStat = fs.statSync(DB_FILE);
        const dbSizeKb = (dbStat.size / 1024).toFixed(1);

        let totalDecisions = 0;
        let totalPatterns = 0;

        for (const project of projects) {
          totalDecisions += svc.getDecisionsForProject(project.id).length;
          totalPatterns += svc.getPatternsForProject(project.id).length;
        }

        console.log('');
        console.log(chalk.bold('Nexus Status'));
        console.log(chalk.dim('─────────────'));
        log.plain(`Data dir:   ${NEXUS_DIR}`);
        log.plain(`Database:   ${path.basename(DB_FILE)} (${dbSizeKb} KB, encrypted)`);
        console.log('');
        console.log(chalk.bold('Statistics'));
        console.log(chalk.dim('──────────'));
        log.plain(`Projects:   ${chalk.bold(projects.length)}`);
        log.plain(`Decisions:  ${chalk.bold(totalDecisions)}`);
        log.plain(`Patterns:   ${chalk.bold(totalPatterns)}`);
        console.log('');
      } finally {
        svc.close();
      }
    });
}
