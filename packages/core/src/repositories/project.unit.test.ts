import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrateDatabase } from '../db/migrations.js';
import {
  findAllProjects,
  findProjectByPath,
  createProject,
  removeProject,
} from './project.js';
import type { NexusDb } from '../db/connection.js';

function openTestDb(): NexusDb {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db);
  return db;
}

describe('ProjectRepository', () => {
  let db: NexusDb;

  beforeEach(() => {
    db = openTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('createProject', () => {
    it('creates a project with required fields', () => {
      const project = createProject(db, { name: 'MyApp', path: '/home/user/myapp' });

      expect(project.id).toMatch(/^[0-9a-f-]{36}$/); // UUID
      expect(project.name).toBe('MyApp');
      expect(project.path).toBe('/home/user/myapp');
      expect(project.tags).toEqual([]);
      expect(project.registeredAt).toBeGreaterThan(0);
    });

    it('stores and retrieves tags', () => {
      const project = createProject(db, {
        name: 'TaggedApp',
        path: '/home/user/tagged',
        tags: ['typescript', 'api'],
      });

      const retrieved = findProjectByPath(db, '/home/user/tagged');
      expect(retrieved?.tags).toEqual(['typescript', 'api']);
    });

    it('throws on duplicate path', () => {
      createProject(db, { name: 'App1', path: '/same/path' });
      expect(() => createProject(db, { name: 'App2', path: '/same/path' })).toThrow();
    });
  });

  describe('findAllProjects', () => {
    it('returns empty array when no projects', () => {
      expect(findAllProjects(db)).toEqual([]);
    });

    it('returns all projects', () => {
      createProject(db, { name: 'First', path: '/first' });
      createProject(db, { name: 'Second', path: '/second' });

      const projects = findAllProjects(db);
      expect(projects).toHaveLength(2);
      const names = projects.map((p) => p.name);
      expect(names).toContain('First');
      expect(names).toContain('Second');
    });
  });

  describe('findProjectByPath', () => {
    it('returns undefined for non-existent path', () => {
      expect(findProjectByPath(db, '/nonexistent')).toBeUndefined();
    });

    it('finds project by path', () => {
      createProject(db, { name: 'Found', path: '/found/path' });
      const found = findProjectByPath(db, '/found/path');
      expect(found?.name).toBe('Found');
    });
  });

  describe('removeProject', () => {
    it('removes project and returns true', () => {
      createProject(db, { name: 'ToRemove', path: '/to/remove' });
      const result = removeProject(db, '/to/remove');

      expect(result).toBe(true);
      expect(findProjectByPath(db, '/to/remove')).toBeUndefined();
    });

    it('returns false for non-existent path', () => {
      expect(removeProject(db, '/nonexistent')).toBe(false);
    });
  });
});
