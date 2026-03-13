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
import { checkConflicts, createConflict, resolveConflict, dismissAdvisory } from './repositories/conflict.js';
import {
  findNotesByProject,
  findNoteById,
  findNoteByTitle,
  searchNotes,
  upsertNote,
  deleteNote,
  type UpsertNoteParams,
} from './repositories/note.js';
import type { Project, Decision, Pattern, Preference, Conflict, Note, AuditEntry, ConflictTier, ConflictSeverity } from './types/index.js';
import type { DecisionKind } from './types/index.js';
import { runDoctor, type DoctorReport } from './diagnostics/doctor.js';
import { emitPipelineEvent, getPipelineStats, getLlmCosts, type PipelineEvent, type PipelineStats, type LlmCostSummary } from './diagnostics/pipeline.js';
import { runDoctorFix, type DoctorFixResult } from './diagnostics/doctor-fix.js';
import { syncClaudeMd } from './sync/claude-md-sync.js';
import type { PortfolioEntry } from './sync/claude-md-sync.js';
import fs from 'node:fs';

export type { AuditQueryOptions, AuditCountByDay, AuditCountByOperation };

export type { UpsertNoteParams };
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

  syncProject(projectId: string): boolean {
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
    }));

    try {
      const result = syncClaudeMd({
        projectPath: project.path,
        notes,
        portfolio,
        decisions,
        conflicts: conflicts as Conflict[],
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

  emitPipelineEvent(
    projectId: string | undefined,
    operation: PipelineEvent,
    metadata?: Record<string, string>,
  ): void {
    emitPipelineEvent(this.db, projectId, operation, metadata);
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
