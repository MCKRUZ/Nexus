#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { projectCommand } from './commands/project.js';
import { queryCommand } from './commands/query.js';
import { decisionCommand } from './commands/decision.js';
import { statusCommand } from './commands/status.js';
import { hookCommand } from './commands/hook.js';
import { syncCommand } from './commands/sync.js';
import { serveCommand } from './commands/serve.js';
import { installMemoryRuleCommand } from './commands/install-memory-rule.js';
import { doctorCommand } from './commands/doctor.js';
import { backfillCommand } from './commands/backfill.js';
import { patternCommand } from './commands/pattern.js';

const program = new Command();

program
  .name('nexus')
  .description('Cross-project Claude Code orchestrator — the missing layer between your projects and your AI')
  .version('0.1.0');

program.addCommand(initCommand());
program.addCommand(projectCommand());
program.addCommand(queryCommand());
program.addCommand(decisionCommand());
program.addCommand(statusCommand());
program.addCommand(hookCommand());
program.addCommand(syncCommand());
program.addCommand(serveCommand());
program.addCommand(installMemoryRuleCommand());
program.addCommand(doctorCommand());
program.addCommand(backfillCommand());
program.addCommand(patternCommand());

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
