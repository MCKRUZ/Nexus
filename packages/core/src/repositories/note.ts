import { randomUUID } from 'node:crypto';
import type { NexusDb } from '../db/connection.js';
import type { Note } from '../types/index.js';
import { auditLog } from './audit.js';
import { filterSecrets } from '../security/secret-filter.js';
import { sanitizePorterQuery, sanitizeTrigramQuery, searchWithFallback } from '../utils/fts.js';

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
  const ftsSearch = (table: string, ftsQuery: string): Note[] => {
    if (!ftsQuery) return [];
    const sql = projectId
      ? `SELECT n.* FROM notes n
         JOIN ${table} ON ${table}.entity_id = n.id
         WHERE ${table} MATCH ? AND n.project_id = ?
         ORDER BY bm25(${table}, 2.0, 1.0) LIMIT 20`
      : `SELECT n.* FROM notes n
         JOIN ${table} ON ${table}.entity_id = n.id
         WHERE ${table} MATCH ?
         ORDER BY bm25(${table}, 2.0, 1.0) LIMIT 20`;
    const rows = (projectId
      ? db.prepare(sql).all(ftsQuery, projectId)
      : db.prepare(sql).all(ftsQuery)) as NoteRow[];
    return rows.map(rowToNote);
  };

  /** Fallback: list all notes when FTS produces no usable query (e.g. "*", empty). */
  const listAll = (): Note[] => {
    const sql = projectId
      ? 'SELECT * FROM notes WHERE project_id = ? ORDER BY updated_at DESC LIMIT 20'
      : 'SELECT * FROM notes ORDER BY updated_at DESC LIMIT 20';
    const rows = (projectId
      ? db.prepare(sql).all(projectId)
      : db.prepare(sql).all()) as NoteRow[];
    return rows.map(rowToNote);
  };

  const porterAnd = sanitizePorterQuery(query, 'AND');
  const porterOr = sanitizePorterQuery(query, 'OR');
  const trigramAnd = sanitizeTrigramQuery(query, 'AND');
  const trigramOr = sanitizeTrigramQuery(query, 'OR');

  return searchWithFallback([
    () => ftsSearch('notes_fts', porterAnd),
    () => ftsSearch('notes_fts', porterOr),
    () => ftsSearch('notes_trigram', trigramAnd),
    () => ftsSearch('notes_trigram', trigramOr),
    listAll,
  ]);
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
