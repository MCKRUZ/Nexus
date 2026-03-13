/**
 * nexus backfill
 *
 * Retroactively enrich projects by scanning ~/.claude/projects/ JSONL files,
 * matching them to registered Nexus projects, and running LLM extraction
 * on sessions that haven't been processed.
 */

import { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { log } from '../lib/output.js';
import { openService } from '../lib/service.js';
import {
  listSessions,
  getSessionDetail,
  sessionToTranscript,
  extractFromTranscript,
} from '@nexus/core';
import type { Decision } from '@nexus/core';

function isLikelyDuplicate(newSummary: string, existing: Decision[]): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const n = norm(newSummary);
  return existing.some((d) => {
    const e = norm(d.summary);
    return e.includes(n.slice(0, 40)) || n.includes(e.slice(0, 40));
  });
}

export function backfillCommand(): Command {
  const cmd = new Command('backfill');
  cmd
    .description('Retroactively extract decisions/patterns from past Claude Code sessions')
    .option('--min-turns <n>', 'Minimum user turns to process a session', '5')
    .option('--max-sessions <n>', 'Maximum sessions to process per project', '3')
    .option('--dry-run', 'Show what would be extracted without saving')
    .option('--project <name>', 'Only backfill a specific project by name')
    .option('--migrate-paths', 'Also normalize existing DB paths (backslash → forward slash)')
    .action(
      async (opts: {
        minTurns: string;
        maxSessions: string;
        dryRun?: boolean;
        project?: string;
        migratePaths?: boolean;
      }) => {
        const minTurns = parseInt(opts.minTurns, 10);
        const maxSessions = parseInt(opts.maxSessions, 10);
        const claudeDir = path.join(os.homedir(), '.claude');

        const svc = openService();

        try {
          // Step 0: Optionally migrate paths
          if (opts.migratePaths && !opts.dryRun) {
            const migrated = svc.normalizeAllProjectPaths();
            if (migrated > 0) {
              log.info(`Migrated ${migrated} project path(s) to forward slashes.`);
            }
          }

          // Step 1: List all native sessions
          log.info('Scanning ~/.claude/projects/ for session transcripts...');
          const sessions = await listSessions(claudeDir);
          log.info(`Found ${sessions.length} session(s) across all projects.`);

          // Step 2: Get all registered projects, build a CWD → Project map
          const allProjects = svc.listProjects();
          const projectByPath = new Map<string, typeof allProjects[0]>();
          for (const p of allProjects) {
            // Normalize for cross-platform matching
            projectByPath.set(p.path.replace(/\\/g, '/').toLowerCase(), p);
          }

          // Step 3: Match sessions to projects
          const projectFilter = opts.project?.toLowerCase();
          const projectSessions = new Map<string, typeof sessions>();
          let matchedCount = 0;
          let unmatchedCount = 0;

          for (const session of sessions) {
            const normalizedCwd = session.cwd.replace(/\\/g, '/').toLowerCase();
            const project = projectByPath.get(normalizedCwd);
            if (!project) {
              unmatchedCount++;
              continue;
            }
            if (projectFilter && project.name.toLowerCase() !== projectFilter) {
              continue;
            }
            if (session.userTurns < minTurns) {
              continue;
            }
            const existing = projectSessions.get(project.id) ?? [];
            existing.push(session);
            projectSessions.set(project.id, existing);
            matchedCount++;
          }

          log.info(`Matched: ${matchedCount} session(s) to registered projects.`);
          if (unmatchedCount > 0) {
            log.dim(`  ${unmatchedCount} session(s) from unregistered project paths (skipped).`);
          }

          if (projectSessions.size === 0) {
            log.info('Nothing to backfill.');
            return;
          }

          // Step 4: Process each project
          let totalDecisions = 0;
          let totalPatterns = 0;
          let totalProcessed = 0;

          for (const [projectId, sessions] of projectSessions) {
            const project = allProjects.find((p) => p.id === projectId)!;
            const sessionsToProcess = sessions
              .sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime())
              .slice(0, maxSessions);

            log.info(`\n${project.name} (${sessionsToProcess.length} session(s) to process):`);
            const existingDecisions = svc.getDecisionsForProject(project.id);

            for (const session of sessionsToProcess) {
              try {
                const { events } = await getSessionDetail(session.jsonlPath);
                const transcript = sessionToTranscript(events);
                if (!transcript || transcript.length < 100) {
                  log.dim(`  Session ${session.sessionId.slice(0, 8)}… — transcript too short, skipping.`);
                  continue;
                }

                log.dim(`  Processing ${session.sessionId.slice(0, 8)}… (${session.userTurns} turns, ${session.lastActivityAt.slice(0, 10)})…`);
                const extracted = await extractFromTranscript({ transcript, maxChars: 12000 });

                let sessionDecisions = 0;
                let sessionPatterns = 0;

                for (const d of extracted.decisions) {
                  if (!isLikelyDuplicate(d.summary, existingDecisions)) {
                    if (!opts.dryRun) {
                      svc.recordDecision({
                        projectId: project.id,
                        kind: d.kind,
                        summary: d.summary,
                        ...(d.rationale ? { rationale: d.rationale } : {}),
                        ...(session.sessionId ? { sessionId: session.sessionId } : {}),
                      }, 'daemon');
                    }
                    sessionDecisions++;
                    // Add to existing to prevent duplicates within this run
                    existingDecisions.push({
                      id: '', projectId: project.id, kind: d.kind,
                      summary: d.summary, recordedAt: Date.now(),
                    });
                  }
                }

                for (const p of extracted.patterns) {
                  if (!opts.dryRun) {
                    svc.upsertPattern(
                      { projectId: project.id, name: p.name, description: p.description },
                      'daemon',
                    );
                  }
                  sessionPatterns++;
                }

                if (sessionDecisions > 0 || sessionPatterns > 0) {
                  log.info(`    → ${sessionDecisions} decision(s), ${sessionPatterns} pattern(s)${opts.dryRun ? ' (dry run)' : ''}`);
                } else {
                  log.dim(`    → nothing new extracted`);
                }

                totalDecisions += sessionDecisions;
                totalPatterns += sessionPatterns;
                totalProcessed++;

                // Mark project as seen if not dry run
                if (!opts.dryRun && !project.lastSeenAt) {
                  svc.touchProject(project.id);
                }
              } catch (err) {
                log.dim(`    → extraction failed: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }

          log.info(`\nBackfill complete${opts.dryRun ? ' (dry run)' : ''}:`);
          log.info(`  Sessions processed: ${totalProcessed}`);
          log.info(`  Decisions extracted: ${totalDecisions}`);
          log.info(`  Patterns extracted: ${totalPatterns}`);
        } catch (err) {
          log.error(`Backfill failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        } finally {
          svc.close();
        }
      },
    );

  return cmd;
}
