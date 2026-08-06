import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type NexusDb } from '../db/connection.js';
import { migrateDatabase } from '../db/migrations.js';
import { createProject } from '../repositories/project.js';
import { createDecision } from '../repositories/decision.js';
import { createConflict } from '../repositories/conflict.js';
import { getPromptsForSession, getRecentPrompts } from '../repositories/prompt.js';
import { buildPromptAdvisory } from './prompt-hook.js';

let db: NexusDb;
let dir: string;
let projectPath: string;
let projectId: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-prompt-'));
  db = openDatabase({ dbPath: path.join(dir, 'test.db'), encryptionKey: 'test-key' });
  migrateDatabase(db);

  projectPath = path.join(dir, 'workspace');
  fs.mkdirSync(projectPath, { recursive: true });
  const project = createProject(db, { name: 'demo', path: projectPath }, 'cli');
  projectId = project.id;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const ask = (prompt: string, sessionId = 'session-1') =>
  buildPromptAdvisory(db, { sessionId, cwd: projectPath, prompt });

describe('buildPromptAdvisory', () => {
  it('records what was asked', () => {
    const result = ask('should we move the sqlcipher key into the keychain');
    expect(result.recorded).toBe(true);

    const stored = getPromptsForSession(db, 'session-1');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.prompt).toContain('sqlcipher');
  });

  it('strips secrets before they reach the database', () => {
    // Prompts are where people paste credentials. Filtering has to happen on the
    // way in; there is no second chance once it is written.
    ask('deploy with token sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLL');

    const stored = getPromptsForSession(db, 'session-1');
    expect(stored[0]?.prompt).not.toContain('sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLL');
  });

  it('says nothing when there is no prior context to offer', () => {
    const result = ask('should we move the sqlcipher key into the keychain');
    expect(result.context).toBeNull();
    expect(result.matchCount).toBe(0);
  });

  it('surfaces a decision the request would collide with', () => {
    createDecision(
      db,
      {
        projectId,
        kind: 'security',
        summary: 'Store the sqlcipher key in the OS keychain, never in config.json',
        rationale: 'A key beside the database travels with any copy of the folder',
      },
      'cli',
    );

    const result = ask('lets put the sqlcipher key back in config.json for convenience');
    expect(result.context).toContain('Already decided');
    expect(result.context).toContain('OS keychain');
    expect(result.matchCount).toBeGreaterThan(0);
  });

  it('surfaces an open conflict touching the request', () => {
    createConflict(
      db,
      [projectId, 'a-second-project'],
      'jarvis-stack excludes anthropic models while nexus assumes claude via mcp',
      'cli',
      'conflict',
      'high',
    );

    const result = ask('switch the anthropic extraction models over to jarvis-stack routing');
    expect(result.context).toContain('Open conflicts');
    expect(result.context).toContain('jarvis-stack');
  });

  it('stays quiet on an unrelated request even with decisions on file', () => {
    createDecision(
      db,
      { projectId, kind: 'security', summary: 'Store the sqlcipher key in the OS keychain' },
      'cli',
    );

    expect(ask('what colour should the dashboard header be')?.context).toBeNull();
  });

  it('ignores a superseded decision rather than quoting stale guidance', () => {
    const old = createDecision(
      db,
      { projectId, kind: 'security', summary: 'Keep the sqlcipher key in config.json' },
      'cli',
    );
    const replacement = createDecision(
      db,
      { projectId, kind: 'security', summary: 'Key belongs in the OS credential store' },
      'cli',
    );
    db.prepare('UPDATE decisions SET superseded_by = ? WHERE id = ?').run(replacement.id, old.id);

    const result = ask('where does the sqlcipher key live in config.json');
    expect(result.context ?? '').not.toContain('Keep the sqlcipher key');
  });

  it('does nothing for a directory that is not a registered project', () => {
    const result = buildPromptAdvisory(db, {
      sessionId: 'session-1',
      cwd: path.join(dir, 'somewhere-else'),
      prompt: 'sqlcipher keychain question',
    });
    expect(result.recorded).toBe(false);
    expect(getRecentPrompts(db, projectId)).toHaveLength(0);
  });

  it('records nothing for an empty prompt', () => {
    ask('   ');
    expect(getRecentPrompts(db, projectId)).toHaveLength(0);
  });
});
