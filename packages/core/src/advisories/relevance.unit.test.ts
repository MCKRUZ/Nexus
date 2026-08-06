import { describe, it, expect } from 'vitest';
import { significantTerms, rankCandidates, type Candidate } from './relevance.js';

describe('significantTerms', () => {
  it('drops the vocabulary of asking for work, which says nothing about the subject', () => {
    expect(significantTerms('please fix the failing test')).toEqual([]);
  });

  it('keeps identifiers whole so they stay high-signal', () => {
    const terms = significantTerms('call nexus_query against better-sqlite3');
    expect(terms).toContain('nexus_query');
    expect(terms).toContain('better-sqlite3');
  });

  it('deduplicates so repetition cannot inflate a score', () => {
    expect(significantTerms('sqlcipher sqlcipher sqlcipher')).toEqual(['sqlcipher']);
  });

  it('ignores bare numbers, which match arbitrary unrelated records', () => {
    expect(significantTerms('sqlcipher 12345 98765')).toEqual(['sqlcipher']);
  });
});

describe('rankCandidates', () => {
  const pool: Candidate[] = [
    { id: 'a', text: 'encrypt the database with sqlcipher before writing decisions' },
    { id: 'b', text: 'the database stores project registry rows' },
    { id: 'c', text: 'the database powers the dashboard charts' },
    { id: 'd', text: 'the database is queried by the mcp server' },
  ];

  it('stays silent when nothing meaningful overlaps', () => {
    expect(rankCandidates(significantTerms('what colour should the logo be'), pool)).toEqual([]);
  });

  it('stays silent on a single shared term, which is coincidence too often', () => {
    // "database" appears in every candidate and is the only overlap.
    expect(rankCandidates(significantTerms('inspect the database'), pool)).toEqual([]);
  });

  it('surfaces the record that shares rare terms, not the ones sharing common ones', () => {
    const matches = rankCandidates(significantTerms('switch sqlcipher encrypt settings'), pool);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.id).toBe('a');
  });

  it('ranks a candidate sharing rare terms above one sharing only ubiquitous terms', () => {
    const matches = rankCandidates(significantTerms('sqlcipher encrypt dashboard database'), pool);
    const ids = matches.map((m) => m.id);
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('c') === -1 ? Infinity : ids.indexOf('c'));
  });

  it('reports which terms matched so the hit can be explained', () => {
    const [top] = rankCandidates(significantTerms('sqlcipher encrypt the database'), pool);
    expect(top?.matchedTerms).toEqual(expect.arrayContaining(['sqlcipher', 'encrypt']));
  });

  it('can still match against a pool of one', () => {
    // The unsmoothed IDF form scores everything zero here, silencing the
    // advisory entirely for a project with a single recorded decision.
    const single: Candidate[] = [{ id: 'only', text: 'use sqlcipher for encryption at rest' }];
    const matches = rankCandidates(significantTerms('sqlcipher encryption approach'), single);
    expect(matches.map((m) => m.id)).toEqual(['only']);
  });

  it('caps how much it will ever say at once', () => {
    const many: Candidate[] = Array.from({ length: 20 }, (_, i) => ({
      id: `c${i}`,
      text: 'sqlcipher encryption rotation policy',
    }));
    expect(rankCandidates(significantTerms('sqlcipher encryption rotation'), many)).toHaveLength(3);
  });

  it('still speaks when every record shares the subject, rather than going quiet', () => {
    // Term rarity says a word in all 20 records discriminates between none of
    // them — true, but a project whose history is entirely about encryption is
    // exactly where a question about encryption deserves an answer. Rarity
    // orders the results; it does not decide whether to speak.
    const allAboutOneThing: Candidate[] = Array.from({ length: 20 }, (_, i) => ({
      id: `c${i}`,
      text: 'sqlcipher encryption rotation policy',
    }));
    expect(
      rankCandidates(significantTerms('sqlcipher encryption rotation'), allAboutOneThing).length,
    ).toBeGreaterThan(0);
  });

  it('handles an empty prompt and an empty pool without throwing', () => {
    expect(rankCandidates([], pool)).toEqual([]);
    expect(rankCandidates(significantTerms('sqlcipher encryption'), [])).toEqual([]);
  });

  it('orders deterministically when scores tie, so output does not flicker', () => {
    const tied: Candidate[] = [
      { id: 'zeta', text: 'sqlcipher encryption rotation' },
      { id: 'alpha', text: 'sqlcipher encryption rotation' },
    ];
    const ids = rankCandidates(significantTerms('sqlcipher encryption rotation'), tied).map((m) => m.id);
    expect(ids).toEqual(['alpha', 'zeta']);
  });
});
