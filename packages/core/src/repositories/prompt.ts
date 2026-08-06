import { randomUUID } from 'node:crypto';
import type { NexusDb } from '../db/connection.js';
import { filterSecrets } from '../security/secret-filter.js';

/**
 * A request in the user's own words.
 *
 * Every other record in Nexus is inferred from a transcript after the work is
 * done. This is the only one captured at the moment of asking, which is what
 * makes it usable for warning about a collision before the work starts.
 */
export interface PromptRecord {
  id: string;
  projectId: string;
  sessionKey: string;
  prompt: string;
  createdAt: number;
}

interface PromptRow {
  id: string;
  project_id: string;
  session_key: string;
  prompt: string;
  created_at: number;
}

/**
 * Longest prompt retained. Past this the tail is dropped rather than the row
 * rejected: a pasted stack trace should still leave a record that it happened.
 */
export const MAX_PROMPT_CHARS = 20_000;

function toRecord(row: PromptRow): PromptRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionKey: row.session_key,
    prompt: row.prompt,
    createdAt: row.created_at,
  };
}

/**
 * Store a prompt, with secrets stripped first.
 *
 * Prompts are the highest-risk content Nexus holds — people paste tokens and
 * connection strings into them constantly — so filtering happens here rather
 * than at the call site, where it could be forgotten.
 *
 * Returns undefined for a prompt that is empty once trimmed; there is nothing
 * to learn from it and a row would only dilute the history.
 */
export function recordPrompt(
  db: NexusDb,
  input: { projectId: string; sessionKey: string; prompt: string },
): PromptRecord | undefined {
  const trimmed = input.prompt.trim();
  if (trimmed.length === 0) return undefined;

  const filtered = filterSecrets(trimmed).filtered.slice(0, MAX_PROMPT_CHARS);

  const record: PromptRecord = {
    id: randomUUID(),
    projectId: input.projectId,
    sessionKey: input.sessionKey,
    prompt: filtered,
    createdAt: Date.now(),
  };

  db.prepare(
    `INSERT INTO prompts (id, project_id, session_key, prompt, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(record.id, record.projectId, record.sessionKey, record.prompt, record.createdAt);

  return record;
}

/** Most recent prompts for a project, newest first. */
export function getRecentPrompts(db: NexusDb, projectId: string, limit = 20): PromptRecord[] {
  const rows = db
    .prepare('SELECT * FROM prompts WHERE project_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(projectId, limit) as PromptRow[];
  return rows.map(toRecord);
}

/** Prompts from one session, oldest first — the order they were asked in. */
export function getPromptsForSession(db: NexusDb, sessionKey: string): PromptRecord[] {
  const rows = db
    .prepare('SELECT * FROM prompts WHERE session_key = ? ORDER BY created_at ASC')
    .all(sessionKey) as PromptRow[];
  return rows.map(toRecord);
}

/** Drop prompts older than `maxAgeMs`. Returns the number removed. */
export function prunePrompts(db: NexusDb, maxAgeMs: number): number {
  const cutoff = Date.now() - maxAgeMs;
  return db.prepare('DELETE FROM prompts WHERE created_at < ?').run(cutoff).changes;
}
