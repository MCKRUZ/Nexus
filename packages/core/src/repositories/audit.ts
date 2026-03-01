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
