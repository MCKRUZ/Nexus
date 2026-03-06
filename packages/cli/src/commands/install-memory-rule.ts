import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { log } from '../lib/output.js';

const DEST = path.join(os.homedir(), '.claude', 'rules', 'nexus-memory.md');

function resolveTemplate(): string {
  // Walk up from the compiled output to find the repo root, then the template.
  // __filename: packages/cli/dist/commands/install-memory-rule.js
  const __filename = fileURLToPath(import.meta.url);
  const cliDist = path.dirname(__filename); // dist/commands/
  const repoRoot = path.resolve(cliDist, '..', '..', '..', '..'); // four levels up
  return path.join(repoRoot, 'docs', 'templates', 'nexus-memory.md');
}

export function installMemoryRuleCommand(): Command {
  return new Command('install-memory-rule')
    .description('Install the Nexus cross-project memory rule into ~/.claude/rules/')
    .option('--force', 'Overwrite existing rule without prompting')
    .action(async (opts: { force?: boolean }) => {
      const templatePath = resolveTemplate();

      if (!fs.existsSync(templatePath)) {
        log.error(`Template not found: ${templatePath}`);
        log.dim('  Make sure you are running from the Nexus repository root.');
        process.exit(1);
      }

      if (fs.existsSync(DEST) && !opts.force) {
        log.warn(`${DEST} already exists.`);
        log.info('  Use --force to overwrite it.');
        return;
      }

      fs.mkdirSync(path.dirname(DEST), { recursive: true });
      fs.copyFileSync(templatePath, DEST);

      log.success('Memory rule installed!');
      log.dim(`  ${DEST}`);
      console.log('');
      log.plain('  Restart Claude Code to activate the rule.');
      log.plain('  Claude will now query Nexus before asking "what is X?" across projects.');
    });
}
