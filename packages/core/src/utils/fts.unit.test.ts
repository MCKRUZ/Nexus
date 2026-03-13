import { describe, it, expect } from 'vitest';
import { sanitizePorterQuery, sanitizeTrigramQuery, searchWithFallback, STOPWORDS } from './fts.js';

describe('sanitizePorterQuery', () => {
  it('quotes individual terms with AND', () => {
    expect(sanitizePorterQuery('pnpm workspaces', 'AND')).toBe('"pnpm" AND "workspaces"');
  });

  it('quotes individual terms with OR', () => {
    expect(sanitizePorterQuery('pnpm workspaces', 'OR')).toBe('"pnpm" OR "workspaces"');
  });

  it('strips FTS5 operators', () => {
    expect(sanitizePorterQuery('"hello" AND (world)', 'AND')).toBe('"hello" AND "world"');
  });

  it('filters stopwords', () => {
    expect(sanitizePorterQuery('is the pnpm for builds', 'AND')).toBe('"pnpm" AND "builds"');
  });

  it('returns empty string for all-stopword queries', () => {
    expect(sanitizePorterQuery('the and or is it', 'AND')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizePorterQuery('', 'AND')).toBe('');
  });

  it('handles special characters by splitting on them', () => {
    // Colons, stars, carets get replaced with spaces, producing separate terms
    expect(sanitizePorterQuery('foo:bar*baz^qux', 'AND')).toBe('"foo" AND "bar" AND "baz" AND "qux"');
  });
});

describe('sanitizeTrigramQuery', () => {
  it('filters terms shorter than 3 chars', () => {
    expect(sanitizeTrigramQuery('go is ok pnpm', 'AND')).toBe('"pnpm"');
  });

  it('keeps terms 3+ chars after stopword filter', () => {
    expect(sanitizeTrigramQuery('pnpm builds', 'OR')).toBe('"pnpm" OR "builds"');
  });

  it('returns empty for short-only terms', () => {
    expect(sanitizeTrigramQuery('go is me', 'AND')).toBe('');
  });
});

describe('searchWithFallback', () => {
  it('returns first non-empty result', () => {
    const result = searchWithFallback([
      () => [],
      () => [1, 2, 3],
      () => [4, 5],
    ]);
    expect(result).toEqual([1, 2, 3]);
  });

  it('returns empty if all layers are empty', () => {
    const result = searchWithFallback([
      () => [],
      () => [],
    ]);
    expect(result).toEqual([]);
  });

  it('returns first layer if non-empty', () => {
    const result = searchWithFallback([
      () => ['a'],
      () => ['b', 'c'],
    ]);
    expect(result).toEqual(['a']);
  });

  it('handles empty layers array', () => {
    expect(searchWithFallback([])).toEqual([]);
  });
});

describe('STOPWORDS', () => {
  it('contains common English stopwords', () => {
    expect(STOPWORDS.has('the')).toBe(true);
    expect(STOPWORDS.has('and')).toBe(true);
    expect(STOPWORDS.has('is')).toBe(true);
  });

  it('does not contain content words', () => {
    expect(STOPWORDS.has('pnpm')).toBe(false);
    expect(STOPWORDS.has('database')).toBe(false);
  });
});
