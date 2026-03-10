import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrateDatabase } from '../db/migrations.js';
import { createProject } from './project.js';
import { auditLog, getAuditEntries, getAuditCountsByDay, getAuditCountsByOperation } from './audit.js';
import type { NexusDb } from '../db/connection.js';

function openTestDb(): NexusDb {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db);
  return db;
}

describe('AuditRepository — read queries', () => {
  let db: NexusDb;
  let projectId: string;

  beforeEach(() => {
    db = openTestDb();
    const project = createProject(db, { name: 'TestProject', path: '/test' });
    projectId = project.id;

    // Seed some audit entries
    auditLog(db, { operation: 'project.create', source: 'cli', projectId });
    auditLog(db, { operation: 'decision.create', source: 'mcp', projectId });
    auditLog(db, { operation: 'decision.create', source: 'mcp', projectId });
    auditLog(db, { operation: 'note.upsert', source: 'daemon', projectId });
  });

  afterEach(() => {
    db.close();
  });

  describe('getAuditEntries', () => {
    it('returns all entries ordered by at DESC', () => {
      const entries = getAuditEntries(db);
      // 4 seeded + 1 from createProject in beforeEach = 5
      expect(entries).toHaveLength(5);
      // Most recent first
      expect(entries[0]!.operation).toBe('note.upsert');
    });

    it('filters by source', () => {
      const entries = getAuditEntries(db, { source: 'mcp' });
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.source === 'mcp')).toBe(true);
    });

    it('filters by operation', () => {
      const entries = getAuditEntries(db, { operation: 'decision.create' });
      expect(entries).toHaveLength(2);
    });

    it('filters by projectId', () => {
      const other = createProject(db, { name: 'Other', path: '/other' });
      auditLog(db, { operation: 'pattern.upsert', source: 'cli', projectId: other.id });

      // createProject also logs an audit entry for 'other'
      const entries = getAuditEntries(db, { projectId: other.id });
      expect(entries).toHaveLength(2);
      expect(entries.some((e) => e.operation === 'pattern.upsert')).toBe(true);
    });

    it('respects limit', () => {
      const entries = getAuditEntries(db, { limit: 2 });
      expect(entries).toHaveLength(2);
    });
  });

  describe('getAuditCountsByDay', () => {
    it('returns counts grouped by day and source', () => {
      const counts = getAuditCountsByDay(db);
      expect(counts.length).toBeGreaterThan(0);
      // 4 seeded + 1 from createProject = 5
      const total = counts.reduce((s, c) => s + c.count, 0);
      expect(total).toBe(5);
    });

    it('returns proper date format', () => {
      const counts = getAuditCountsByDay(db);
      expect(counts[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('getAuditCountsByOperation', () => {
    it('returns counts grouped by operation', () => {
      const counts = getAuditCountsByOperation(db);
      // project.create (2 from createProject in beforeEach), decision.create (2), note.upsert (1)
      // Wait — only 1 createProject in beforeEach. So: project.create=1, project.create(cli)=1, decision.create=2, note.upsert=1
      // Actually createProject logs 'project.create' once. Our seed also logs 'project.create' once.
      // So project.create=2, decision.create=2, note.upsert=1
      expect(counts).toHaveLength(3);
      // Both project.create and decision.create have count 2, sorted DESC
      const decisionEntry = counts.find((c) => c.operation === 'decision.create');
      expect(decisionEntry!.count).toBe(2);
    });
  });
});
