import { Command } from 'commander';
import chalk from 'chalk';
import { log } from '../lib/output.js';
import { openService } from '../lib/service.js';

function printDoctorReport(svc: ReturnType<typeof openService>): number {
  const report = svc.getDoctorReport();

  // Overall status
  const statusColors = {
    healthy: chalk.green,
    degraded: chalk.yellow,
    failing: chalk.red,
  };
  console.log('');
  console.log(
    chalk.bold('Nexus Doctor') +
      '  ' +
      statusColors[report.overall](report.overall.toUpperCase()),
  );
  console.log(chalk.dim('─'.repeat(50)));

  // System checks
  console.log('');
  console.log(chalk.bold('System Checks'));
  for (const check of report.checks) {
    const icon =
      check.status === 'pass'
        ? chalk.green('PASS')
        : check.status === 'warn'
          ? chalk.yellow('WARN')
          : chalk.red('FAIL');
    console.log(`  ${icon}  ${check.name}`);
    if (check.status !== 'pass') {
      console.log(chalk.dim(`         ${check.message}`));
    }
  }

  // Per-project coverage
  let avgScore = 0;
  if (report.projects.length > 0) {
    console.log('');
    console.log(chalk.bold('Project Coverage'));
    console.log(chalk.dim('─'.repeat(50)));

    for (const p of report.projects) {
      const scoreColor =
        p.coverageScore >= 80
          ? chalk.green
          : p.coverageScore >= 50
            ? chalk.yellow
            : chalk.red;

      console.log(
        `  ${scoreColor(String(p.coverageScore).padStart(3))}  ${p.projectName}`,
      );
      console.log(
        chalk.dim(
          `       Notes: ${p.noteCount}  Decisions: ${p.decisionCount}  Patterns: ${p.patternCount}` +
            (p.lastSyncAge !== null
              ? `  Last sync: ${p.lastSyncAge < 24 ? `${Math.round(p.lastSyncAge)}h` : `${Math.round(p.lastSyncAge / 24)}d`} ago`
              : '  Never synced'),
        ),
      );
      if (p.gaps.length > 0) {
        console.log(chalk.yellow(`       Gaps: ${p.gaps.join(', ')}`));
      }
    }

    avgScore = Math.round(
      report.projects.reduce((sum, p) => sum + p.coverageScore, 0) /
        report.projects.length,
    );
    console.log('');
    console.log(
      chalk.dim(`Average coverage: ${avgScore}/100 across ${report.projects.length} project(s)`),
    );
  }

  console.log('');
  return avgScore;
}

export function doctorCommand(): Command {
  return new Command('doctor')
    .description('Check Nexus health — system checks, pipeline status, and per-project coverage')
    .option('--json', 'Output as JSON')
    .option('--fix', 'Auto-fix: link project families + sync stale projects')
    .action((opts: { json?: boolean; fix?: boolean }) => {
      const svc = openService();
      try {
        if (opts.json && !opts.fix) {
          const report = svc.getDoctorReport();
          console.log(JSON.stringify(report, null, 2));
          return;
        }

        if (opts.fix) {
          // Show before state
          console.log(chalk.bold.cyan('Before fix:'));
          const beforeAvg = printDoctorReport(svc);

          // Run fixes
          console.log(chalk.bold.cyan('Running auto-fix...'));
          console.log(chalk.dim('─'.repeat(50)));
          const result = svc.runDoctorFix();

          // Print fix results
          if (result.linkedFamilies.length > 0) {
            console.log('');
            console.log(chalk.bold('Linked Families'));
            for (const family of result.linkedFamilies) {
              console.log(`  ${chalk.green(family.rootName)}`);
              for (const child of family.children) {
                console.log(chalk.dim(`    └─ ${child}`));
              }
            }
          } else {
            console.log(chalk.dim('  No new families to link'));
          }

          console.log('');
          if (result.syncedProjects.length > 0) {
            console.log(chalk.bold('Synced Projects'));
            for (const name of result.syncedProjects) {
              console.log(`  ${chalk.green('SYNC')}  ${name}`);
            }
          }

          if (result.skippedProjects.length > 0) {
            console.log(chalk.bold('Skipped Projects'));
            for (const name of result.skippedProjects) {
              console.log(`  ${chalk.yellow('SKIP')}  ${name}`);
            }
          }

          // Show after state
          console.log('');
          console.log(chalk.bold.cyan('After fix:'));
          const afterAvg = printDoctorReport(svc);

          const delta = afterAvg - beforeAvg;
          if (delta > 0) {
            console.log(chalk.green.bold(`Coverage improved: ${beforeAvg} → ${afterAvg} (+${delta})`));
          } else {
            console.log(chalk.dim(`Coverage unchanged: ${afterAvg}/100`));
          }
          console.log('');

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          }

          return;
        }

        printDoctorReport(svc);
      } finally {
        svc.close();
      }
    });
}
