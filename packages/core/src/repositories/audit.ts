import { randomUUID } from 'node:crypto';
import type { NexusDb } from '../db/connection.js';
import type { AuditEntry } from '../types/index.js';

export interface AuditParams {
  operation: string;
  source: AuditEntry['source'];
  projectId?: string;
  meta?: Record<string, string>;
}

export function auditLog(db: NexusDb, params: AuditParams): void {
  db.prepare(
    `INSERT INTO audit_log (id, operation, source, project_id, at, meta)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    params.operation,
    params.source,
    params.projectId ?? null,
    Date.now(),
    params.meta ? JSON.stringify(params.meta) : null,
  );
}

// ─── Read queries ────────────────────────────────────────────────────────────

interface AuditRow {
  id: string;
  operation: string;
  source: string;
  project_id: string | null;
  at: number;
  meta: string | null;
}

function rowToAuditEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    operation: row.operation,
    source: row.source as AuditEntry['source'],
    ...(row.project_id ? { projectId: row.project_id } : {}),
    at: row.at,
    ...(row.meta ? { meta: JSON.parse(row.meta) as Record<string, string> } : {}),
  };
}

export interface AuditQueryOptions {
  since?: number;
  until?: number;
  source?: AuditEntry['source'];
  projectId?: string;
  operation?: string;
  limit?: number;
}

function buildWhereClause(opts: AuditQueryOptions): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (opts.since != null) {
    clauses.push('at >= ?');
    params.push(opts.since);
  }
  if (opts.until != null) {
    clauses.push('at <= ?');
    params.push(opts.until);
  }
  if (opts.source) {
    clauses.push('source = ?');
    params.push(opts.source);
  }
  if (opts.projectId) {
    clauses.push('project_id = ?');
    params.push(opts.projectId);
  }
  if (opts.operation) {
    clauses.push('operation = ?');
    params.push(opts.operation);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

export function getAuditEntries(db: NexusDb, opts: AuditQueryOptions = {}): AuditEntry[] {
  const { where, params } = buildWhereClause(opts);
  const limit = opts.limit ?? 200;
  const rows = db
    .prepare(`SELECT * FROM audit_log ${where} ORDER BY at DESC LIMIT ?`)
    .all(...params, limit) as AuditRow[];
  return rows.map(rowToAuditEntry);
}

export interface AuditCountByDay {
  date: string;
  source: string;
  count: number;
}

export function getAuditCountsByDay(db: NexusDb, opts: AuditQueryOptions = {}): AuditCountByDay[] {
  const { where, params } = buildWhereClause(opts);
  const rows = db
    .prepare(
      `SELECT (at / 86400000) AS day_bucket, source, COUNT(*) AS cnt
       FROM audit_log ${where}
       GROUP BY day_bucket, source
       ORDER BY day_bucket ASC`,
    )
    .all(...params) as Array<{ day_bucket: number; source: string; cnt: number }>;

  return rows.map((r) => ({
    date: new Date(r.day_bucket * 86400000).toISOString().slice(0, 10),
    source: r.source,
    count: r.cnt,
  }));
}

export interface AuditCountByOperation {
  operation: string;
  count: number;
}

export function getAuditCountsByOperation(
  db: NexusDb,
  opts: AuditQueryOptions = {},
): AuditCountByOperation[] {
  const { where, params } = buildWhereClause(opts);
  const rows = db
    .prepare(
      `SELECT operation, COUNT(*) AS cnt
       FROM audit_log ${where}
       GROUP BY operation
       ORDER BY cnt DESC`,
    )
    .all(...params) as Array<{ operation: string; cnt: number }>;

  return rows.map((r) => ({
    operation: r.operation,
    count: r.cnt,
  }));
}
