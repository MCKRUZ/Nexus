import type { NexusDb } from '../db/connection.js';

/**
 * How far through a session transcript the extractor has already read.
 *
 * The Stop hook fires many times per session. Without a watermark every fire
 * re-reads the whole transcript and pays an LLM to re-derive decisions that were
 * already recorded. With one, each run only sees the turns added since last time.
 */
export interface ExtractionState {
  sessionKey: string;
  projectId: string;
  /** Index into the session's event list; everything before this was extracted. */
  lastEventIndex: number;
  lastRunAt: number;
}

interface ExtractionStateRow {
  session_key: string;
  project_id: string;
  last_event_index: number;
  last_run_at: number;
}

export function getExtractionState(db: NexusDb, sessionKey: string): ExtractionState | undefined {
  const row = db
    .prepare('SELECT * FROM extraction_state WHERE session_key = ?')
    .get(sessionKey) as ExtractionStateRow | undefined;
  if (!row) return undefined;
  return {
    sessionKey: row.session_key,
    projectId: row.project_id,
    lastEventIndex: row.last_event_index,
    lastRunAt: row.last_run_at,
  };
}

/** Index of the first event not yet extracted for this session (0 if never run). */
export function getExtractionWatermark(db: NexusDb, sessionKey: string): number {
  return getExtractionState(db, sessionKey)?.lastEventIndex ?? 0;
}

/**
 * Advance the watermark. Never moves backwards — a shorter event list means the
 * transcript was truncated or rotated, not that work should be redone.
 */
export function setExtractionWatermark(
  db: NexusDb,
  sessionKey: string,
  projectId: string,
  eventIndex: number,
): void {
  db.prepare(
    `INSERT INTO extraction_state (session_key, project_id, last_event_index, last_run_at)
       VALUES (?, ?, ?, ?)
     ON CONFLICT(session_key) DO UPDATE SET
       project_id       = excluded.project_id,
       last_event_index = MAX(extraction_state.last_event_index, excluded.last_event_index),
       last_run_at      = excluded.last_run_at`,
  ).run(sessionKey, projectId, eventIndex, Date.now());
}

/**
 * Drop watermarks older than `maxAgeMs`. Claude Code transcripts are per-session
 * and never revisited, so old rows are dead weight.
 */
export function pruneExtractionState(db: NexusDb, maxAgeMs: number): number {
  const cutoff = Date.now() - maxAgeMs;
  const result = db.prepare('DELETE FROM extraction_state WHERE last_run_at < ?').run(cutoff);
  return result.changes;
}
