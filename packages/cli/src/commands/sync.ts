/**
 * nexus sync [path]
 *
 * Syncs Nexus Intelligence into a project's CLAUDE.md.
 * Can be run manually or called from the post-session hook.
 */

import { Command } from 'commander';
import path from 'node:path';
import chalk from 'chalk';
import { syncClaudeMd, selectRelevantProjects } from '@nexus/core';
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
          const decisions = svc.getDecisionsForProject(project.id);
          const patterns = svc.getPatternsForProject(project.id);
          const preferences = svc.listPreferences(project.id);
          const { conflicts } = svc.checkConflicts([project.id]);

          // Find related projects (children of this project or same parent)
          const allProjects = svc.listProjects();
          const otherProjects = allProjects.filter((p) => p.id !== project.id);
          const relatedProjects = otherProjects
            .filter((p) => p.parentId === project.id || project.parentId === p.id)
            .map((p) => ({ name: p.name, path: p.path }));
          const notes = svc.getNotesForProject(project.id);
          const allNotesMap = otherProjects.map((p) => ({
            projectName: p.name,
            project: p,
            notes: svc.getNotesForProject(p.id),
          }));
          const relatedProjectNotes = selectRelevantProjects(
            { project, notes },
            allNotesMap,
          );

          if (opts.dryRun) {
            log.info(`Would sync ${project.name}:`);
            log.dim(`  ${decisions.length} decisions, ${patterns.length} patterns, ${preferences.length} preferences`);
            if (conflicts.length > 0) log.warn(`  ${conflicts.length} open conflicts`);
            continue;
          }

          const result = syncClaudeMd({
            projectPath: project.path,
            notes,
            relatedProjectNotes,
            decisions,
            patterns,
            preferences,
            conflicts: conflicts as import('@nexus/core').Conflict[],
            relatedProjects,
          });

          if (result.updated) {
            updatedCount++;
            log.success(`Synced: ${chalk.bold(project.name)}`);
            log.dim(`  CLAUDE.md: ${result.claudeMdPath}`);
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
