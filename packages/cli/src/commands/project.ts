import { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs';
import chalk from 'chalk';
import { log } from '../lib/output.js';
import { openService } from '../lib/service.js';

export function projectCommand(): Command {
  const cmd = new Command('project');
  cmd.description('Manage registered projects');

  // ─── nexus project add ───────────────────────────────────────────────────
  cmd
    .command('add [path]')
    .description('Register a project with Nexus (defaults to current directory)')
    .option('-n, --name <name>', 'Project name (defaults to directory name)')
    .option('-p, --parent <id>', 'Parent project ID (for dependency graph)')
    .option('-t, --tags <tags>', 'Comma-separated tags')
    .action((projectPath: string | undefined, opts: { name?: string; parent?: string; tags?: string }) => {
      const resolvedPath = path.resolve(projectPath ?? process.cwd());

      if (!fs.existsSync(resolvedPath)) {
        log.error(`Path does not exist: ${resolvedPath}`);
        process.exit(1);
      }

      if (!fs.statSync(resolvedPath).isDirectory()) {
        log.error(`Path is not a directory: ${resolvedPath}`);
        process.exit(1);
      }

      const svc = openService();
      try {
        const existing = svc.getProjectByPath(resolvedPath);
        if (existing) {
          log.warn(`Project already registered: ${existing.name}`);
          log.dim(`  ID:   ${existing.id}`);
          log.dim(`  Path: ${existing.path}`);
          return;
        }

        const name = opts.name ?? path.basename(resolvedPath);
        const tags = opts.tags ? opts.tags.split(',').map((t) => t.trim()).filter(Boolean) : [];

        const project = svc.addProject({
          name,
          path: resolvedPath,
          ...(opts.parent ? { parentId: opts.parent } : {}),
          tags,
        });

        log.success(`Registered project: ${chalk.bold(project.name)}`);
        log.dim(`  ID:   ${project.id}`);
        log.dim(`  Path: ${project.path}`);
        if (tags.length > 0) log.dim(`  Tags: ${tags.join(', ')}`);

        // Suggest MCP config if .mcp.json doesn't have nexus
        const mcpPath = path.join(resolvedPath, '.mcp.json');
        if (fs.existsSync(mcpPath)) {
          const mcpContent = fs.readFileSync(mcpPath, 'utf8');
          if (!mcpContent.includes('nexus')) {
            console.log('');
            log.info('Add Nexus to this project\'s .mcp.json to enable in-session queries:');
            log.dim(`  "nexus": { "type": "stdio", "command": "nexus-mcp" }`);
          }
        }
      } finally {
        svc.close();
      }
    });

  // ─── nexus project list ──────────────────────────────────────────────────
  cmd
    .command('list')
    .description('List all registered projects')
    .option('--json', 'Output as JSON')
    .action((opts: { json?: boolean }) => {
      const svc = openService();
      try {
        const projects = svc.listProjects();

        if (projects.length === 0) {
          log.info('No projects registered. Run `nexus project add <path>` to add one.');
          return;
        }

        if (opts.json) {
          console.log(JSON.stringify(projects, null, 2));
          return;
        }

        console.log('');
        console.log(chalk.bold(`${projects.length} registered project${projects.length === 1 ? '' : 's'}:`));
        console.log('');

        for (const project of projects) {
          const decisions = svc.getDecisionsForProject(project.id);
          const patterns = svc.getPatternsForProject(project.id);
          const lastSeen = project.lastSeenAt
            ? new Date(project.lastSeenAt).toLocaleDateString()
            : 'never';

          console.log(`  ${chalk.bold(project.name)}`);
          log.dim(`    ID:        ${project.id}`);
          log.dim(`    Path:      ${project.path}`);
          log.dim(`    Decisions: ${decisions.length}  Patterns: ${patterns.length}`);
          log.dim(`    Last seen: ${lastSeen}`);
          if (project.tags.length > 0) log.dim(`    Tags:      ${project.tags.join(', ')}`);
          if (project.parentId) log.dim(`    Parent:    ${project.parentId}`);
          console.log('');
        }
      } finally {
        svc.close();
      }
    });

  // ─── nexus project remove ────────────────────────────────────────────────
  cmd
    .command('remove [path]')
    .description('Unregister a project (defaults to current directory)')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (projectPath: string | undefined, opts: { yes?: boolean }) => {
      const resolvedPath = path.resolve(projectPath ?? process.cwd());

      const svc = openService();
      try {
        const existing = svc.getProjectByPath(resolvedPath);
        if (!existing) {
          log.warn(`No project registered at: ${resolvedPath}`);
          process.exit(1);
        }

        if (!opts.yes) {
          const { createInterface } = await import('node:readline');
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const answer = await new Promise<string>((resolve) => {
            rl.question(
              `Remove project "${existing.name}"? All its decisions and patterns will be deleted. [y/N] `,
              resolve,
            );
          });
          rl.close();
          if (!['y', 'yes'].includes(answer.toLowerCase())) {
            log.info('Cancelled.');
            return;
          }
        }

        svc.removeProject(resolvedPath);
        log.success(`Removed project: ${existing.name}`);
      } finally {
        svc.close();
      }
    });

  // ─── nexus project show ──────────────────────────────────────────────────
  cmd
    .command('show [path]')
    .description('Show detailed info about a project (defaults to current directory)')
    .action((projectPath: string | undefined) => {
      const resolvedPath = path.resolve(projectPath ?? process.cwd());
      const svc = openService();
      try {
        const project = svc.getProjectByPath(resolvedPath);
        if (!project) {
          log.warn(`No project registered at: ${resolvedPath}`);
          log.info('Run `nexus project add` to register this directory.');
          process.exit(1);
        }

        const decisions = svc.getDecisionsForProject(project.id);
        const patterns = svc.getPatternsForProject(project.id);
        const preferences = svc.listPreferences(project.id);

        console.log('');
        console.log(chalk.bold(project.name));
        console.log(chalk.dim('─'.repeat(project.name.length)));
        log.plain(`ID:           ${project.id}`);
        log.plain(`Path:         ${project.path}`);
        log.plain(`Registered:   ${new Date(project.registeredAt).toLocaleString()}`);
        if (project.lastSeenAt) {
          log.plain(`Last seen:    ${new Date(project.lastSeenAt).toLocaleString()}`);
        }
        if (project.tags.length > 0) log.plain(`Tags:         ${project.tags.join(', ')}`);
        if (project.parentId) log.plain(`Parent ID:    ${project.parentId}`);

        console.log('');
        console.log(chalk.bold(`Decisions (${decisions.length}):`));
        if (decisions.length === 0) {
          log.dim('  None recorded yet.');
        } else {
          for (const d of decisions.slice(0, 10)) {
            log.plain(`  [${d.kind}] ${d.summary}`);
            if (d.rationale) log.dim(`    → ${d.rationale}`);
          }
          if (decisions.length > 10) log.dim(`  ...and ${decisions.length - 10} more`);
        }

        console.log('');
        console.log(chalk.bold(`Patterns (${patterns.length}):`));
        if (patterns.length === 0) {
          log.dim('  None recorded yet.');
        } else {
          for (const p of patterns.slice(0, 10)) {
            log.plain(`  ${p.name} (×${p.frequency})`);
            log.dim(`    ${p.description}`);
          }
        }

        if (preferences.length > 0) {
          console.log('');
          console.log(chalk.bold(`Preferences (${preferences.length}):`));
          for (const pref of preferences) {
            const scope = pref.scope === 'project' ? '(project)' : '(global)';
            log.plain(`  ${pref.key} = ${pref.value} ${chalk.dim(scope)}`);
          }
        }

        console.log('');
      } finally {
        svc.close();
      }
    });

  return cmd;
}
