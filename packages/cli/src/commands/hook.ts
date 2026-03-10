/**
 * nexus hook post-session
 *
 * Called by Claude Code's Stop hook after each session ends.
 * Responsibilities:
 *   1. Mark the project as seen (update lastSeenAt)
 *   2. Auto-extract decisions/patterns from session transcript (best-effort)
 *   3. Sync CLAUDE.md with latest knowledge
 *   4. Run conflict detection against other registered projects
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
import os from 'node:os';
import { log } from '../lib/output.js';
import { openService } from '../lib/service.js';
import {
  detectConflicts,
  syncClaudeMd,
  selectRelevantProjects,
  findRecentJsonlForProject,
  getSessionDetail,
  sessionToTranscript,
  extractFromTranscript,
} from '@nexus/core';
import type { Conflict, Decision } from '@nexus/core';

function isLikelyDuplicate(newSummary: string, existing: Decision[]): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const n = norm(newSummary);
  return existing.some((d) => {
    const e = norm(d.summary);
    return e.includes(n.slice(0, 40)) || n.includes(e.slice(0, 40));
  });
}

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

          // 2. Auto-extract decisions/patterns from session transcript (best-effort)
          try {
            const claudeDir = path.join(os.homedir(), '.claude');
            const jsonlPath = findRecentJsonlForProject(projectPath, claudeDir);
            if (jsonlPath) {
              const { events } = await getSessionDetail(jsonlPath);
              const userTurns = events.filter((e) => e.type === 'user').length;
              if (userTurns >= 5) {
                const transcript = sessionToTranscript(events);
                const existing = svc.getDecisionsForProject(project.id);
                const extracted = await extractFromTranscript({ transcript, maxChars: 12000 });
                for (const d of extracted.decisions) {
                  if (!opts.dryRun && !isLikelyDuplicate(d.summary, existing)) {
                    svc.recordDecision({
                      projectId: project.id,
                      kind: d.kind,
                      summary: d.summary,
                      ...(d.rationale ? { rationale: d.rationale } : {}),
                      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
                    }, 'daemon');
                  }
                }
                for (const p of extracted.patterns) {
                  if (!opts.dryRun) {
                    svc.upsertPattern(
                      { projectId: project.id, name: p.name, description: p.description, ...(p.examplePath ? { examplePath: p.examplePath } : {}) },
                      'daemon',
                    );
                  }
                }
              }
            }
          } catch {
            // Never block session teardown
          }

          const projectDecisions = svc.getDecisionsForProject(project.id);
          const allProjects = svc.listProjects();
          const { conflicts } = svc.checkConflicts([project.id]);
          const otherProjects = allProjects.filter((p) => p.id !== project.id);
          const relatedProjects = otherProjects
            .filter((p) => p.parentId === project.id || project.parentId === p.id)
            .map((p) => ({ name: p.name, path: p.path }));
          const allNotesMap = otherProjects.map((p) => ({
            projectName: p.name,
            project: p,
            notes: svc.getNotesForProject(p.id),
          }));
          const relatedProjectNotes = selectRelevantProjects(
            { project, notes: svc.getNotesForProject(project.id) },
            allNotesMap,
          );

          // 3. Sync CLAUDE.md so notes/decisions are ready for the next session
          try {
            if (!opts.dryRun) {
              const result = syncClaudeMd({
                projectPath: project.path,
                notes: svc.getNotesForProject(project.id),
                relatedProjectNotes,
                decisions: projectDecisions,
                patterns: svc.getPatternsForProject(project.id),
                preferences: svc.listPreferences(project.id),
                conflicts: conflicts as Conflict[],
                relatedProjects,
              });
              if (result.updated) {
                output(`CLAUDE.md synced: ${project.name}`);
              }
            }
          } catch {
            // Sync is best-effort — never block session teardown
          }

          // 4. Conflict detection — compare this project's decisions against others
          if (projectDecisions.length === 0) return;

          const conflictProjects = otherProjects
            .filter((p) => svc.getDecisionsForProject(p.id).length > 0)
            .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0)) // most-recently-active first
            .slice(0, 5);

          await Promise.all(
            conflictProjects.map(async (other) => {
              const otherDecisions = svc.getDecisionsForProject(other.id);
              try {
                const newConflicts = await detectConflicts({
                  projectA: { id: project.id, name: project.name, decisions: projectDecisions },
                  projectB: { id: other.id, name: other.name, decisions: otherDecisions },
                });
                for (const conflict of newConflicts) {
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
            }),
          );
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
