/**
 * nexus hook post-session
 *
 * Called by Claude Code's Stop hook after each session ends.
 * Reads session metadata from stdin (JSON) or flags, runs LLM extraction,
 * and persists decisions/patterns/conflicts to the DB.
 *
 * Hook config in ~/.claude/settings.json:
 * {
 *   "hooks": {
 *     "Stop": [{
 *       "hooks": [{
 *         "type": "command",
 *         "command": "nexus hook post-session --project-path $CLAUDE_PROJECT_DIR"
 *       }]
 *     }]
 *   }
 * }
 */

import { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs';
import { log } from '../lib/output.js';
import { openService } from '../lib/service.js';
import { extractFromTranscript, extractFromFileSummary, detectConflicts } from '@nexus/core';
import type { DecisionKind } from '@nexus/core';

export function hookCommand(): Command {
  const cmd = new Command('hook');
  cmd.description('Lifecycle hook handlers (called by Claude Code hooks)');

  cmd
    .command('post-session')
    .description('Run after a Claude Code session ends — extracts decisions, patterns, and detects conflicts')
    .option('-p, --project-path <path>', 'Project directory (defaults to cwd)')
    .option('--transcript-file <file>', 'Path to session transcript file')
    .option('--summary <text>', 'Brief summary of what was done this session')
    .option('--files <list>', 'Comma-separated list of files modified this session')
    .option('--session-id <id>', 'Claude session ID')
    .option('--dry-run', 'Extract but do not persist (shows what would be saved)')
    .option('--quiet', 'Suppress output (for use in hooks)')
    .action(
      async (opts: {
        projectPath?: string;
        transcriptFile?: string;
        summary?: string;
        files?: string;
        sessionId?: string;
        dryRun?: boolean;
        quiet?: boolean;
      }) => {
        const output = opts.quiet ? () => {} : log.info;
        const projectPath = path.resolve(opts.projectPath ?? process.cwd());

        const svc = openService();
        let success = false;

        try {
          const project = svc.getProjectByPath(projectPath);
          if (!project) {
            if (!opts.quiet) {
              log.warn(`No Nexus project registered at: ${projectPath}`);
              log.dim('  Run `nexus project add` to register this project.');
            }
            return;
          }

          output(`Processing session for project: ${project.name}`);

          // Collect transcript or file list
          let extractionResult;

          if (opts.transcriptFile && fs.existsSync(opts.transcriptFile)) {
            const transcript = fs.readFileSync(opts.transcriptFile, 'utf8');
            output('Extracting from transcript...');
            extractionResult = await extractFromTranscript({ transcript });
          } else if (opts.summary || opts.files) {
            const filePaths = opts.files
              ? opts.files.split(',').map((f) => f.trim()).filter(Boolean)
              : [];
            output('Extracting from session summary...');
            extractionResult = await extractFromFileSummary({
              filePaths,
              sessionSummary: opts.summary ?? `Session in ${projectPath}`,
            });
          } else {
            // Nothing to extract from
            output('No transcript or summary provided — skipping extraction.');
            return;
          }

          const { decisions, patterns, preferences } = extractionResult;

          if (!opts.quiet) {
            log.plain(`  Found: ${decisions.length} decisions, ${patterns.length} patterns, ${preferences.length} preferences`);
          }

          if (opts.dryRun) {
            log.info('DRY RUN — nothing will be saved');
            if (decisions.length > 0) {
              log.plain('\nDecisions:');
              for (const d of decisions) log.plain(`  [${d.kind}] ${d.summary}`);
            }
            if (patterns.length > 0) {
              log.plain('\nPatterns:');
              for (const p of patterns) log.plain(`  ${p.name}: ${p.description}`);
            }
            if (preferences.length > 0) {
              log.plain('\nPreferences:');
              for (const pref of preferences) log.plain(`  ${pref.key} = ${pref.value}`);
            }
            return;
          }

          // Persist decisions
          for (const d of decisions) {
            if (d.confidence === 'low') continue; // skip low-confidence
            svc.recordDecision(
              {
                projectId: project.id,
                kind: d.kind as DecisionKind,
                summary: d.summary,
                ...(d.rationale ? { rationale: d.rationale } : {}),
                ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
              },
              'daemon',
            );
          }

          // Persist patterns
          for (const p of patterns) {
            svc.upsertPattern({ projectId: project.id, name: p.name, description: p.description }, 'daemon');
          }

          // Persist preferences
          for (const pref of preferences) {
            svc.setPreference(pref.key, pref.value, 'project', project.id, 'daemon');
          }

          // Run conflict detection against other projects (async, non-blocking for hook speed)
          const otherProjects = svc.listProjects().filter((p) => p.id !== project.id);

          if (otherProjects.length > 0 && decisions.length > 0) {
            const projectDecisions = svc.getDecisionsForProject(project.id);

            for (const other of otherProjects.slice(0, 3)) { // check top 3 related
              const otherDecisions = svc.getDecisionsForProject(other.id);
              if (otherDecisions.length === 0) continue;

              const conflicts = await detectConflicts({
                projectA: { id: project.id, name: project.name, decisions: projectDecisions },
                projectB: { id: other.id, name: other.name, decisions: otherDecisions },
              });

              for (const conflict of conflicts) {
                svc.recordConflict(conflict.projectIds, conflict.description, 'daemon');
                if (!opts.quiet) {
                  log.warn(`Conflict detected with ${other.name}: ${conflict.description}`);
                }
              }
            }
          }

          success = true;
          output(`Session processed. Saved ${decisions.filter((d) => d.confidence !== 'low').length} decisions, ${patterns.length} patterns.`);
        } catch (err) {
          if (!opts.quiet) {
            log.error(`Hook failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          // Don't exit non-zero for hooks — we don't want to block Claude Code
        } finally {
          svc.close();
        }

        void success;
      },
    );

  return cmd;
}
