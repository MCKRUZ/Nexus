import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrateDatabase } from '../db/migrations.js';
import { createProject } from './project.js';
import { createDecision, findDecisionsByProject, searchDecisions } from './decision.js';
import type { NexusDb } from '../db/connection.js';

function openTestDb(): NexusDb {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db);
  return db;
}

describe('DecisionRepository', () => {
  let db: NexusDb;
  let projectId: string;

  beforeEach(() => {
    db = openTestDb();
    const project = createProject(db, { name: 'TestProject', path: '/test' });
    projectId = project.id;
  });

  afterEach(() => {
    db.close();
  });

  describe('createDecision', () => {
    it('creates a decision with required fields', () => {
      const decision = createDecision(db, {
        projectId,
        kind: 'architecture',
        summary: 'Use layered architecture',
      });

      expect(decision.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(decision.kind).toBe('architecture');
      expect(decision.summary).toBe('Use layered architecture');
      expect(decision.projectId).toBe(projectId);
    });

    it('stores optional rationale', () => {
      const decision = createDecision(db, {
        projectId,
        kind: 'library',
        summary: 'Use Zod for validation',
        rationale: 'Type-safe and composable',
      });

      expect(decision.rationale).toBe('Type-safe and composable');
    });
  });

  describe('findDecisionsByProject', () => {
    it('returns only active (non-superseded) decisions', () => {
      createDecision(db, { projectId, kind: 'architecture', summary: 'Decision A' });
      createDecision(db, { projectId, kind: 'library', summary: 'Decision B' });

      const decisions = findDecisionsByProject(db, projectId);
      expect(decisions).toHaveLength(2);
    });
  });

  describe('searchDecisions', () => {
    it('finds decisions by summary text', () => {
      createDecision(db, { projectId, kind: 'library', summary: 'Use React for the frontend' });
      createDecision(db, { projectId, kind: 'library', summary: 'Use Express for the backend' });

      const results = searchDecisions(db, 'React');
      expect(results).toHaveLength(1);
      expect(results[0]!.summary).toContain('React');
    });

    it('scopes search to project when projectId provided', () => {
      const other = createProject(db, { name: 'Other', path: '/other' });
      createDecision(db, { projectId, kind: 'library', summary: 'Use React' });
      createDecision(db, { projectId: other.id, kind: 'library', summary: 'Use Vue' });

      const results = searchDecisions(db, 'Use', projectId);
      expect(results).toHaveLength(1);
      expect(results[0]!.summary).toContain('React');
    });
  });
});
