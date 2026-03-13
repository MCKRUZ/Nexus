import { randomUUID } from 'node:crypto';
import type { NexusDb } from '../db/connection.js';
import type { Pattern } from '../types/index.js';
import { auditLog } from './audit.js';
import { filterSecrets } from '../security/secret-filter.js';
import { sanitizePorterQuery, sanitizeTrigramQuery, searchWithFallback } from '../utils/fts.js';
import { keywordJaccard } from '../utils/similarity.js';

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
  const ftsSearch = (table: string, ftsQuery: string): Pattern[] => {
    if (!ftsQuery) return [];
    const sql = projectId
      ? `SELECT p.* FROM patterns p
         JOIN ${table} ON ${table}.entity_id = p.id
         WHERE ${table} MATCH ? AND p.project_id = ?
         ORDER BY bm25(${table}, 2.0, 1.0) LIMIT 20`
      : `SELECT p.* FROM patterns p
         JOIN ${table} ON ${table}.entity_id = p.id
         WHERE ${table} MATCH ?
         ORDER BY bm25(${table}, 2.0, 1.0) LIMIT 20`;
    const rows = (projectId
      ? db.prepare(sql).all(ftsQuery, projectId)
      : db.prepare(sql).all(ftsQuery)) as PatternRow[];
    return rows.map(rowToPattern);
  };

  /** Fallback: list all patterns when FTS produces no usable query (e.g. "*", empty). */
  const listAll = (): Pattern[] => {
    const sql = projectId
      ? 'SELECT * FROM patterns WHERE project_id = ? ORDER BY frequency DESC LIMIT 20'
      : 'SELECT * FROM patterns ORDER BY frequency DESC LIMIT 20';
    const rows = (projectId
      ? db.prepare(sql).all(projectId)
      : db.prepare(sql).all()) as PatternRow[];
    return rows.map(rowToPattern);
  };

  const porterAnd = sanitizePorterQuery(query, 'AND');
  const porterOr = sanitizePorterQuery(query, 'OR');
  const trigramAnd = sanitizeTrigramQuery(query, 'AND');
  const trigramOr = sanitizeTrigramQuery(query, 'OR');

  return searchWithFallback([
    () => ftsSearch('patterns_fts', porterAnd),
    () => ftsSearch('patterns_fts', porterOr),
    () => ftsSearch('patterns_trigram', trigramAnd),
    () => ftsSearch('patterns_trigram', trigramOr),
    listAll,
  ]);
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

  const safeDescription = filterSecrets(params.description).filtered;

  if (existing) {
    db.prepare(
      'UPDATE patterns SET frequency = frequency + 1, last_seen_at = ?, description = ? WHERE id = ?',
    ).run(Date.now(), safeDescription, existing.id);
    return rowToPattern({ ...existing, description: safeDescription, frequency: existing.frequency + 1, last_seen_at: Date.now() });
  }

  const pattern: Pattern = {
    id: randomUUID(),
    projectId: params.projectId,
    name: filterSecrets(params.name).filtered,
    description: safeDescription,
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

export interface PatternDeduplicateResult {
  kept: number;
  merged: number;
  details: Array<{ mergedName: string; canonicalName: string }>;
}

/**
 * Find and merge duplicate patterns for a project using keyword Jaccard similarity.
 * Keeps the pattern with higher frequency (or longer description if tied).
 * Sums frequencies, takes max last_seen_at, DELETEs the loser.
 */
export function deduplicatePatterns(
  db: NexusDb,
  projectId: string,
  threshold = 0.5,
  source: 'cli' | 'mcp' | 'daemon' = 'cli',
  dryRun = false,
): PatternDeduplicateResult {
  const rows = db
    .prepare(
      'SELECT * FROM patterns WHERE project_id = ? ORDER BY frequency DESC, last_seen_at DESC',
    )
    .all(projectId) as PatternRow[];

  const patterns = rows.map(rowToPattern);
  const mergedIds = new Set<string>();
  const details: PatternDeduplicateResult['details'] = [];

  for (let i = 0; i < patterns.length; i++) {
    const pi = patterns[i]!;
    if (mergedIds.has(pi.id)) continue;

    for (let j = i + 1; j < patterns.length; j++) {
      const pj = patterns[j]!;
      if (mergedIds.has(pj.id)) continue;

      const score = keywordJaccard(pi.name, pj.name);
      if (score < threshold) continue;

      // Decide winner: higher frequency, then longer description
      const iWins =
        pi.frequency > pj.frequency ||
        (pi.frequency === pj.frequency && pi.description.length >= pj.description.length);

      const keep = iWins ? pi : pj;
      const drop = iWins ? pj : pi;

      mergedIds.add(drop.id);
      details.push({ mergedName: drop.name, canonicalName: keep.name });

      if (!dryRun) {
        // Add loser's frequency to winner, take max last_seen_at
        const newFrequency = keep.frequency + drop.frequency;
        const newLastSeen = Math.max(keep.lastSeenAt, drop.lastSeenAt);
        db.prepare(
          'UPDATE patterns SET frequency = ?, last_seen_at = ? WHERE id = ?',
        ).run(newFrequency, newLastSeen, keep.id);

        // Update in-memory for subsequent comparisons
        keep.frequency = newFrequency;
        keep.lastSeenAt = newLastSeen;

        // DELETE the loser
        db.prepare('DELETE FROM patterns WHERE id = ?').run(drop.id);

        auditLog(db, {
          operation: 'pattern.merge',
          source,
          projectId,
          meta: {
            merged_id: drop.id,
            kept_id: keep.id,
            merged_name: drop.name,
            kept_name: keep.name,
            jaccard_score: score.toFixed(3),
          },
        });
      }
    }
  }

  return {
    kept: patterns.length - mergedIds.size,
    merged: mergedIds.size,
    details,
  };
}
