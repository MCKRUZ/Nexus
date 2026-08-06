import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type NexusDb } from '../db/connection.js';
import { migrateDatabase } from '../db/migrations.js';
import { createProject } from './project.js';
import {
  createConflict,
  findOpenConflicts,
  findOpenConflictsForProject,
  retireOpenAdvisories,
} from './conflict.js';

let db: NexusDb;
let dir: string;
let projectId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-conflict-'));
  db = openDatabase({ dbPath: path.join(dir, 'test.db'), encryptionKey: 'test-key' });
  migrateDatabase(db);
  projectId = createProject(db, { name: 'demo', path: path.join(dir, 'ws') }, 'cli').id;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const advisory = (text: string) =>
  createConflict(db, [projectId, 'other'], text, 'cli', 'advisory', 'info');
const conflict = (text: string) =>
  createConflict(db, [projectId, 'other'], text, 'cli', 'conflict', 'high');

describe('findOpenConflictsForProject', () => {
  it('excludes advisories, which are suggestions rather than problems', () => {
    advisory('you could reuse the caching pattern here');
    conflict('both projects claim the same port');

    const found = findOpenConflictsForProject(db, projectId);
    expect(found).toHaveLength(1);
    expect(found[0]?.description).toContain('same port');
  });

  it('excludes conflicts belonging to other projects', () => {
    createConflict(db, ['someone-else', 'and-another'], 'unrelated clash', 'cli', 'conflict', 'high');
    expect(findOpenConflictsForProject(db, projectId)).toHaveLength(0);
  });

  it('excludes resolved conflicts', () => {
    const c = conflict('both projects claim the same port');
    db.prepare('UPDATE conflicts SET resolved_at = ? WHERE id = ?').run(Date.now(), c.id);
    expect(findOpenConflictsForProject(db, projectId)).toHaveLength(0);
  });
});

describe('retireOpenAdvisories', () => {
  it('retires every open advisory and reports the count', () => {
    advisory('one');
    advisory('two');
    advisory('three');

    expect(retireOpenAdvisories(db, 'cli')).toBe(3);
    expect(findOpenConflicts(db).filter((c) => c.tier === 'advisory')).toHaveLength(0);
  });

  it('leaves real conflicts untouched', () => {
    advisory('a suggestion');
    conflict('a real problem');

    retireOpenAdvisories(db, 'cli');

    const open = findOpenConflicts(db);
    expect(open).toHaveLength(1);
    expect(open[0]?.tier).toBe('conflict');
  });

  it('keeps the rows rather than deleting them, so the decision is reversible', () => {
    advisory('worth keeping a record of');
    retireOpenAdvisories(db, 'cli');

    const row = db
      .prepare("SELECT resolution, resolved_at FROM conflicts WHERE tier = 'advisory'")
      .get() as { resolution: string; resolved_at: number };
    expect(row.resolution).toBe('tier-retired');
    expect(row.resolved_at).toBeGreaterThan(0);
  });

  it('is safe to run twice', () => {
    advisory('one');
    expect(retireOpenAdvisories(db, 'cli')).toBe(1);
    expect(retireOpenAdvisories(db, 'cli')).toBe(0);
  });

  it('records an audit entry so a bulk change is not silent', () => {
    advisory('one');
    retireOpenAdvisories(db, 'cli');

    const audit = db
      .prepare("SELECT count(*) n FROM audit_log WHERE operation = 'advisory.retire'")
      .get() as { n: number };
    expect(audit.n).toBe(1);
  });
});
