/**
 * NexusService — the main entry point for all Nexus operations.
 * Both CLI and MCP packages should use this instead of calling repositories directly.
 */

import { openDatabase, type NexusDb } from './db/connection.js';
import { migrateDatabase } from './db/migrations.js';
import { readConfig, DB_FILE } from './config/index.js';
import {
  findAllProjects,
  findProjectByPath,
  findProjectById,
  createProject,
  removeProject,
  touchProject,
  updateProjectParentId,
  type CreateProjectParams,
} from './repositories/project.js';
import {
  searchDecisions,
  findDecisionsByProject,
  createDecision,
  supersedeDuplicateDecisions,
  type CreateDecisionParams,
  type DeduplicateResult,
} from './repositories/decision.js';
import {
  getAuditEntries,
  getAuditCountsByDay,
  getAuditCountsByOperation,
  type AuditQueryOptions,
  type AuditCountByDay,
  type AuditCountByOperation,
} from './repositories/audit.js';
import {
  searchPatterns,
  findPatternsByProject,
  upsertPattern,
  deduplicatePatterns,
  type UpsertPatternParams,
  type PatternDeduplicateResult,
} from './repositories/pattern.js';
import {
  getPreference,
  setPreference,
  listPreferences,
} from './repositories/preference.js';
import { checkConflicts, createConflict, resolveConflict, dismissAdvisory, analyzeImpact } from './repositories/conflict.js';
import {
  findNotesByProject,
  findNoteById,
  findNoteByTitle,
  searchNotes,
  upsertNote,
  deleteNote,
  type UpsertNoteParams,
} from './repositories/note.js';
import {
  upsertBudgetConfig,
  getBudgetConfigs,
  getGlobalBudgetConfigs,
  getBudgetConfigById,
  deleteBudgetConfig,
  silenceBudget as silenceBudgetRepo,
  unsilenceBudget as unsilenceBudgetRepo,
  evaluateBudget,
  getBudgetEvents,
  computePeriodStart,
  type UpsertBudgetParams,
} from './repositories/budget.js';
import {
  getExtractionWatermark,
  setExtractionWatermark,
  pruneExtractionState,
} from './repositories/extraction-state.js';
import { computeTokenAnalytics, computeSpendForPeriod } from './native/token-analytics.js';
import type { Project, Decision, Pattern, Preference, Conflict, Note, AuditEntry, ConflictTier, ConflictSeverity, ImpactResult, BudgetConfig, BudgetEvent, BudgetCheckResult } from './types/index.js';
import type { DecisionKind } from './types/index.js';
import { runDoctor, type DoctorReport } from './diagnostics/doctor.js';
import { emitPipelineEvent, getPipelineStats, getLlmCosts, getLastPortfolioRunAt, type PipelineEvent, type PipelineStats, type LlmCostSummary } from './diagnostics/pipeline.js';
import { runDoctorFix, type DoctorFixResult } from './diagnostics/doctor-fix.js';
import { syncClaudeMd } from './sync/claude-md-sync.js';
import type { PortfolioEntry } from './sync/claude-md-sync.js';
import { selectRelevantProjects } from './sync/relevance.js';
import type { ProjectCandidate } from './sync/relevance.js';
import fs from 'node:fs';

export type { AuditQueryOptions, AuditCountByDay, AuditCountByOperation };

export type { UpsertNoteParams };
export type { UpsertBudgetParams };
export type { DeduplicateResult };
export type { PatternDeduplicateResult };

export interface QueryOptions {
  query: string;
  projectId?: string;
  kinds?: Array<'decision' | 'pattern' | 'preference'>;
  limit?: number;
}

export interface QueryResult {
  decisions: Decision[];
  patterns: Pattern[];
  preferences: Preference[];
}

export class NexusService {
  private readonly db: NexusDb;

  private constructor(db: NexusDb) {
    this.db = db;
  }

  static open(dbPath?: string): NexusService {
    const config = readConfig();
    const db = openDatabase({
      dbPath: dbPath ?? DB_FILE,
      encryptionKey: config.encryptionKey,
    });
    migrateDatabase(db);
    return new NexusService(db);
  }

  close(): void {
    this.db.close();
  }

  // ─── Projects ──────────────────────────────────────────────────────────────

  listProjects(): Project[] {
    return findAllProjects(this.db);
  }

  getProjectByPath(projectPath: string): Project | undefined {
    return findProjectByPath(this.db, projectPath);
  }

  getProjectById(id: string): Project | undefined {
    return findProjectById(this.db, id);
  }

  addProject(
    params: CreateProjectParams,
    source: 'cli' | 'mcp' | 'daemon' = 'cli',
  ): Project {
    return createProject(this.db, params, source);
  }

  removeProject(projectPath: string, source: 'cli' | 'mcp' | 'daemon' = 'cli'): boolean {
    return removeProject(this.db, projectPath, source);
  }

  touchProject(id: string): void {
    touchProject(this.db, id);
  }

  setProjectParent(
    projectId: string,
    parentId: string,
    source: 'cli' | 'mcp' | 'daemon' = 'cli',
  ): void {
    updateProjectParentId(this.db, projectId, parentId, source);
  }

  // ─── Decisions ─────────────────────────────────────────────────────────────

  getDecisionsForProject(projectId: string): Decision[] {
    return findDecisionsByProject(this.db, projectId);
  }

  recordDecision(
    params: CreateDecisionParams,
    source: 'cli' | 'mcp' | 'daemon' = 'mcp',
  ): Decision {
    return createDecision(this.db, params, source);
  }

  deduplicateDecisions(
    projectId: string,
    threshold?: number,
    source: 'cli' | 'mcp' | 'daemon' = 'cli',
    dryRun = false,
  ): DeduplicateResult {
    return supersedeDuplicateDecisions(this.db, projectId, threshold, source, dryRun);
  }

  deduplicateAllDecisions(
    threshold?: number,
    source: 'cli' | 'mcp' | 'daemon' = 'cli',
    dryRun = false,
  ): { total: DeduplicateResult; perProject: Array<{ projectName: string; result: DeduplicateResult }> } {
    const projects = findAllProjects(this.db);
    const perProject: Array<{ projectName: string; result: DeduplicateResult }> = [];
    let totalKept = 0;
    let totalSuperseded = 0;
    const allDetails: DeduplicateResult['details'] = [];

    for (const project of projects) {
      const result = supersedeDuplicateDecisions(this.db, project.id, threshold, source, dryRun);
      if (result.superseded > 0) {
        perProject.push({ projectName: project.name, result });
      }
      totalKept += result.kept;
      totalSuperseded += result.superseded;
      allDetails.push(...result.details);
    }

    return {
      total: { kept: totalKept, superseded: totalSuperseded, details: allDetails },
      perProject,
    };
  }

  // ─── Patterns ──────────────────────────────────────────────────────────────

  getPatternsForProject(projectId: string): Pattern[] {
    return findPatternsByProject(this.db, projectId);
  }

  upsertPattern(
    params: UpsertPatternParams,
    source: 'cli' | 'mcp' | 'daemon' = 'daemon',
  ): Pattern {
    return upsertPattern(this.db, params, source);
  }

  deduplicatePatterns(
    projectId: string,
    threshold?: number,
    source: 'cli' | 'mcp' | 'daemon' = 'cli',
    dryRun = false,
  ): PatternDeduplicateResult {
    return deduplicatePatterns(this.db, projectId, threshold, source, dryRun);
  }

  deduplicateAllPatterns(
    threshold?: number,
    source: 'cli' | 'mcp' | 'daemon' = 'cli',
    dryRun = false,
  ): { total: PatternDeduplicateResult; perProject: Array<{ projectName: string; result: PatternDeduplicateResult }> } {
    const projects = findAllProjects(this.db);
    const perProject: Array<{ projectName: string; result: PatternDeduplicateResult }> = [];
    let totalKept = 0;
    let totalMerged = 0;
    const allDetails: PatternDeduplicateResult['details'] = [];

    for (const project of projects) {
      const result = deduplicatePatterns(this.db, project.id, threshold, source, dryRun);
      if (result.merged > 0) {
        perProject.push({ projectName: project.name, result });
      }
      totalKept += result.kept;
      totalMerged += result.merged;
      allDetails.push(...result.details);
    }

    return {
      total: { kept: totalKept, merged: totalMerged, details: allDetails },
      perProject,
    };
  }

  // ─── Preferences ───────────────────────────────────────────────────────────

  getPreference(key: string, projectId?: string): Preference | undefined {
    return getPreference(this.db, key, projectId);
  }

  setPreference(
    key: string,
    value: string,
    scope: 'global' | 'project',
    projectId?: string,
    source: 'cli' | 'mcp' | 'daemon' = 'mcp',
  ): Preference {
    return setPreference(this.db, key, value, scope, projectId, source);
  }

  listPreferences(projectId?: string): Preference[] {
    return listPreferences(this.db, projectId);
  }

  // ─── Conflicts ─────────────────────────────────────────────────────────────

  checkConflicts(
    projectIds: string[],
    topic?: string,
  ): ReturnType<typeof checkConflicts> {
    return checkConflicts(this.db, projectIds, topic);
  }

  recordConflict(
    projectIds: string[],
    description: string,
    source: 'cli' | 'mcp' | 'daemon' = 'daemon',
    tier: ConflictTier = 'conflict',
    severity: ConflictSeverity = 'medium',
  ): Conflict {
    return createConflict(this.db, projectIds, description, source, tier, severity);
  }

  recordInsight(
    projectIds: string[],
    description: string,
    tier: ConflictTier,
    severity: ConflictSeverity,
    source: 'cli' | 'mcp' | 'daemon' = 'daemon',
  ): Conflict {
    return createConflict(this.db, projectIds, description, source, tier, severity);
  }

  resolveConflict(
    conflictId: string,
    resolution: string,
    source: 'cli' | 'mcp' | 'daemon' = 'cli',
  ): boolean {
    return resolveConflict(this.db, conflictId, resolution, source);
  }

  dismissAdvisory(
    conflictId: string,
    source: 'cli' | 'mcp' | 'daemon' = 'cli',
  ): boolean {
    return dismissAdvisory(this.db, conflictId, source);
  }

  analyzeImpact(
    projectId: string,
    changeDescription: string,
    changeKind?: DecisionKind,
  ): ImpactResult {
    return analyzeImpact(this.db, projectId, changeDescription, changeKind);
  }

  // ─── Notes ─────────────────────────────────────────────────────────────────

  getNotesForProject(projectId: string): Note[] {
    return findNotesByProject(this.db, projectId);
  }

  getNoteById(id: string): Note | undefined {
    return findNoteById(this.db, id);
  }

  getNoteByTitle(projectId: string, title: string): Note | undefined {
    return findNoteByTitle(this.db, projectId, title);
  }

  searchNotes(query: string, projectId?: string): Note[] {
    return searchNotes(this.db, query, projectId);
  }

  upsertNote(
    params: UpsertNoteParams,
    source: 'cli' | 'mcp' | 'daemon' = 'mcp',
  ): Note {
    return upsertNote(this.db, params, source);
  }

  deleteNote(id: string, source: 'cli' | 'mcp' | 'daemon' = 'mcp'): boolean {
    return deleteNote(this.db, id, source);
  }

  // ─── Audit Log Queries ────────────────────────────────────────────────────

  getAuditEntries(opts?: AuditQueryOptions): AuditEntry[] {
    return getAuditEntries(this.db, opts);
  }

  getAuditCountsByDay(opts?: AuditQueryOptions): AuditCountByDay[] {
    return getAuditCountsByDay(this.db, opts);
  }

  getAuditCountsByOperation(opts?: AuditQueryOptions): AuditCountByOperation[] {
    return getAuditCountsByOperation(this.db, opts);
  }

  // ─── Cross-entity query ────────────────────────────────────────────────────

  query(opts: QueryOptions): QueryResult {
    const kinds = opts.kinds ?? ['decision', 'pattern', 'preference'];
    const limit = opts.limit ?? 10;

    const decisions = kinds.includes('decision')
      ? searchDecisions(this.db, opts.query, opts.projectId).slice(0, limit)
      : [];

    const patterns = kinds.includes('pattern')
      ? searchPatterns(this.db, opts.query, opts.projectId).slice(0, limit)
      : [];

    const preferences = kinds.includes('preference')
      ? listPreferences(this.db, opts.projectId).filter(
          (p) =>
            p.key.includes(opts.query) || p.value.toLowerCase().includes(opts.query.toLowerCase()),
        ).slice(0, limit)
      : [];

    return { decisions, patterns, preferences };
  }

  // ─── Diagnostics ─────────────────────────────────────────────────────────────

  getDoctorReport(): DoctorReport {
    return runDoctor(this.db);
  }

  syncProject(projectId: string, budgetAlerts?: BudgetCheckResult[]): boolean {
    const project = findProjectById(this.db, projectId);
    if (!project) return false;
    if (!fs.existsSync(project.path)) return false;

    const allProjects = findAllProjects(this.db);
    const decisions = this.getDecisionsForProject(project.id);
    const notes = this.getNotesForProject(project.id);
    const { conflicts } = this.checkConflicts([project.id]);

    const portfolio: PortfolioEntry[] = allProjects.map((p) => ({
      name: p.name,
      description: findNoteByTitle(this.db, p.id, 'Project Overview')?.content ?? '',
      tags: p.tags ?? [],
      isCurrent: p.id === project.id,
      ...(p.lastSeenAt !== undefined ? { lastSeenAt: p.lastSeenAt } : {}),
      ...(p.parentId !== undefined ? { parentId: p.parentId } : {}),
    }));

    // Build cross-project note candidates for relevance scoring
    const candidates: ProjectCandidate[] = allProjects
      .filter((p) => p.id !== project.id)
      .map((p) => ({
        projectName: p.name,
        project: { id: p.id, parentId: p.parentId, tags: p.tags },
        notes: findNotesByProject(this.db, p.id),
      }))
      .filter((c) => c.notes.length > 0);

    const relatedProjectNotes = selectRelevantProjects(
      { project: { id: project.id, parentId: project.parentId, tags: project.tags }, notes },
      candidates,
    );

    try {
      const result = syncClaudeMd({
        projectPath: project.path,
        notes,
        portfolio,
        decisions,
        conflicts: conflicts as Conflict[],
        relatedProjectNotes,
        budgetAlerts,
      });
      if (result.updated) {
        emitPipelineEvent(this.db, project.id, 'pipeline.sync.success');
      }
      return result.updated;
    } catch {
      emitPipelineEvent(this.db, project.id, 'pipeline.sync.fail');
      return false;
    }
  }

  runDoctorFix(): DoctorFixResult {
    return runDoctorFix(this);
  }

  getPipelineStats(projectId?: string, since?: number): PipelineStats {
    return getPipelineStats(this.db, projectId, since);
  }

  getLlmCosts(since?: number): LlmCostSummary {
    return getLlmCosts(this.db, since);
  }

  /** Epoch ms of the last portfolio analysis for a project, or null if never. */
  getLastPortfolioRunAt(projectId: string): number | null {
    return getLastPortfolioRunAt(this.db, projectId);
  }

  emitPipelineEvent(
    projectId: string | undefined,
    operation: PipelineEvent,
    metadata?: Record<string, string>,
  ): void {
    emitPipelineEvent(this.db, projectId, operation, metadata);
  }

  // ─── Incremental Extraction ──────────────────────────────────────────────

  /** Index of the first transcript event not yet extracted for this session. */
  getExtractionWatermark(sessionKey: string): number {
    return getExtractionWatermark(this.db, sessionKey);
  }

  setExtractionWatermark(sessionKey: string, projectId: string, eventIndex: number): void {
    setExtractionWatermark(this.db, sessionKey, projectId, eventIndex);
  }

  pruneExtractionState(maxAgeMs: number): number {
    return pruneExtractionState(this.db, maxAgeMs);
  }

  // ─── Budget Alerts ───────────────────────────────────────────────────────

  setBudget(
    params: UpsertBudgetParams,
    source: 'cli' | 'mcp' | 'daemon' = 'mcp',
  ): BudgetConfig {
    return upsertBudgetConfig(this.db, params, source);
  }

  getBudgets(projectId?: string): BudgetConfig[] {
    return getBudgetConfigs(this.db, projectId);
  }

  getAllBudgets(): BudgetConfig[] {
    return getBudgetConfigs(this.db);
  }

  getGlobalBudgets(): BudgetConfig[] {
    return getGlobalBudgetConfigs(this.db);
  }

  getBudgetById(id: string): BudgetConfig | undefined {
    return getBudgetConfigById(this.db, id);
  }

  deleteBudget(id: string, source: 'cli' | 'mcp' | 'daemon' = 'mcp'): boolean {
    return deleteBudgetConfig(this.db, id, source);
  }

  silenceBudget(
    configId: string,
    durationMs: number,
    source: 'cli' | 'mcp' | 'daemon' = 'mcp',
  ): boolean {
    return silenceBudgetRepo(this.db, configId, Date.now() + durationMs, source);
  }

  unsilenceBudget(
    configId: string,
    source: 'cli' | 'mcp' | 'daemon' = 'mcp',
  ): boolean {
    return unsilenceBudgetRepo(this.db, configId, source);
  }

  async checkBudgets(claudeDir?: string): Promise<BudgetCheckResult[]> {
    const resolvedDir = claudeDir ?? (await this.resolveClaudeDir());
    const configs = getBudgetConfigs(this.db);
    const enabledConfigs = configs.filter((c) => c.enabled);
    if (enabledConfigs.length === 0) return [];

    const analytics = await computeTokenAnalytics(resolvedDir, { sinceDays: 31 });
    const results: BudgetCheckResult[] = [];

    for (const config of enabledConfigs) {
      const periodStartDate = new Date(computePeriodStart(config.period)).toISOString().slice(0, 10);

      let projectCwd: string | undefined;
      let projectName: string | undefined;
      if (config.projectId) {
        const project = findProjectById(this.db, config.projectId);
        if (!project) continue;
        projectCwd = project.path;
        projectName = project.name;
      }

      const currentSpend = computeSpendForPeriod(analytics, periodStartDate, projectCwd);
      const { state, event } = evaluateBudget(this.db, config, currentSpend);
      const silenced = config.silencedUntil != null && config.silencedUntil > Date.now();

      results.push({
        configId: config.id,
        configName: config.name,
        ...(config.projectId ? { projectId: config.projectId } : {}),
        ...(projectName ? { projectName } : {}),
        period: config.period,
        status: state.status,
        currentSpend,
        warnAt: config.warnAt,
        critAt: config.critAt,
        percentUsed: config.critAt > 0 ? (currentSpend / config.critAt) * 100 : 0,
        silenced,
        ...(event ? { transition: { from: event.previousStatus, to: event.newStatus } } : {}),
      });
    }

    return results;
  }

  getBudgetHistory(configId?: string, limit?: number): BudgetEvent[] {
    return getBudgetEvents(this.db, configId, limit);
  }

  private async resolveClaudeDir(): Promise<string> {
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    return join(homedir(), '.claude');
  }

  // ─── Path normalization migration ─────────────────────────────────────────

  /** Migrate all project paths in DB from backslashes to forward slashes. */
  normalizeAllProjectPaths(): number {
    const projects = findAllProjects(this.db);
    let migrated = 0;
    for (const p of projects) {
      const normalized = p.path.replace(/\\/g, '/');
      if (normalized !== p.path) {
        this.db.prepare('UPDATE projects SET path = ? WHERE id = ?').run(normalized, p.id);
        migrated++;
      }
    }
    return migrated;
  }

  // ─── Cross-project dependency graph ────────────────────────────────────────

  getDependencyGraph(rootProjectId: string, depth = 2): Array<{ from: string; to: string }> {
    const edges: Array<{ from: string; to: string }> = [];
    const visited = new Set<string>();

    const traverse = (projectId: string, remainingDepth: number) => {
      if (visited.has(projectId) || remainingDepth === 0) return;
      visited.add(projectId);

      const children = findAllProjects(this.db).filter(
        (p) => p.parentId === projectId,
      );
      for (const child of children) {
        edges.push({ from: projectId, to: child.id });
        traverse(child.id, remainingDepth - 1);
      }
    };

    traverse(rootProjectId, depth);
    return edges;
  }

}
