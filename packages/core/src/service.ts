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
  type CreateProjectParams,
} from './repositories/project.js';
import {
  searchDecisions,
  findDecisionsByProject,
  createDecision,
  type CreateDecisionParams,
} from './repositories/decision.js';
import {
  searchPatterns,
  findPatternsByProject,
  upsertPattern,
  type UpsertPatternParams,
} from './repositories/pattern.js';
import {
  getPreference,
  setPreference,
  listPreferences,
} from './repositories/preference.js';
import { checkConflicts, createConflict, resolveConflict } from './repositories/conflict.js';
import {
  findNotesByProject,
  findNoteById,
  findNoteByTitle,
  searchNotes,
  upsertNote,
  deleteNote,
  type UpsertNoteParams,
} from './repositories/note.js';
import type { Project, Decision, Pattern, Preference, Conflict, Note } from './types/index.js';
import type { DecisionKind } from './types/index.js';

export type { UpsertNoteParams };

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
  ): Conflict {
    return createConflict(this.db, projectIds, description, source);
  }

  resolveConflict(
    conflictId: string,
    resolution: string,
    source: 'cli' | 'mcp' | 'daemon' = 'cli',
  ): boolean {
    return resolveConflict(this.db, conflictId, resolution, source);
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
