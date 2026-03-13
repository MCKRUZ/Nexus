import { randomUUID } from 'node:crypto';
import type { NexusDb } from '../db/connection.js';
import type { Decision, DecisionKind } from '../types/index.js';
import { auditLog } from './audit.js';
import { filterSecrets } from '../security/secret-filter.js';
import { sanitizePorterQuery, sanitizeTrigramQuery, searchWithFallback } from '../utils/fts.js';
import { keywordJaccard } from '../utils/similarity.js';

interface DecisionRow {
  id: string;
  project_id: string;
  kind: string;
  summary: string;
  rationale: string | null;
  session_id: string | null;
  recorded_at: number;
  superseded_by: string | null;
}

function rowToDecision(row: DecisionRow): Decision {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as DecisionKind,
    summary: row.summary,
    rationale: row.rationale ?? undefined,
    sessionId: row.session_id ?? undefined,
    recordedAt: row.recorded_at,
    supersededBy: row.superseded_by ?? undefined,
  };
}

export function findDecisionsByProject(db: NexusDb, projectId: string): Decision[] {
  const rows = db
    .prepare(
      'SELECT * FROM decisions WHERE project_id = ? AND superseded_by IS NULL ORDER BY recorded_at DESC',
    )
    .all(projectId) as DecisionRow[];
  return rows.map(rowToDecision);
}

export function searchDecisions(db: NexusDb, query: string, projectId?: string): Decision[] {
  const ftsSearch = (table: string, ftsQuery: string): Decision[] => {
    if (!ftsQuery) return [];
    const sql = projectId
      ? `SELECT d.* FROM decisions d
         JOIN ${table} ON ${table}.entity_id = d.id
         WHERE ${table} MATCH ? AND d.project_id = ?
         ORDER BY bm25(${table}, 2.0, 1.0) LIMIT 20`
      : `SELECT d.* FROM decisions d
         JOIN ${table} ON ${table}.entity_id = d.id
         WHERE ${table} MATCH ?
         ORDER BY bm25(${table}, 2.0, 1.0) LIMIT 20`;
    const rows = (projectId
      ? db.prepare(sql).all(ftsQuery, projectId)
      : db.prepare(sql).all(ftsQuery)) as DecisionRow[];
    return rows.map(rowToDecision);
  };

  /** Fallback: list all decisions when FTS produces no usable query (e.g. "*", empty). */
  const listAll = (): Decision[] => {
    const sql = projectId
      ? 'SELECT * FROM decisions WHERE project_id = ? AND superseded_by IS NULL ORDER BY recorded_at DESC LIMIT 20'
      : 'SELECT * FROM decisions WHERE superseded_by IS NULL ORDER BY recorded_at DESC LIMIT 20';
    const rows = (projectId
      ? db.prepare(sql).all(projectId)
      : db.prepare(sql).all()) as DecisionRow[];
    return rows.map(rowToDecision);
  };

  const porterAnd = sanitizePorterQuery(query, 'AND');
  const porterOr = sanitizePorterQuery(query, 'OR');
  const trigramAnd = sanitizeTrigramQuery(query, 'AND');
  const trigramOr = sanitizeTrigramQuery(query, 'OR');

  return searchWithFallback([
    () => ftsSearch('decisions_fts', porterAnd),
    () => ftsSearch('decisions_fts', porterOr),
    () => ftsSearch('decisions_trigram', trigramAnd),
    () => ftsSearch('decisions_trigram', trigramOr),
    listAll,
  ]);
}

export interface CreateDecisionParams {
  projectId: string;
  kind: DecisionKind;
  summary: string;
  rationale?: string;
  sessionId?: string;
}

export function createDecision(
  db: NexusDb,
  params: CreateDecisionParams,
  source: 'cli' | 'mcp' | 'daemon' = 'mcp',
): Decision {
  const decision: Decision = {
    id: randomUUID(),
    projectId: params.projectId,
    kind: params.kind,
    summary: filterSecrets(params.summary).filtered,
    rationale: params.rationale ? filterSecrets(params.rationale).filtered : undefined,
    sessionId: params.sessionId,
    recordedAt: Date.now(),
  };

  db.prepare(
    `INSERT INTO decisions (id, project_id, kind, summary, rationale, session_id, recorded_at, superseded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    decision.id,
    decision.projectId,
    decision.kind,
    decision.summary,
    decision.rationale ?? null,
    decision.sessionId ?? null,
    decision.recordedAt,
  );

  auditLog(db, {
    operation: 'decision.create',
    source,
    projectId: decision.projectId,
    meta: { kind: decision.kind, summary: decision.summary.slice(0, 100) },
  });

  return decision;
}

export interface DeduplicateResult {
  kept: number;
  superseded: number;
  details: Array<{ supersededSummary: string; keptSummary: string }>;
}

/**
 * Find and supersede duplicate decisions for a project using keyword Jaccard similarity.
 * Keeps the decision with the longer rationale (or older if tied).
 */
export function supersedeDuplicateDecisions(
  db: NexusDb,
  projectId: string,
  threshold = 0.5,
  source: 'cli' | 'mcp' | 'daemon' = 'cli',
  dryRun = false,
): DeduplicateResult {
  const rows = db
    .prepare(
      'SELECT * FROM decisions WHERE project_id = ? AND superseded_by IS NULL ORDER BY recorded_at ASC',
    )
    .all(projectId) as DecisionRow[];

  const decisions = rows.map(rowToDecision);
  const supersededIds = new Set<string>();
  const details: DeduplicateResult['details'] = [];

  for (let i = 0; i < decisions.length; i++) {
    const di = decisions[i]!;
    if (supersededIds.has(di.id)) continue;

    for (let j = i + 1; j < decisions.length; j++) {
      const dj = decisions[j]!;
      if (supersededIds.has(dj.id)) continue;

      const score = keywordJaccard(di.summary, dj.summary);
      if (score < threshold) continue;

      // Decide which to keep: longer rationale wins, or older (lower index) if tied
      const iRatLen = di.rationale?.length ?? 0;
      const jRatLen = dj.rationale?.length ?? 0;

      const keep = jRatLen > iRatLen ? dj : di;
      const drop = jRatLen > iRatLen ? di : dj;

      supersededIds.add(drop.id);
      details.push({ supersededSummary: drop.summary, keptSummary: keep.summary });

      if (!dryRun) {
        db.prepare('UPDATE decisions SET superseded_by = ? WHERE id = ?').run(keep.id, drop.id);

        auditLog(db, {
          operation: 'decision.supersede',
          source,
          projectId,
          meta: {
            superseded_id: drop.id,
            kept_id: keep.id,
            jaccard_score: score.toFixed(3),
          },
        });
      }
    }
  }

  return {
    kept: decisions.length - supersededIds.size,
    superseded: supersededIds.size,
    details,
  };
}
