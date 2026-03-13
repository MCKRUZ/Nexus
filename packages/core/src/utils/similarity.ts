/**
 * Keyword-based similarity utilities for decision deduplication.
 * Pure functions, zero new dependencies — reuses STOPWORDS from fts.ts.
 */

import { STOPWORDS } from './fts.js';
import type { Decision, Pattern } from '../types/index.js';

/** Lowercase, split on whitespace + hyphens, strip non-alnum, filter stopwords + single-char words. */
export function extractKeywords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[\s\-]+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ''))
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return new Set(words);
}

/** Jaccard index on keyword sets: |intersection| / |union|. */
export function keywordJaccard(a: string, b: string): number {
  const setA = extractKeywords(a);
  const setB = extractKeywords(b);
  if (setA.size === 0 && setB.size === 0) return 1.0;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Check if a new decision summary is similar to any existing decision.
 * Fast path: old 40-char substring match. Slow path: keyword Jaccard >= threshold.
 * Returns the matching Decision or undefined.
 */
export function isSimilarDecision(
  newSummary: string,
  existingDecisions: Decision[],
  threshold = 0.5,
): Decision | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const n = norm(newSummary);

  for (const d of existingDecisions) {
    const e = norm(d.summary);
    // Fast path: substring match on first 40 chars (preserves old behavior)
    if (e.includes(n.slice(0, 40)) || n.includes(e.slice(0, 40))) {
      return d;
    }
    // Slow path: keyword Jaccard
    if (keywordJaccard(newSummary, d.summary) >= threshold) {
      return d;
    }
  }
  return undefined;
}

/**
 * Check if a new pattern name is similar to any existing pattern.
 * Same logic as isSimilarDecision but compares on `name` field.
 * Returns the matching Pattern or undefined.
 */
export function isSimilarPattern(
  newName: string,
  existingPatterns: Pattern[],
  threshold = 0.5,
): Pattern | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const n = norm(newName);

  for (const p of existingPatterns) {
    const e = norm(p.name);
    // Fast path: substring match on first 40 chars
    if (e.includes(n.slice(0, 40)) || n.includes(e.slice(0, 40))) {
      return p;
    }
    // Slow path: keyword Jaccard
    if (keywordJaccard(newName, p.name) >= threshold) {
      return p;
    }
  }
  return undefined;
}
