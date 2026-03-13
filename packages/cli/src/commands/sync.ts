/**
 * nexus sync [path]
 *
 * Syncs Nexus Intelligence into a project's CLAUDE.md.
 * Can be run manually or called from the post-session hook.
 */

import { Command } from 'commander';
import path from 'node:path';
import chalk from 'chalk';
import { log } from '../lib/output.js';
import { openService } from '../lib/service.js';

export function syncCommand(): Command {
  return new Command('sync')
    .description('Sync Nexus intelligence into a project\'s CLAUDE.md')
    .argument('[path]', 'Project path (defaults to current directory)')
    .option('--all', 'Sync all registered projects')
    .option('--dry-run', 'Show what would change without writing')
    .option('--graceful', 'Exit 0 even if project not registered (for hooks)')
    .option('--quiet', 'Suppress output')
    .action(async (projectPath: string | undefined, opts: { all?: boolean; dryRun?: boolean; graceful?: boolean; quiet?: boolean }) => {
      const svc = openService();

      try {
        const projectsToSync = opts.all
          ? svc.listProjects()
          : (() => {
              const resolvedPath = path.resolve(projectPath ?? process.cwd());
              const project = svc.getProjectByPath(resolvedPath);
              if (!project) {
                if (opts.graceful) return [];
                log.error(`No project registered at: ${resolvedPath}`);
                log.info('Run `nexus project add` to register this directory.');
                process.exit(1);
              }
              return [project];
            })();

        let updatedCount = 0;

        for (const project of projectsToSync) {
          if (opts.dryRun) {
            const decisions = svc.getDecisionsForProject(project.id);
            const notes = svc.getNotesForProject(project.id);
            const { conflicts } = svc.checkConflicts([project.id]);
            log.info(`Would sync ${project.name}:`);
            log.dim(`  ${decisions.length} decisions, ${notes.length} notes`);
            if (conflicts.length > 0) log.warn(`  ${conflicts.length} open conflicts`);
            continue;
          }

          const updated = svc.syncProject(project.id);

          if (updated) {
            updatedCount++;
            log.success(`Synced: ${chalk.bold(project.name)}`);
          } else {
            log.dim(`Up to date: ${project.name}`);
          }
        }

        if (!opts.dryRun && updatedCount > 0) {
          console.log('');
          log.success(`Synced ${updatedCount} project${updatedCount === 1 ? '' : 's'}`);
        }
      } finally {
        svc.close();
      }
    });
}
