import { Command } from 'commander';
import path from 'node:path';
import chalk from 'chalk';
import { log } from '../lib/output.js';
import { openService } from '../lib/service.js';
import type { DecisionKind } from '@nexus/core';

const VALID_KINDS: DecisionKind[] = [
  'architecture',
  'library',
  'pattern',
  'naming',
  'security',
  'other',
];

export function decisionCommand(): Command {
  const cmd = new Command('decision');
  cmd.description('Manage architectural decisions');

  cmd
    .command('add')
    .description('Record a new architectural decision')
    .option('-p, --project <path>', 'Project path (defaults to current directory)')
    .option('-k, --kind <kind>', `Decision kind: ${VALID_KINDS.join(', ')}`, 'architecture')
    .option('-s, --summary <text>', 'One-sentence decision summary')
    .option('-r, --rationale <text>', 'Why this decision was made')
    .action(
      async (opts: { project?: string; kind: string; summary?: string; rationale?: string }) => {
        const projectPath = path.resolve(opts.project ?? process.cwd());
        const svc = openService();
        try {
          const project = svc.getProjectByPath(projectPath);
          if (!project) {
            log.error(`No project registered at: ${projectPath}`);
            log.info('Run `nexus project add` to register this directory first.');
            process.exit(1);
          }

          if (!VALID_KINDS.includes(opts.kind as DecisionKind)) {
            log.error(`Invalid kind "${opts.kind}". Valid kinds: ${VALID_KINDS.join(', ')}`);
            process.exit(1);
          }

          let summary = opts.summary;
          let rationale = opts.rationale;

          // Interactive prompts if flags not provided
          if (!summary) {
            const { createInterface } = await import('node:readline');
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            summary = await new Promise<string>((resolve) => {
              rl.question('Decision summary: ', resolve);
            });
            if (!rationale) {
              rationale = await new Promise<string>((resolve) => {
                rl.question('Rationale (optional, press Enter to skip): ', resolve);
              });
            }
            rl.close();
          }

          if (!summary?.trim()) {
            log.error('Summary is required.');
            process.exit(1);
          }

          const trimmedRationale = rationale?.trim() || undefined;
          const decision = svc.recordDecision({
            projectId: project.id,
            kind: opts.kind as DecisionKind,
            summary: summary.trim(),
            ...(trimmedRationale ? { rationale: trimmedRationale } : {}),
          }, 'cli');

          log.success(`Recorded decision: ${chalk.bold(decision.summary)}`);
          log.dim(`  ID:      ${decision.id}`);
          log.dim(`  Kind:    ${decision.kind}`);
          log.dim(`  Project: ${project.name}`);
        } finally {
          svc.close();
        }
      },
    );

  cmd
    .command('list')
    .description('List decisions for a project')
    .option('-p, --project <path>', 'Project path (defaults to current directory)')
    .option('--json', 'Output as JSON')
    .action((opts: { project?: string; json?: boolean }) => {
      const projectPath = path.resolve(opts.project ?? process.cwd());
      const svc = openService();
      try {
        const project = svc.getProjectByPath(projectPath);
        if (!project) {
          log.error(`No project registered at: ${projectPath}`);
          process.exit(1);
        }

        const decisions = svc.getDecisionsForProject(project.id);

        if (opts.json) {
          console.log(JSON.stringify(decisions, null, 2));
          return;
        }

        if (decisions.length === 0) {
          log.info(`No decisions recorded for ${project.name}.`);
          return;
        }

        console.log('');
        console.log(chalk.bold(`${decisions.length} decision${decisions.length === 1 ? '' : 's'} for ${project.name}:`));
        console.log('');

        for (const d of decisions) {
          console.log(`  ${chalk.cyan(`[${d.kind}]`)} ${d.summary}`);
          if (d.rationale) log.dim(`    ${d.rationale}`);
          log.dim(`    ${new Date(d.recordedAt).toLocaleString()}`);
          console.log('');
        }
      } finally {
        svc.close();
      }
    });

  return cmd;
}
