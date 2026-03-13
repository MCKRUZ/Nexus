import { Command } from 'commander';
import path from 'node:path';
import chalk from 'chalk';
import { log } from '../lib/output.js';
import { openService } from '../lib/service.js';

export function patternCommand(): Command {
  const cmd = new Command('pattern');
  cmd.description('Manage recorded patterns');

  cmd
    .command('dedup')
    .description('Deduplicate patterns by merging similar entries')
    .option('-p, --project <path>', 'Project path (dedup all projects if omitted)')
    .option('-t, --threshold <number>', 'Jaccard similarity threshold (0-1)', '0.5')
    .option('--dry-run', 'Show what would be merged without making changes')
    .action((opts: { project?: string; threshold: string; dryRun?: boolean }) => {
      const threshold = parseFloat(opts.threshold);
      if (isNaN(threshold) || threshold < 0 || threshold > 1) {
        log.error('Threshold must be a number between 0 and 1.');
        process.exit(1);
      }

      const svc = openService();
      try {
        if (opts.project) {
          const projectPath = path.resolve(opts.project);
          const project = svc.getProjectByPath(projectPath);
          if (!project) {
            log.error(`No project registered at: ${projectPath}`);
            process.exit(1);
          }

          if (opts.dryRun) {
            log.info(`[dry-run] Scanning ${project.name} (threshold=${threshold})...`);
          }

          const result = svc.deduplicatePatterns(project.id, threshold, 'cli', !!opts.dryRun);

          if (result.merged === 0) {
            log.info(`${project.name}: no duplicate patterns found.`);
          } else {
            console.log('');
            console.log(chalk.bold(`${project.name}: ${result.merged} merged, ${result.kept} kept`));
            for (const d of result.details) {
              console.log(`  ${chalk.red('- ')}${d.mergedName}`);
              console.log(`    ${chalk.green('kept: ')}${d.canonicalName}`);
            }
            console.log('');
          }
        } else {
          // All projects
          if (opts.dryRun) {
            log.info(`[dry-run] Scanning all projects (threshold=${threshold})...`);
          } else {
            log.info(`Deduplicating all projects (threshold=${threshold})...`);
          }
          const { total, perProject } = svc.deduplicateAllPatterns(threshold, 'cli', !!opts.dryRun);

          if (total.merged === 0) {
            log.info('No duplicate patterns found across any project.');
            return;
          }

          console.log('');
          for (const { projectName, result } of perProject) {
            console.log(chalk.bold(`${projectName}: ${result.merged} merged, ${result.kept} kept`));
            for (const d of result.details) {
              console.log(`  ${chalk.red('- ')}${d.mergedName}`);
              console.log(`    ${chalk.green('kept: ')}${d.canonicalName}`);
            }
            console.log('');
          }

          console.log(chalk.bold(`Total: ${total.merged} merged, ${total.kept} kept`));
        }
      } finally {
        svc.close();
      }
    });

  return cmd;
}
