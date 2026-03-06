import { randomUUID } from 'node:crypto';
import type { NexusDb } from '../db/connection.js';
import type { Note } from '../types/index.js';
import { auditLog } from './audit.js';
import { filterSecrets } from '../security/secret-filter.js';

interface NoteRow {
  id: string;
  project_id: string;
  title: string;
  content: string;
  tags: string;
  created_at: number;
  updated_at: number;
  source: string;
}

function rowToNote(row: NoteRow): Note {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    content: row.content,
    tags: JSON.parse(row.tags) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    source: row.source,
  };
}

export function findNotesByProject(db: NexusDb, projectId: string): Note[] {
  const rows = db
    .prepare('SELECT * FROM notes WHERE project_id = ? ORDER BY updated_at DESC')
    .all(projectId) as NoteRow[];
  return rows.map(rowToNote);
}

export function findNoteById(db: NexusDb, id: string): Note | undefined {
  const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined;
  return row ? rowToNote(row) : undefined;
}

export function findNoteByTitle(db: NexusDb, projectId: string, title: string): Note | undefined {
  const row = db
    .prepare('SELECT * FROM notes WHERE project_id = ? AND title = ?')
    .get(projectId, title) as NoteRow | undefined;
  return row ? rowToNote(row) : undefined;
}

export function searchNotes(db: NexusDb, query: string, projectId?: string): Note[] {
  const like = `%${query}%`;
  const rows = (
    projectId
      ? db
          .prepare(
            'SELECT * FROM notes WHERE project_id = ? AND (title LIKE ? OR content LIKE ?) ORDER BY updated_at DESC LIMIT 20',
          )
          .all(projectId, like, like)
      : db
          .prepare(
            'SELECT * FROM notes WHERE title LIKE ? OR content LIKE ? ORDER BY updated_at DESC LIMIT 20',
          )
          .all(like, like)
  ) as NoteRow[];
  return rows.map(rowToNote);
}

export interface UpsertNoteParams {
  projectId: string;
  title: string;
  content: string;
  tags?: string[];
}

export function upsertNote(
  db: NexusDb,
  params: UpsertNoteParams,
  source: 'cli' | 'mcp' | 'daemon' = 'mcp',
): Note {
  const { filtered } = filterSecrets(params.content);
  const now = Date.now();
  const tags = JSON.stringify(params.tags ?? []);

  // Check for existing note with same project+title
  const existing = db
    .prepare('SELECT * FROM notes WHERE project_id = ? AND title = ?')
    .get(params.projectId, params.title) as NoteRow | undefined;

  if (existing) {
    db.prepare(
      'UPDATE notes SET content = ?, tags = ?, updated_at = ?, source = ? WHERE id = ?',
    ).run(filtered, tags, now, source, existing.id);

    auditLog(db, {
      operation: 'note.update',
      source,
      projectId: params.projectId,
      meta: { title: params.title.slice(0, 100) },
    });

    return rowToNote({ ...existing, content: filtered, tags, updated_at: now, source });
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO notes (id, project_id, title, content, tags, created_at, updated_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, params.projectId, params.title, filtered, tags, now, now, source);

  auditLog(db, {
    operation: 'note.create',
    source,
    projectId: params.projectId,
    meta: { title: params.title.slice(0, 100) },
  });

  const note: Note = {
    id,
    projectId: params.projectId,
    title: params.title,
    content: filtered,
    tags: params.tags ?? [],
    createdAt: now,
    updatedAt: now,
    source,
  };
  return note;
}

export function deleteNote(
  db: NexusDb,
  id: string,
  source: 'cli' | 'mcp' | 'daemon' = 'mcp',
): boolean {
  const existing = db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined;
  if (!existing) return false;

  auditLog(db, {
    operation: 'note.delete',
    source,
    projectId: existing.project_id,
    meta: { title: existing.title.slice(0, 100) },
  });

  db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  return true;
}
