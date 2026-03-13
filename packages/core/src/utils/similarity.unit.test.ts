import { describe, it, expect } from 'vitest';
import { extractKeywords, keywordJaccard, isSimilarDecision, isSimilarPattern } from './similarity.js';
import type { Decision, Pattern } from '../types/index.js';

describe('extractKeywords', () => {
  it('lowercases, splits on whitespace, strips non-alnum', () => {
    const result = extractKeywords('Use Factory-Pattern for LLM providers!');
    expect(result).toContain('use');
    expect(result).toContain('factory');
    expect(result).toContain('pattern');
    expect(result).toContain('llm');
    expect(result).toContain('providers');
  });

  it('filters stopwords', () => {
    const result = extractKeywords('Use the factory for a provider');
    expect(result).not.toContain('the');
    expect(result).not.toContain('for');
    // 'a' is a stopword
    expect(result).not.toContain('a');
  });

  it('filters single-char words', () => {
    const result = extractKeywords('a b c hello world');
    expect(result).not.toContain('b');
    expect(result).not.toContain('c');
    expect(result).toContain('hello');
    expect(result).toContain('world');
  });

  it('splits on hyphens', () => {
    const result = extractKeywords('multi-provider LLM abstraction');
    expect(result).toContain('multi');
    expect(result).toContain('provider');
    expect(result).toContain('llm');
    expect(result).toContain('abstraction');
  });

  it('returns empty set for empty input', () => {
    expect(extractKeywords('').size).toBe(0);
  });
});

describe('keywordJaccard', () => {
  it('returns 1.0 for identical strings', () => {
    expect(keywordJaccard('factory pattern', 'factory pattern')).toBe(1.0);
  });

  it('returns 0 for completely disjoint strings', () => {
    expect(keywordJaccard('factory pattern', 'database migration')).toBe(0);
  });

  it('returns 1.0 for two empty strings', () => {
    expect(keywordJaccard('', '')).toBe(1.0);
  });

  it('returns 0 when one is empty', () => {
    expect(keywordJaccard('factory pattern', '')).toBe(0);
  });

  it('detects known duplicate pair with significant overlap', () => {
    const a = 'Use factory pattern for LLM provider creation';
    const b = 'LLM provider factory pattern for creation and initialization';
    const score = keywordJaccard(a, b);
    // Shares: factory, pattern, llm, provider, creation (5 of 7 union)
    expect(score).toBeGreaterThanOrEqual(0.5);
  });

  it('scores genuinely different decisions below 0.5', () => {
    const a = 'Use SQLCipher for database encryption';
    const b = 'Add rate limiting to public API endpoints';
    const score = keywordJaccard(a, b);
    expect(score).toBeLessThan(0.5);
  });
});

function makeDecision(summary: string, rationale?: string): Decision {
  return {
    id: crypto.randomUUID(),
    projectId: 'test-project',
    kind: 'architecture',
    summary,
    rationale,
    recordedAt: Date.now(),
  };
}

describe('isSimilarDecision', () => {
  it('returns undefined when no decisions exist', () => {
    expect(isSimilarDecision('anything', [])).toBeUndefined();
  });

  it('catches exact duplicates via fast path', () => {
    const existing = [makeDecision('Use factory pattern for LLM providers')];
    const result = isSimilarDecision('Use factory pattern for LLM providers', existing);
    expect(result).toBeDefined();
    expect(result?.summary).toBe(existing[0].summary);
  });

  it('catches reworded duplicates via Jaccard', () => {
    const existing = [makeDecision('Use factory pattern for LLM provider creation')];
    const result = isSimilarDecision(
      'LLM provider factory pattern for creation and initialization',
      existing,
    );
    expect(result).toBeDefined();
  });

  it('does not flag genuinely different decisions', () => {
    const existing = [makeDecision('Use SQLCipher for database encryption')];
    const result = isSimilarDecision(
      'Add rate limiting to public API endpoints',
      existing,
    );
    expect(result).toBeUndefined();
  });

  it('respects custom threshold', () => {
    const existing = [makeDecision('Use factory pattern for providers')];
    // With a very high threshold, even somewhat similar decisions should not match
    const result = isSimilarDecision('factory pattern usage', existing, 0.95);
    expect(result).toBeUndefined();
  });
});

function makePattern(name: string, description = '', frequency = 1): Pattern {
  return {
    id: crypto.randomUUID(),
    projectId: 'test-project',
    name,
    description,
    frequency,
    lastSeenAt: Date.now(),
  };
}

describe('isSimilarPattern', () => {
  it('returns undefined when no patterns exist', () => {
    expect(isSimilarPattern('anything', [])).toBeUndefined();
  });

  it('catches exact duplicates via fast path', () => {
    const existing = [makePattern('Iterative Error Recovery with Tool Chaining')];
    const result = isSimilarPattern('Iterative Error Recovery with Tool Chaining', existing);
    expect(result).toBeDefined();
    expect(result?.name).toBe(existing[0].name);
  });

  it('catches reworded pattern names via Jaccard', () => {
    const existing = [makePattern('Factory pattern for LLM provider creation')];
    const result = isSimilarPattern(
      'LLM provider factory pattern for creation and initialization',
      existing,
    );
    expect(result).toBeDefined();
  });

  it('does not flag genuinely different patterns', () => {
    const existing = [makePattern('Repository pattern for data access')];
    const result = isSimilarPattern(
      'Multi-step build pipeline with sequential phases',
      existing,
    );
    expect(result).toBeUndefined();
  });

  it('respects custom threshold', () => {
    const existing = [makePattern('Factory pattern for providers')];
    const result = isSimilarPattern('factory pattern usage', existing, 0.95);
    expect(result).toBeUndefined();
  });
});
