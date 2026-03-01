import { randomUUID } from 'node:crypto';
import type { NexusDb } from '../db/connection.js';
import type { Project } from '../types/index.js';
import { auditLog } from './audit.js';

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
  const row = db
    .prepare('SELECT * FROM projects WHERE path = ?')
    .get(projectPath) as ProjectRow | undefined;
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
    project.path,
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
  const existing = findProjectByPath(db, projectPath);
  if (!existing) return false;

  // Audit BEFORE delete so the FK is still valid
  auditLog(db, {
    operation: 'project.remove',
    source,
    projectId: existing.id,
    meta: { path: projectPath },
  });

  db.prepare('DELETE FROM projects WHERE path = ?').run(projectPath);

  return true;
}

export function touchProject(db: NexusDb, id: string): void {
  db.prepare('UPDATE projects SET last_seen_at = ? WHERE id = ?').run(Date.now(), id);
}
