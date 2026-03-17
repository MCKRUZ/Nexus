import { randomUUID } from 'node:crypto';
import type { NexusDb } from '../db/connection.js';
import type { Project } from '../types/index.js';
import { auditLog } from './audit.js';

/** Normalize paths to forward slashes for consistent cross-platform matching. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  registered_at: number;
  last_seen_at: number | null;
  parent_id: string | null;
  tags: string;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    registeredAt: row.registered_at,
    lastSeenAt: row.last_seen_at ?? undefined,
    parentId: row.parent_id ?? undefined,
    tags: JSON.parse(row.tags) as string[],
  };
}

export function findAllProjects(db: NexusDb): Project[] {
  const rows = db
    .prepare('SELECT * FROM projects ORDER BY registered_at DESC')
    .all() as ProjectRow[];
  return rows.map(rowToProject);
}

export function findProjectByPath(db: NexusDb, projectPath: string): Project | undefined {
  const normalized = normalizePath(projectPath);
  const row = db
    .prepare('SELECT * FROM projects WHERE path = ?')
    .get(normalized) as ProjectRow | undefined;
  return row ? rowToProject(row) : undefined;
}

export function findProjectById(db: NexusDb, id: string): Project | undefined {
  const row = db
    .prepare('SELECT * FROM projects WHERE id = ?')
    .get(id) as ProjectRow | undefined;
  return row ? rowToProject(row) : undefined;
}

export interface CreateProjectParams {
  name: string;
  path: string;
  parentId?: string;
  tags?: string[];
}

export function createProject(
  db: NexusDb,
  params: CreateProjectParams,
  source: 'cli' | 'mcp' | 'daemon' = 'cli',
): Project {
  const project: Project = {
    id: randomUUID(),
    name: params.name,
    path: params.path,
    registeredAt: Date.now(),
    parentId: params.parentId,
    tags: params.tags ?? [],
  };

  db.prepare(
    `INSERT INTO projects (id, name, path, registered_at, last_seen_at, parent_id, tags)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    project.id,
    project.name,
    normalizePath(project.path),
    project.registeredAt,
    project.parentId ?? null,
    JSON.stringify(project.tags),
  );

  auditLog(db, {
    operation: 'project.create',
    source,
    projectId: project.id,
    meta: { name: project.name, path: project.path },
  });

  return project;
}

export function removeProject(
  db: NexusDb,
  projectPath: string,
  source: 'cli' | 'mcp' | 'daemon' = 'cli',
): boolean {
  const normalized = normalizePath(projectPath);
  const existing = findProjectByPath(db, normalized);
  if (!existing) return false;

  // Audit BEFORE delete so the FK is still valid
  auditLog(db, {
    operation: 'project.remove',
    source,
    projectId: existing.id,
    meta: { path: normalized },
  });

  db.prepare('DELETE FROM projects WHERE path = ?').run(normalized);

  return true;
}

export function updateProjectParentId(
  db: NexusDb,
  projectId: string,
  parentId: string,
  source: 'cli' | 'mcp' | 'daemon' = 'cli',
): void {
  auditLog(db, {
    operation: 'project.link',
    source,
    projectId,
    meta: { parentId },
  });

  db.prepare('UPDATE projects SET parent_id = ? WHERE id = ?').run(parentId, projectId);
}

export function touchProject(db: NexusDb, id: string): void {
  db.prepare('UPDATE projects SET last_seen_at = ? WHERE id = ?').run(Date.now(), id);
}

/**
 * Return the set of project IDs that are "related" to the given projectId:
 *  - shares the same parentId (siblings)
 *  - is a parent or child of the given project
 *  - shares at least one tag
 */
export function findRelatedProjectIds(db: NexusDb, projectId: string): Set<string> {
  const project = findProjectById(db, projectId);
  if (!project) return new Set();

  const related = new Set<string>();

  // Parent
  if (project.parentId) {
    related.add(project.parentId);
    // Siblings (other children of the same parent)
    const siblings = db
      .prepare('SELECT id FROM projects WHERE parent_id = ? AND id != ?')
      .all(project.parentId, projectId) as Array<{ id: string }>;
    for (const s of siblings) related.add(s.id);
  }

  // Children
  const children = db
    .prepare('SELECT id FROM projects WHERE parent_id = ?')
    .all(projectId) as Array<{ id: string }>;
  for (const c of children) related.add(c.id);

  // Shared tags
  if (project.tags.length > 0) {
    const allProjects = db
      .prepare('SELECT id, tags FROM projects WHERE id != ?')
      .all(projectId) as Array<{ id: string; tags: string }>;
    for (const row of allProjects) {
      const tags = JSON.parse(row.tags) as string[];
      if (tags.some((t) => project.tags.includes(t))) {
        related.add(row.id);
      }
    }
  }

  return related;
}
