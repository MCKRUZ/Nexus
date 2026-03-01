import { randomUUID } from 'node:crypto';
import type { NexusDb } from '../db/connection.js';
import type { Pattern } from '../types/index.js';
import { auditLog } from './audit.js';

interface PatternRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  example_path: string | null;
  frequency: number;
  last_seen_at: number;
}

function rowToPattern(row: PatternRow): Pattern {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    examplePath: row.example_path ?? undefined,
    frequency: row.frequency,
    lastSeenAt: row.last_seen_at,
  };
}

export function searchPatterns(db: NexusDb, query: string, projectId?: string): Pattern[] {
  const like = `%${query}%`;
  const rows = (
    projectId
      ? db
          .prepare(
            'SELECT * FROM patterns WHERE project_id = ? AND (name LIKE ? OR description LIKE ?) ORDER BY frequency DESC LIMIT 20',
          )
          .all(projectId, like, like)
      : db
          .prepare(
            'SELECT * FROM patterns WHERE name LIKE ? OR description LIKE ? ORDER BY frequency DESC LIMIT 20',
          )
          .all(like, like)
  ) as PatternRow[];
  return rows.map(rowToPattern);
}

export function findPatternsByProject(db: NexusDb, projectId: string): Pattern[] {
  const rows = db
    .prepare('SELECT * FROM patterns WHERE project_id = ? ORDER BY frequency DESC')
    .all(projectId) as PatternRow[];
  return rows.map(rowToPattern);
}

export interface UpsertPatternParams {
  projectId: string;
  name: string;
  description: string;
  examplePath?: string;
}

export function upsertPattern(
  db: NexusDb,
  params: UpsertPatternParams,
  source: 'cli' | 'mcp' | 'daemon' = 'daemon',
): Pattern {
  const existing = db
    .prepare('SELECT * FROM patterns WHERE project_id = ? AND name = ?')
    .get(params.projectId, params.name) as PatternRow | undefined;

  if (existing) {
    db.prepare(
      'UPDATE patterns SET frequency = frequency + 1, last_seen_at = ?, description = ? WHERE id = ?',
    ).run(Date.now(), params.description, existing.id);
    return rowToPattern({ ...existing, frequency: existing.frequency + 1, last_seen_at: Date.now() });
  }

  const pattern: Pattern = {
    id: randomUUID(),
    projectId: params.projectId,
    name: params.name,
    description: params.description,
    examplePath: params.examplePath,
    frequency: 1,
    lastSeenAt: Date.now(),
  };

  db.prepare(
    `INSERT INTO patterns (id, project_id, name, description, example_path, frequency, last_seen_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  ).run(
    pattern.id,
    pattern.projectId,
    pattern.name,
    pattern.description,
    pattern.examplePath ?? null,
    pattern.lastSeenAt,
  );

  auditLog(db, {
    operation: 'pattern.upsert',
    source,
    projectId: pattern.projectId,
    meta: { name: pattern.name },
  });

  return pattern;
}
