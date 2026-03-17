import { randomUUID } from 'node:crypto';
import type { NexusDb } from '../db/connection.js';
import type { Conflict, ConflictTier, ConflictSeverity } from '../types/index.js';
import { auditLog } from './audit.js';
import { findDecisionsByProject } from './decision.js';
import { findProjectById, findRelatedProjectIds } from './project.js';

interface ConflictRow {
  id: string;
  project_ids: string;
  description: string;
  tier: string;
  severity: string;
  detected_at: number;
  resolved_at: number | null;
  resolution: string | null;
}

function rowToConflict(row: ConflictRow): Conflict {
  return {
    id: row.id,
    projectIds: JSON.parse(row.project_ids) as string[],
    description: row.description,
    tier: row.tier as ConflictTier,
    severity: row.severity as ConflictSeverity,
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

export interface PotentialConflict {
  topic: string;
  description: string;
  projectA: string;
  projectB: string;
  summaryA: string;
  summaryB: string;
}

export interface ConflictCheck {
  hasConflicts: boolean;
  conflicts: Conflict[];
  advisories: Conflict[];
  potentialConflicts: PotentialConflict[];
}

const STOP_WORDS = new Set([
  'with', 'from', 'that', 'this', 'have', 'been', 'will', 'used', 'the',
  'for', 'and', 'all', 'use', 'via', 'into', 'when', 'than', 'only',
  'not', 'are', 'its', 'can', 'does', 'each', 'also', 'both', 'more',
  'input', 'based', 'ensure', 'using', 'without', 'instead', 'every',
]);

/** Extract meaningful keywords from a summary (lowercase, >3 chars, no stop words). */
function extractKeywords(summary: string): Set<string> {
  return new Set(
    summary
      .toLowerCase()
      .split(/[\s\-\/;:,.()]+/)
      .filter((w) => w.length > 3 && !STOP_WORDS.has(w)),
  );
}

/** Check if two summaries share enough keywords to suggest a genuine overlap. */
function hasSemanticOverlap(summaryA: string, summaryB: string): string[] {
  const kwA = extractKeywords(summaryA);
  const kwB = extractKeywords(summaryB);
  const shared: string[] = [];
  for (const w of kwA) {
    if (kwB.has(w)) shared.push(w);
  }
  return shared;
}

/** Build a topic from shared keywords + kind. */
function buildTopic(kind: string, sharedKeywords: string[]): string {
  if (sharedKeywords.length > 0) {
    return `${kind}: ${sharedKeywords.slice(0, 3).join(', ')}`;
  }
  return `${kind} decision`;
}

/** Resolve a project ID to its name, falling back to a truncated UUID. */
function projectName(db: NexusDb, id: string): string {
  const p = findProjectById(db, id);
  return p ? p.name : id.slice(0, 8);
}

export function checkConflicts(
  db: NexusDb,
  projectIds: string[],
  topic?: string,
): ConflictCheck {
  const existing = findOpenConflicts(db, projectIds);
  const conflicts = existing.filter((c) => c.tier === 'conflict');
  const advisories = existing.filter((c) => c.tier === 'advisory');

  const potentialConflicts: PotentialConflict[] = [];

  if (projectIds.length >= 2) {
    // Build relationship map: only compare pairs where at least one relationship exists
    const relatedPairs = new Set<string>();
    for (const pid of projectIds) {
      const related = findRelatedProjectIds(db, pid);
      for (const rid of related) {
        if (projectIds.includes(rid)) {
          // Canonical key so we don't duplicate pairs
          const key = pid < rid ? `${pid}|${rid}` : `${rid}|${pid}`;
          relatedPairs.add(key);
        }
      }
    }

    // If no relationships exist, return zero potential conflicts (no noise)
    if (relatedPairs.size > 0) {
      // Pre-fetch decisions for involved projects
      const decisionCache = new Map<string, ReturnType<typeof findDecisionsByProject>>();
      const getDecisions = (pid: string) => {
        let d = decisionCache.get(pid);
        if (!d) {
          d = findDecisionsByProject(db, pid);
          decisionCache.set(pid, d);
        }
        return d;
      };

      for (const pairKey of relatedPairs) {
        const [pidA, pidB] = pairKey.split('|') as [string, string];
        const aDecisions = getDecisions(pidA);
        const bDecisions = getDecisions(pidB);
        const nameA = projectName(db, pidA);
        const nameB = projectName(db, pidB);

        for (const a of aDecisions) {
          if (topic && !a.summary.toLowerCase().includes(topic.toLowerCase())) continue;
          for (const b of bDecisions) {
            if (topic && !b.summary.toLowerCase().includes(topic.toLowerCase())) continue;
            if (a.kind !== b.kind || a.summary === b.summary) continue;

            // Require at least 1 shared keyword to avoid noise
            const shared = hasSemanticOverlap(a.summary, b.summary);
            if (shared.length === 0) continue;

            potentialConflicts.push({
              topic: buildTopic(a.kind, shared),
              description: `${nameA}: "${a.summary}" vs ${nameB}: "${b.summary}"`,
              projectA: nameA,
              projectB: nameB,
              summaryA: a.summary,
              summaryB: b.summary,
            });
          }
        }
      }
    }
  }

  return {
    hasConflicts: conflicts.length > 0 || potentialConflicts.length > 0,
    conflicts,
    advisories,
    potentialConflicts,
  };
}

export function createConflict(
  db: NexusDb,
  projectIds: string[],
  description: string,
  source: 'cli' | 'mcp' | 'daemon' = 'daemon',
  tier: ConflictTier = 'conflict',
  severity: ConflictSeverity = 'medium',
): Conflict {
  const conflict: Conflict = {
    id: randomUUID(),
    projectIds,
    description,
    tier,
    severity,
    detectedAt: Date.now(),
  };

  db.prepare(
    'INSERT INTO conflicts (id, project_ids, description, tier, severity, detected_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(conflict.id, JSON.stringify(conflict.projectIds), conflict.description, conflict.tier, conflict.severity, conflict.detectedAt);

  auditLog(db, { operation: `${tier}.create`, source });
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

export function dismissAdvisory(
  db: NexusDb,
  conflictId: string,
  source: 'cli' | 'mcp' | 'daemon' = 'cli',
): boolean {
  const result = db
    .prepare('UPDATE conflicts SET resolved_at = ?, resolution = ? WHERE id = ? AND tier = ?')
    .run(Date.now(), 'dismissed', conflictId, 'advisory');

  if (result.changes > 0) {
    auditLog(db, { operation: 'advisory.dismiss', source, meta: { conflictId } });
    return true;
  }
  return false;
}
