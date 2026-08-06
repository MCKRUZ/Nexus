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
import fs from 'node:fs';
import os from 'node:os';
import { log } from '../lib/output.js';
import { openService } from '../lib/service.js';
import {
  installHook,
  getClaudeSettingsPath,
  getClaudeHooksDir,
} from '../lib/settings.js';
import {
  analyzePortfolio,
  findRecentJsonlForProject,
  getSessionDetail,
  sessionToTranscript,
  extractFromTranscript,
  planIncrementalExtraction,
  isSimilarDecision,
  isSimilarPattern,
} from '@nexus/core';
import type { BudgetCheckResult, Conflict, LlmUsageInfo } from '@nexus/core';

/**
 * How long to keep per-session extraction watermarks. Claude Code never revisits
 * a closed transcript, so anything older is dead weight.
 */
const EXTRACTION_STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Floor between portfolio analyses for a project when nothing new was recorded.
 * Another project's decisions can change independently, so this still runs
 * several times a working day — it just stops firing on every keystroke-level stop.
 */
const PORTFOLIO_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Rough cost per 1M tokens by provider. Used for audit_log metadata only. */
const COST_PER_M_INPUT: Record<string, number> = {
  anthropic: 0.80,   // Haiku 4.5
  openrouter: 1.00,  // varies, conservative estimate
  ollama: 0,         // local
};
const COST_PER_M_OUTPUT: Record<string, number> = {
  anthropic: 4.00,
  openrouter: 5.00,
  ollama: 0,
};

function estimateLlmCost(usage: LlmUsageInfo): number {
  const inputRate = COST_PER_M_INPUT[usage.provider] ?? 1.0;
  const outputRate = COST_PER_M_OUTPUT[usage.provider] ?? 5.0;
  return (
    ((usage.inputTokens ?? 0) * inputRate) / 1_000_000 +
    ((usage.outputTokens ?? 0) * outputRate) / 1_000_000
  );
}

/**
 * Install session tracking hooks (.mjs files + settings.json entries).
 * Exported so `nexus init` wizard can call this directly.
 */
export function installSessionTrackingHooks(
  nexusRoot: string,
  dryRun?: boolean,
): { ok: boolean; error?: string } {
  const postToolSrc = path.join(nexusRoot, 'hooks', 'nexus-post-tool-use.mjs');
  const sessionStartSrc = path.join(nexusRoot, 'hooks', 'nexus-session-start.mjs');

  if (!fs.existsSync(postToolSrc) || !fs.existsSync(sessionStartSrc)) {
    return { ok: false, error: 'Hook source files not found. Ensure the Nexus repo has hooks/ directory.' };
  }

  const hooksDir = getClaudeHooksDir();

  if (!dryRun) {
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.copyFileSync(postToolSrc, path.join(hooksDir, 'nexus-post-tool-use.mjs'));
    fs.copyFileSync(sessionStartSrc, path.join(hooksDir, 'nexus-session-start.mjs'));

    installHook(
      'PostToolUse',
      `node --experimental-sqlite "${path.join(hooksDir, 'nexus-post-tool-use.mjs')}"`,
    );
    installHook(
      'SessionStart',
      `node --experimental-sqlite "${path.join(hooksDir, 'nexus-session-start.mjs')}"`,
    );
  }

  return { ok: true };
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

          // 0. Pipeline telemetry: hook started
          if (!opts.dryRun) {
            svc.emitPipelineEvent(project.id, 'pipeline.hook.start');
          }

          // 1. Mark the project as seen
          if (!opts.dryRun) {
            svc.touchProject(project.id);
          }
          output(`Session recorded for: ${project.name}`);

          // Whether this run added anything to the portfolio. Drives whether the
          // portfolio-wide LLM analysis below is worth running at all.
          let recordedSomethingNew = false;

          // 2. Auto-extract decisions/patterns from session transcript (best-effort)
          try {
            const claudeDir = path.join(os.homedir(), '.claude');
            const jsonlPath = findRecentJsonlForProject(projectPath, claudeDir);
            if (jsonlPath) {
              const { events } = await getSessionDetail(jsonlPath);

              // The Stop hook fires many times per session. Extract only the
              // turns added since the last run instead of re-reading the whole
              // transcript and paying to re-derive decisions already recorded.
              const sessionKey = path.basename(jsonlPath, '.jsonl');
              const watermark = svc.getExtractionWatermark(sessionKey);
              const plan = planIncrementalExtraction(events, watermark);

              if (plan.shouldExtract) {
                if (!opts.dryRun) {
                  svc.emitPipelineEvent(project.id, 'pipeline.extraction.start');
                }
                const transcript = sessionToTranscript(plan.events);
                const existing = svc.getDecisionsForProject(project.id);
                const extracted = await extractFromTranscript({ transcript, maxChars: 12000 });

                // Log LLM cost for extraction call
                if (!opts.dryRun && extracted.llmUsage) {
                  const costUsd = estimateLlmCost(extracted.llmUsage);
                  svc.emitPipelineEvent(project.id, 'pipeline.llm.call', {
                    provider: extracted.llmUsage.provider,
                    model: extracted.llmUsage.model ?? 'unknown',
                    input_tokens: String(extracted.llmUsage.inputTokens ?? 0),
                    output_tokens: String(extracted.llmUsage.outputTokens ?? 0),
                    cost_usd: costUsd.toFixed(6),
                    purpose: 'extraction',
                  });
                }

                let extractedDecisions = 0;
                let extractedPatterns = 0;
                for (const d of extracted.decisions) {
                  if (!opts.dryRun && !isSimilarDecision(d.summary, existing)) {
                    svc.recordDecision({
                      projectId: project.id,
                      kind: d.kind,
                      summary: d.summary,
                      ...(d.rationale ? { rationale: d.rationale } : {}),
                      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
                    }, 'daemon');
                    extractedDecisions++;
                  }
                }
                const existingPatterns = svc.getPatternsForProject(project.id);
                for (const p of extracted.patterns) {
                  if (!opts.dryRun) {
                    // Skip if a similar pattern already exists (fuzzy match)
                    if (isSimilarPattern(p.name, existingPatterns)) continue;
                    svc.upsertPattern(
                      { projectId: project.id, name: p.name, description: p.description, ...(p.examplePath ? { examplePath: p.examplePath } : {}) },
                      'daemon',
                    );
                    extractedPatterns++;
                  }
                }
                recordedSomethingNew = extractedDecisions > 0 || extractedPatterns > 0;

                if (!opts.dryRun) {
                  // Only advance the watermark once the run succeeded. A failure
                  // leaves these turns unread so the next Stop retries them.
                  svc.setExtractionWatermark(sessionKey, project.id, plan.nextWatermark);
                  svc.pruneExtractionState(EXTRACTION_STATE_TTL_MS);
                  svc.emitPipelineEvent(project.id, 'pipeline.extraction.success', {
                    decision_count: String(extractedDecisions),
                    pattern_count: String(extractedPatterns),
                    new_user_turns: String(plan.newUserTurns),
                    events_read: String(plan.events.length),
                    events_total: String(events.length),
                  });
                }
              } else {
                if (!opts.dryRun) {
                  svc.emitPipelineEvent(project.id, 'pipeline.hook.skip', {
                    reason: plan.skipReason ?? 'Nothing new to extract',
                  });
                }
              }
            } else {
              if (!opts.dryRun) {
                svc.emitPipelineEvent(project.id, 'pipeline.hook.skip', {
                  reason: 'No recent JSONL transcript found',
                });
              }
            }
          } catch (extractErr) {
            if (!opts.dryRun) {
              svc.emitPipelineEvent(project.id, 'pipeline.extraction.fail', {
                error: extractErr instanceof Error ? extractErr.message : 'Unknown error',
              });
            }
            // Never block session teardown
          }

          // 3. Retire decisions that later ones have overtaken.
          //
          // Runs BEFORE the sync so CLAUDE.md never publishes a decision that was
          // retired moments earlier, and here rather than at the point of writing
          // so it covers every route a decision arrives by — the extractor, the
          // MCP tool and the CLI all land in the same table.
          //
          // Gated on this run having recorded something. With no new decisions
          // there is nothing to reconcile, and each examination costs a model call.
          // DISABLED pending a fix. The first live run collapsed chains: each
          // decision retired its predecessor, every link individually defensible,
          // and the chain terminated on an unrelated decision — leaving nothing
          // in the base that stated where the database key lives. Re-enable only
          // once the adjudicator refuses restatements and chaining is blocked.
          const RECONCILE_ENABLED = false;
          try {
            if (RECONCILE_ENABLED && !opts.dryRun && recordedSomethingNew) {
              const since = svc.getLastReconcileRunAt(project.id) ?? 0;
              const reconciled = await svc.reconcileDecisions(project.id, since, 'daemon');
              svc.emitPipelineEvent(project.id, 'pipeline.reconcile.run', {
                examined: String(reconciled.examined),
                superseded: String(reconciled.superseded),
              });
              if (reconciled.superseded > 0) {
                output(`Retired ${reconciled.superseded} superseded decision(s)`);
              }
            } else if (!opts.dryRun) {
              svc.emitPipelineEvent(project.id, 'pipeline.reconcile.skip', {
                reason: 'No new decisions recorded this run',
              });
            }
          } catch {
            // Best-effort, like every other stage here — never block teardown.
          }

          // 4. Budget check — evaluate and log state transitions.
          // Runs BEFORE the sync so any active alert rides along in a single
          // CLAUDE.md write instead of triggering a second one.
          let budgetResults: BudgetCheckResult[] = [];
          try {
            if (!opts.dryRun) {
              budgetResults = await svc.checkBudgets();
              for (const result of budgetResults) {
                if (result.transition) {
                  const msg = `Budget "${result.configName}": ${result.transition.from} -> ${result.transition.to} ($${result.currentSpend.toFixed(2)})`;
                  if (result.status === 'critical') {
                    if (!opts.quiet) log.warn(`CRITICAL: ${msg}`);
                  } else if (result.status === 'warning') {
                    if (!opts.quiet) log.warn(`WARNING: ${msg}`);
                  } else if (!opts.quiet) {
                    output(`Budget cleared: ${result.configName}`);
                  }
                }
              }
            }
          } catch {
            // Budget check is best-effort — never block session teardown
          }

          // 5. Sync CLAUDE.md once so notes/decisions are ready for the next session
          try {
            if (!opts.dryRun) {
              svc.emitPipelineEvent(project.id, 'pipeline.sync.start');
              const hasActiveAlerts = budgetResults.some((r) => r.status !== 'clear' && !r.silenced);
              const syncUpdated = hasActiveAlerts
                ? svc.syncProject(project.id, budgetResults)
                : svc.syncProject(project.id);
              if (syncUpdated) {
                output(`CLAUDE.md synced: ${project.name}`);
              }
            }
          } catch (syncErr) {
            if (!opts.dryRun) {
              svc.emitPipelineEvent(project.id, 'pipeline.sync.fail', {
                error: syncErr instanceof Error ? syncErr.message : 'Unknown error',
              });
            }
            // Sync is best-effort — never block session teardown
          }

          // 6. Portfolio-level conflict detection (single LLM call).
          // Gated: with unchanged inputs this re-derives the same advisories every
          // stop, which dedup then discards. Run it when this session actually
          // added something, or when enough time has passed that another project
          // may have moved underneath us.
          const projectDecisions = svc.getDecisionsForProject(project.id);
          if (projectDecisions.length === 0) return;

          const lastPortfolioRun = svc.getLastPortfolioRunAt(project.id);
          const portfolioIsStale =
            lastPortfolioRun === null || Date.now() - lastPortfolioRun >= PORTFOLIO_MIN_INTERVAL_MS;

          if (!recordedSomethingNew && !portfolioIsStale) {
            if (!opts.dryRun) {
              svc.emitPipelineEvent(project.id, 'pipeline.portfolio.skip', {
                reason: 'No new decisions this run and last analysis is recent',
                minutes_since_last: String(Math.round((Date.now() - lastPortfolioRun) / 60_000)),
              });
            }
            return;
          }

          const allProjects = svc.listProjects();
          const { conflicts } = svc.checkConflicts([project.id]);
          const otherProjects = allProjects.filter((p) => p.id !== project.id);

          const focusProject = {
            id: project.id,
            name: project.name,
            decisions: projectDecisions,
            parentId: project.parentId as string | undefined,
            tags: project.tags as string[] | undefined,
          };

          // Build portfolio from ALL projects with decisions
          const portfolioProjects = otherProjects
            .map((p) => ({
              id: p.id,
              name: p.name,
              decisions: svc.getDecisionsForProject(p.id),
              parentId: p.parentId as string | undefined,
              tags: p.tags as string[] | undefined,
            }))
            .filter((p) => p.decisions.length > 0);

          if (portfolioProjects.length === 0) return;

          // Load existing to deduplicate
          const existingDescNorm = new Set(
            conflicts.map((c: Conflict) =>
              c.description.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80),
            ),
          );

          try {
            if (!opts.dryRun) {
              // Marks the analysis timestamp the gate above reads on the next run.
              svc.emitPipelineEvent(project.id, 'pipeline.portfolio.run', {
                trigger: recordedSomethingNew ? 'new_decisions' : 'stale',
                portfolio_size: String(portfolioProjects.length),
              });
            }
            const portfolioResult = await analyzePortfolio({
              focusProject,
              allProjects: portfolioProjects,
            });

            // Log LLM cost for portfolio analysis call
            if (!opts.dryRun && portfolioResult.llmUsage) {
              const costUsd = estimateLlmCost(portfolioResult.llmUsage);
              svc.emitPipelineEvent(project.id, 'pipeline.llm.call', {
                provider: portfolioResult.llmUsage.provider,
                model: portfolioResult.llmUsage.model ?? 'unknown',
                input_tokens: String(portfolioResult.llmUsage.inputTokens ?? 0),
                output_tokens: String(portfolioResult.llmUsage.outputTokens ?? 0),
                cost_usd: costUsd.toFixed(6),
                purpose: 'portfolio_analysis',
              });
            }

            for (const insight of portfolioResult.insights) {
              const norm = insight.description
                .toLowerCase()
                .replace(/[^a-z0-9]/g, '')
                .slice(0, 80);
              if (existingDescNorm.has(norm)) continue;

              if (!opts.dryRun) {
                svc.recordInsight(
                  insight.projectIds,
                  insight.description,
                  insight.tier,
                  insight.severity,
                  'daemon',
                );
              }
              existingDescNorm.add(norm);
              if (!opts.quiet) {
                if (insight.tier === 'conflict') {
                  log.warn(`Conflict: ${insight.description}`);
                } else {
                  log.info(`Advisory: ${insight.description}`);
                }
              }
            }
          } catch {
            // Portfolio analysis is best-effort — skip if auth unavailable
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

  cmd
    .command('install-session-tracking')
    .description('Install standalone session tracking hooks for compaction recovery')
    .option('--dry-run', 'Show what would happen without making changes')
    .action((opts: { dryRun?: boolean }) => {
      try {
        const nexusRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');
        const result = installSessionTrackingHooks(nexusRoot, opts.dryRun);
        if (!result.ok) {
          log.error(result.error ?? 'Failed to install session tracking hooks');
          return;
        }
        log.info('Session tracking hooks installed:');
        log.info('  PostToolUse  -> nexus-post-tool-use.mjs');
        log.info('  SessionStart -> nexus-session-start.mjs');
        log.info(`  Settings: ${getClaudeSettingsPath()}`);
        if (opts.dryRun) {
          log.dim('  (dry run — no changes made)');
        }
      } catch (err) {
        log.error(`Failed to install hooks: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  return cmd;
}
