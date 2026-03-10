import { randomUUID } from 'node:crypto';
import type { NexusDb } from '../db/connection.js';
import type { Decision, DecisionKind } from '../types/index.js';
import { auditLog } from './audit.js';
import { filterSecrets } from '../security/secret-filter.js';

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
  const like = `%${query}%`;
  const rows = (
    projectId
      ? db
          .prepare(
            'SELECT * FROM decisions WHERE project_id = ? AND (summary LIKE ? OR rationale LIKE ?) ORDER BY recorded_at DESC LIMIT 20',
          )
          .all(projectId, like, like)
      : db
          .prepare(
            'SELECT * FROM decisions WHERE summary LIKE ? OR rationale LIKE ? ORDER BY recorded_at DESC LIMIT 20',
          )
          .all(like, like)
  ) as DecisionRow[];
  return rows.map(rowToDecision);
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
