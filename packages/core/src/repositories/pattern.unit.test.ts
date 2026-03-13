import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrateDatabase } from '../db/migrations.js';
import { createProject } from './project.js';
import { upsertPattern, deduplicatePatterns, findPatternsByProject } from './pattern.js';
import type { NexusDb } from '../db/connection.js';

function openTestDb(): NexusDb {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db);
  return db;
}

describe('deduplicatePatterns', () => {
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

  it('merges duplicate patterns and sums frequencies', () => {
    // Create two similar patterns with different frequencies
    upsertPattern(db, {
      projectId,
      name: 'Factory pattern for LLM provider creation',
      description: 'Use factory to create LLM providers',
    });
    // Bump frequency
    upsertPattern(db, {
      projectId,
      name: 'Factory pattern for LLM provider creation',
      description: 'Use factory to create LLM providers',
    });

    upsertPattern(db, {
      projectId,
      name: 'LLM provider factory pattern for creation and initialization',
      description: 'Create LLM providers via factory',
    });

    const result = deduplicatePatterns(db, projectId);

    expect(result.merged).toBe(1);
    expect(result.kept).toBe(1);
    expect(result.details).toHaveLength(1);
    expect(result.details[0].canonicalName).toBe('Factory pattern for LLM provider creation');

    // Verify the winner has combined frequency
    const remaining = findPatternsByProject(db, projectId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].frequency).toBe(3); // 2 + 1
  });

  it('keeps pattern with higher frequency as winner', () => {
    upsertPattern(db, { projectId, name: 'Error recovery with retry logic', description: 'Short desc' });
    // Create higher-frequency pattern with similar name
    upsertPattern(db, { projectId, name: 'Retry logic with error recovery handling', description: 'Longer description here' });
    upsertPattern(db, { projectId, name: 'Retry logic with error recovery handling', description: 'Longer description here' });

    const result = deduplicatePatterns(db, projectId);

    expect(result.merged).toBe(1);
    // Higher frequency wins
    expect(result.details[0].canonicalName).toBe('Retry logic with error recovery handling');
  });

  it('does not merge genuinely different patterns', () => {
    upsertPattern(db, { projectId, name: 'Repository pattern for data access', description: 'Desc A' });
    upsertPattern(db, { projectId, name: 'Multi-step build pipeline', description: 'Desc B' });

    const result = deduplicatePatterns(db, projectId);

    expect(result.merged).toBe(0);
    expect(result.kept).toBe(2);

    const remaining = findPatternsByProject(db, projectId);
    expect(remaining).toHaveLength(2);
  });

  it('dry run does not modify the database', () => {
    upsertPattern(db, { projectId, name: 'Factory pattern for LLM provider creation', description: 'A' });
    upsertPattern(db, { projectId, name: 'LLM provider factory pattern for creation and initialization', description: 'B' });

    const result = deduplicatePatterns(db, projectId, 0.5, 'cli', true);

    expect(result.merged).toBe(1);

    // Verify no actual changes
    const remaining = findPatternsByProject(db, projectId);
    expect(remaining).toHaveLength(2);
  });

  it('respects custom threshold', () => {
    upsertPattern(db, { projectId, name: 'Factory pattern for providers', description: 'A' });
    upsertPattern(db, { projectId, name: 'Provider factory pattern', description: 'B' });

    // Very high threshold should prevent merging
    const result = deduplicatePatterns(db, projectId, 0.95);
    expect(result.merged).toBe(0);
  });
});
