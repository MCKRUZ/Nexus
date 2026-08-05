import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { parseExtractionResponse } from './extractor.js';
import { upsertPattern } from '../repositories/pattern.js';
import { createDecision } from '../repositories/decision.js';
import { migrateDatabase } from '../db/migrations.js';
import { createProject } from '../repositories/project.js';

describe('parseExtractionResponse', () => {
  it('keeps well-formed items', () => {
    const raw = JSON.stringify({
      decisions: [
        { kind: 'architecture', summary: 'Use SQLCipher', rationale: 'local-first', confidence: 'high' },
      ],
      patterns: [{ name: 'Repo pattern', description: 'One repo per table' }],
      preferences: [{ key: 'pm', value: 'pnpm' }],
    });
    const result = parseExtractionResponse(raw);
    expect(result.decisions).toHaveLength(1);
    expect(result.patterns).toHaveLength(1);
    expect(result.preferences).toHaveLength(1);
    expect(result.droppedCount).toBe(0);
  });

  it('drops a pattern missing description instead of emitting undefined', () => {
    // The LLM omitting a required field is what crashed the Stop hook:
    // filterSecrets(undefined) -> undefined.replace(...)
    const raw = JSON.stringify({
      patterns: [{ name: 'Nameless' }, { name: 'Good', description: 'valid' }],
    });
    const result = parseExtractionResponse(raw);
    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0]?.name).toBe('Good');
    expect(result.patterns.every((p) => typeof p.description === 'string')).toBe(true);
    expect(result.droppedCount).toBe(1);
  });

  it('drops a decision missing summary', () => {
    const raw = JSON.stringify({
      decisions: [
        { kind: 'library', rationale: 'no summary field' },
        { kind: 'library', summary: 'Use vitest', confidence: 'high' },
      ],
    });
    const result = parseExtractionResponse(raw);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.summary).toBe('Use vitest');
    expect(result.droppedCount).toBe(1);
  });

  it('drops a decision with an unknown kind', () => {
    const raw = JSON.stringify({
      decisions: [{ kind: 'telepathy', summary: 'Guess the requirements', confidence: 'high' }],
    });
    expect(parseExtractionResponse(raw).decisions).toHaveLength(0);
  });

  it('defaults missing confidence to medium rather than dropping the decision', () => {
    const raw = JSON.stringify({
      decisions: [{ kind: 'naming', summary: 'kebab-case filenames' }],
    });
    const result = parseExtractionResponse(raw);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.confidence).toBe('medium');
  });

  it('returns empty result for non-JSON, null, and non-object payloads', () => {
    for (const raw of ['I could not find anything.', 'null', '{"decisions": "not-an-array"}']) {
      const result = parseExtractionResponse(raw);
      expect(result.decisions).toEqual([]);
      expect(result.patterns).toEqual([]);
      expect(result.preferences).toEqual([]);
    }
  });

  it('unwraps JSON fenced in markdown', () => {
    const raw = '```json\n{"patterns":[{"name":"A","description":"B"}]}\n```';
    expect(parseExtractionResponse(raw).patterns).toHaveLength(1);
  });
});

describe('extraction output is safe to persist', () => {
  it('every parsed item survives the repository write path', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrateDatabase(db);
    const project = createProject(db, { name: 'p', path: '/tmp/p' });

    const raw = JSON.stringify({
      decisions: [{ kind: 'other', summary: 'S' }, { kind: 'other' }],
      patterns: [{ name: 'N', description: 'D' }, { name: 'Broken' }],
    });
    const parsed = parseExtractionResponse(raw);

    // Would throw "Cannot read properties of undefined (reading 'replace')" pre-fix.
    for (const d of parsed.decisions) {
      expect(() =>
        createDecision(
          db,
          { projectId: project.id, kind: d.kind, summary: d.summary, ...(d.rationale ? { rationale: d.rationale } : {}) },
          'test',
        ),
      ).not.toThrow();
    }
    for (const p of parsed.patterns) {
      expect(() =>
        upsertPattern(db, { projectId: project.id, name: p.name, description: p.description }, 'test'),
      ).not.toThrow();
    }

    db.close();
  });
});
