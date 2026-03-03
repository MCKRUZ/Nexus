/**
 * nexus hook post-session
 *
 * Called by Claude Code's Stop hook after each session ends.
 * Responsibilities:
 *   1. Mark the project as seen (update lastSeenAt)
 *   2. Run conflict detection against other registered projects
 *
 * Note: Decision/pattern extraction is intentionally NOT done here.
 * Extraction happens in-session — Claude calls nexus_decide and
 * nexus_record_pattern via MCP tools as decisions are made.
 *
 * Hook config in ~/.claude/settings.json:
 * {
 *   "hooks": {
 *     "Stop": [{
 *       "hooks": [{
 *         "type": "command",
 *         "command": "node /path/to/nexus/packages/cli/dist/index.js hook post-session --quiet"
 *       }]
 *     }]
 *   }
 * }
 */

import { Command } from 'commander';
import path from 'node:path';
import { log } from '../lib/output.js';
import { openService } from '../lib/service.js';
import { detectConflicts } from '@nexus/core';

export function hookCommand(): Command {
  const cmd = new Command('hook');
  cmd.description('Lifecycle hook handlers (called by Claude Code hooks)');

  cmd
    .command('post-session')
    .description('Run after a Claude Code session ends — marks project seen and detects conflicts')
    .option('-p, --project-path <path>', 'Project directory (defaults to cwd)')
    .option('--session-id <id>', 'Claude session ID')
    .option('--dry-run', 'Show what would happen without persisting')
    .option('--quiet', 'Suppress output (for use in hooks)')
    .action(
      async (opts: {
        projectPath?: string;
        sessionId?: string;
        dryRun?: boolean;
        quiet?: boolean;
      }) => {
        const output = opts.quiet ? () => {} : log.info;
        const projectPath = path.resolve(opts.projectPath ?? process.cwd());

        const svc = openService();

        try {
          const project = svc.getProjectByPath(projectPath);
          if (!project) {
            if (!opts.quiet) {
              log.warn(`No Nexus project registered at: ${projectPath}`);
              log.dim('  Run `nexus project add` to register this directory.');
            }
            return;
          }

          // 1. Mark the project as seen
          if (!opts.dryRun) {
            svc.touchProject(project.id);
          }
          output(`Session recorded for: ${project.name}`);

          // 2. Conflict detection — compare this project's decisions against others
          const projectDecisions = svc.getDecisionsForProject(project.id);
          if (projectDecisions.length === 0) return;

          const otherProjects = svc
            .listProjects()
            .filter((p) => p.id !== project.id && svc.getDecisionsForProject(p.id).length > 0)
            .slice(0, 3); // cap at 3 to keep hook fast

          for (const other of otherProjects) {
            const otherDecisions = svc.getDecisionsForProject(other.id);

            try {
              const conflicts = await detectConflicts({
                projectA: { id: project.id, name: project.name, decisions: projectDecisions },
                projectB: { id: other.id, name: other.name, decisions: otherDecisions },
              });

              for (const conflict of conflicts) {
                if (!opts.dryRun) {
                  svc.recordConflict(conflict.projectIds, conflict.description, 'daemon');
                }
                if (!opts.quiet) {
                  log.warn(`Conflict with ${other.name}: ${conflict.description}`);
                }
              }
            } catch {
              // Conflict detection is best-effort — skip if auth unavailable
            }
          }
        } catch (err) {
          if (!opts.quiet) {
            log.error(`Hook failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          // Never exit non-zero — hooks must not block Claude Code
        } finally {
          svc.close();
        }
      },
    );

  return cmd;
}
