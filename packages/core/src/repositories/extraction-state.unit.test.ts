import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrateDatabase } from '../db/migrations.js';
import { createProject } from './project.js';
import {
  getExtractionState,
  getExtractionWatermark,
  setExtractionWatermark,
  pruneExtractionState,
} from './extraction-state.js';
import type { NexusDb } from '../db/connection.js';

describe('extraction state', () => {
  let db: NexusDb;
  let projectId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrateDatabase(db);
    projectId = createProject(db, { name: 'TestProject', path: '/test' }).id;
  });

  afterEach(() => {
    db.close();
  });

  it('reports a zero watermark for a session never extracted', () => {
    expect(getExtractionWatermark(db, 'unseen-session')).toBe(0);
    expect(getExtractionState(db, 'unseen-session')).toBeUndefined();
  });

  it('persists a watermark and reads it back', () => {
    setExtractionWatermark(db, 'session-a', projectId, 42);
    expect(getExtractionWatermark(db, 'session-a')).toBe(42);

    const state = getExtractionState(db, 'session-a');
    expect(state?.projectId).toBe(projectId);
    expect(state?.lastEventIndex).toBe(42);
    expect(state?.lastRunAt).toBeGreaterThan(0);
  });

  it('advances on repeat writes', () => {
    setExtractionWatermark(db, 'session-a', projectId, 10);
    setExtractionWatermark(db, 'session-a', projectId, 25);
    expect(getExtractionWatermark(db, 'session-a')).toBe(25);
  });

  it('never moves backwards', () => {
    // A shorter transcript means rotation or truncation, not work to redo.
    setExtractionWatermark(db, 'session-a', projectId, 30);
    setExtractionWatermark(db, 'session-a', projectId, 5);
    expect(getExtractionWatermark(db, 'session-a')).toBe(30);
  });

  it('tracks sessions independently', () => {
    setExtractionWatermark(db, 'session-a', projectId, 10);
    setExtractionWatermark(db, 'session-b', projectId, 3);
    expect(getExtractionWatermark(db, 'session-a')).toBe(10);
    expect(getExtractionWatermark(db, 'session-b')).toBe(3);
  });

  it('prunes rows older than the cutoff and keeps recent ones', () => {
    setExtractionWatermark(db, 'old-session', projectId, 1);
    db.prepare('UPDATE extraction_state SET last_run_at = ? WHERE session_key = ?')
      .run(Date.now() - 60 * 24 * 60 * 60 * 1000, 'old-session');
    setExtractionWatermark(db, 'fresh-session', projectId, 1);

    const removed = pruneExtractionState(db, 30 * 24 * 60 * 60 * 1000);

    expect(removed).toBe(1);
    expect(getExtractionState(db, 'old-session')).toBeUndefined();
    expect(getExtractionState(db, 'fresh-session')).toBeDefined();
  });

  it('drops state when its project is deleted', () => {
    setExtractionWatermark(db, 'session-a', projectId, 10);
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    expect(getExtractionState(db, 'session-a')).toBeUndefined();
  });
});
