import { randomUUID } from 'node:crypto';
import type { NexusDb } from '../db/connection.js';
import type { Conflict } from '../types/index.js';
import { auditLog } from './audit.js';
import { findDecisionsByProject } from './decision.js';

interface ConflictRow {
  id: string;
  project_ids: string;
  description: string;
  detected_at: number;
  resolved_at: number | null;
  resolution: string | null;
}

function rowToConflict(row: ConflictRow): Conflict {
  return {
    id: row.id,
    projectIds: JSON.parse(row.project_ids) as string[],
    description: row.description,
    detectedAt: row.detected_at,
    resolvedAt: row.resolved_at ?? undefined,
    resolution: row.resolution ?? undefined,
  };
}

export function findOpenConflicts(db: NexusDb, projectIds?: string[]): Conflict[] {
  const rows = db
    .prepare('SELECT * FROM conflicts WHERE resolved_at IS NULL ORDER BY detected_at DESC')
    .all() as ConflictRow[];
  const conflicts = rows.map(rowToConflict);
  if (!projectIds) return conflicts;
  return conflicts.filter((c) => c.projectIds.some((pid) => projectIds.includes(pid)));
}

export interface ConflictCheck {
  hasConflicts: boolean;
  conflicts: Conflict[];
  potentialConflicts: Array<{ topic: string; description: string }>;
}

export function checkConflicts(
  db: NexusDb,
  projectIds: string[],
  topic?: string,
): ConflictCheck {
  const existing = findOpenConflicts(db, projectIds);

  // Simple heuristic: look for decisions in different projects with the same kind
  // that might conflict (Phase 3 will do LLM-powered detection)
  const potentialConflicts: Array<{ topic: string; description: string }> = [];

  if (projectIds.length >= 2) {
    const decisionsByProject = projectIds.map((pid) => ({
      projectId: pid,
      decisions: findDecisionsByProject(db, pid),
    }));

    for (let i = 0; i < decisionsByProject.length; i++) {
      for (let j = i + 1; j < decisionsByProject.length; j++) {
        const aDecisions = decisionsByProject[i]!.decisions;
        const bDecisions = decisionsByProject[j]!.decisions;

        for (const a of aDecisions) {
          if (topic && !a.summary.toLowerCase().includes(topic.toLowerCase())) continue;
          for (const b of bDecisions) {
            if (topic && !b.summary.toLowerCase().includes(topic.toLowerCase())) continue;
            if (a.kind === b.kind && a.summary !== b.summary) {
              potentialConflicts.push({
                topic: `${a.kind} decision`,
                description: `Project ${decisionsByProject[i]!.projectId}: "${a.summary}" vs Project ${decisionsByProject[j]!.projectId}: "${b.summary}"`,
              });
            }
          }
        }
      }
    }
  }

  return {
    hasConflicts: existing.length > 0 || potentialConflicts.length > 0,
    conflicts: existing,
    potentialConflicts,
  };
}

export function createConflict(
  db: NexusDb,
  projectIds: string[],
  description: string,
  source: 'cli' | 'mcp' | 'daemon' = 'daemon',
): Conflict {
  const conflict: Conflict = {
    id: randomUUID(),
    projectIds,
    description,
    detectedAt: Date.now(),
  };

  db.prepare(
    'INSERT INTO conflicts (id, project_ids, description, detected_at) VALUES (?, ?, ?, ?)',
  ).run(conflict.id, JSON.stringify(conflict.projectIds), conflict.description, conflict.detectedAt);

  auditLog(db, { operation: 'conflict.create', source });
  return conflict;
}

export function resolveConflict(
  db: NexusDb,
  conflictId: string,
  resolution: string,
  source: 'cli' | 'mcp' | 'daemon' = 'cli',
): boolean {
  const result = db
    .prepare('UPDATE conflicts SET resolved_at = ?, resolution = ? WHERE id = ?')
    .run(Date.now(), resolution, conflictId);

  if (result.changes > 0) {
    auditLog(db, { operation: 'conflict.resolve', source, meta: { conflictId } });
    return true;
  }
  return false;
}
