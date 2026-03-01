import { Command } from 'commander';
import path from 'node:path';
import chalk from 'chalk';
import { log } from '../lib/output.js';
import { openService } from '../lib/service.js';

export function queryCommand(): Command {
  return new Command('query')
    .description('Search across all decisions, patterns, and preferences')
    .argument('<search>', 'Search query')
    .option('-p, --project <path>', 'Scope to a specific project path')
    .option('--decisions', 'Search decisions only')
    .option('--patterns', 'Search patterns only')
    .option('--preferences', 'Search preferences only')
    .option('-l, --limit <n>', 'Max results per type', '10')
    .option('--json', 'Output as JSON')
    .action(
      (
        search: string,
        opts: {
          project?: string;
          decisions?: boolean;
          patterns?: boolean;
          preferences?: boolean;
          limit: string;
          json?: boolean;
        },
      ) => {
        const svc = openService();
        try {
          let projectId: string | undefined;
          if (opts.project) {
            const projectPath = path.resolve(opts.project);
            const project = svc.getProjectByPath(projectPath);
            if (!project) {
              log.error(`No project registered at: ${projectPath}`);
              process.exit(1);
            }
            projectId = project.id;
          }

          const kinds: Array<'decision' | 'pattern' | 'preference'> =
            opts.decisions || opts.patterns || opts.preferences
              ? [
                  ...(opts.decisions ? (['decision'] as const) : []),
                  ...(opts.patterns ? (['pattern'] as const) : []),
                  ...(opts.preferences ? (['preference'] as const) : []),
                ]
              : ['decision', 'pattern', 'preference'];

          const results = svc.query({
            query: search,
            ...(projectId ? { projectId } : {}),
            kinds,
            limit: parseInt(opts.limit, 10),
          });

          if (opts.json) {
            console.log(JSON.stringify(results, null, 2));
            return;
          }

          const total =
            results.decisions.length + results.patterns.length + results.preferences.length;

          if (total === 0) {
            log.info(`No results for "${search}".`);
            return;
          }

          console.log('');

          if (results.decisions.length > 0) {
            console.log(chalk.bold(`Decisions (${results.decisions.length}):`));
            for (const d of results.decisions) {
              console.log(`  ${chalk.cyan(`[${d.kind}]`)} ${d.summary}`);
              if (d.rationale) log.dim(`    ${d.rationale}`);
              log.dim(`    Project: ${d.projectId} · ${new Date(d.recordedAt).toLocaleDateString()}`);
            }
            console.log('');
          }

          if (results.patterns.length > 0) {
            console.log(chalk.bold(`Patterns (${results.patterns.length}):`));
            for (const p of results.patterns) {
              console.log(`  ${chalk.magenta(p.name)} (×${p.frequency})`);
              log.dim(`    ${p.description}`);
              log.dim(`    Project: ${p.projectId}`);
            }
            console.log('');
          }

          if (results.preferences.length > 0) {
            console.log(chalk.bold(`Preferences (${results.preferences.length}):`));
            for (const pref of results.preferences) {
              const scope = pref.scope === 'project' ? `(project: ${pref.projectId})` : '(global)';
              console.log(`  ${chalk.yellow(pref.key)} = ${pref.value} ${chalk.dim(scope)}`);
            }
            console.log('');
          }
        } finally {
          svc.close();
        }
      },
    );
}
