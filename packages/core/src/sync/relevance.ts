/**
 * BM25-inspired relevance scorer for cross-project note injection.
 *
 * Selects the most relevant sibling projects for inclusion in a project's
 * CLAUDE.md, replacing the naive "inject everything" approach.
 *
 * Scoring signals:
 *  - Tag overlap: +10 pts per shared tag
 *  - BM25 term frequency over note content (K1=1.5, B=0.75)
 *  - Structural bonus: parent/child projects always included (score bypass)
 *
 * Hard limits:
 *  - Top 4 by score, only if score > 0
 *  - 8,000 chars total related content (truncate at project boundary)
 */

import type { Note } from '../types/index.js';

// ─── Stop words ──────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  // Common English
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'up', 'about', 'into', 'through', 'during',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'we', 'you', 'he',
  'she', 'they', 'them', 'their', 'our', 'your', 'my', 'his', 'her',
  'not', 'no', 'can', 'all', 'as', 'if', 'so', 'any', 'each', 'how',
  'when', 'where', 'who', 'which', 'what', 'then', 'than', 'also',
  // Common tech stop words
  'use', 'used', 'using', 'new', 'get', 'set', 'run', 'add', 'via',
  'code', 'data', 'file', 'api', 'app', 'type', 'see', 'note', 'run',
]);

// BM25 parameters
const K1 = 1.5;
const B = 0.75;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProjectCandidate {
  projectName: string;
  project: { id: string; parentId?: string | undefined; tags?: string[] | undefined };
  notes: Note[];
}

interface ScoredCandidate {
  projectName: string;
  notes: Note[];
  score: number;
  isStructural: boolean;
}

// ─── Tokenizer ────────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

function noteCorpus(notes: Note[]): string {
  return notes.map((n) => `${n.title} ${n.content}`).join(' ');
}

// ─── BM25 ────────────────────────────────────────────────────────────────────

function computeTermFrequencies(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  return tf;
}

function bm25Score(
  queryTerms: string[],
  docTf: Map<string, number>,
  docLen: number,
  avgDocLen: number,
  docFreq: Map<string, number>,
  numDocs: number,
): number {
  let score = 0;
  const uniqueQuery = new Set(queryTerms);

  for (const term of uniqueQuery) {
    const tf = docTf.get(term) ?? 0;
    if (tf === 0) continue;

    const df = docFreq.get(term) ?? 0;
    const idf = Math.log((numDocs - df + 0.5) / (df + 0.5) + 1);
    const tfNorm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (docLen / avgDocLen)));
    score += idf * tfNorm;
  }

  return score;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Select the most relevant projects to inject into a target project's CLAUDE.md.
 *
 * @param target  The project being synced (with its own notes as query signal)
 * @param candidates  All other registered projects with their notes
 * @param opts  Tuning options
 * @returns Ordered list of { projectName, notes } to inject
 */
export function selectRelevantProjects(
  target: { project: { id: string; parentId?: string | undefined; tags?: string[] | undefined }; notes: Note[] },
  candidates: ProjectCandidate[],
  opts: { maxProjects?: number; maxChars?: number } = {},
): Array<{ projectName: string; notes: Note[] }> {
  const maxProjects = opts.maxProjects ?? 4;
  const maxChars = opts.maxChars ?? 8000;

  if (candidates.length === 0) return [];

  // Build query from target's notes
  const queryText = noteCorpus(target.notes);
  const queryTokens = tokenize(queryText);
  const targetTags = target.project.tags ?? [];

  // Build BM25 corpus stats over all candidate docs
  const candidateDocs = candidates.map((c) => {
    const text = noteCorpus(c.notes);
    const tokens = tokenize(text);
    return { candidate: c, tokens, tf: computeTermFrequencies(tokens) };
  });

  const numDocs = candidateDocs.length;
  const avgDocLen =
    numDocs === 0
      ? 1
      : candidateDocs.reduce((s, d) => s + d.tokens.length, 0) / numDocs;

  // Document frequency for each term
  const docFreq = new Map<string, number>();
  for (const { tf } of candidateDocs) {
    for (const term of tf.keys()) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }

  // Score each candidate
  const scored: ScoredCandidate[] = candidateDocs.map(({ candidate, tokens, tf }) => {
    const { project, projectName, notes } = candidate;

    // Structural: parent or child always gets in
    const isStructural =
      (!!target.project.parentId && target.project.parentId === project.id) ||
      (!!project.parentId && project.parentId === target.project.id);

    if (notes.length === 0) {
      return { projectName, notes, score: 0, isStructural };
    }

    // Tag overlap
    const candidateTags = project.tags ?? [];
    const tagScore = targetTags.reduce(
      (s, tag) => s + (candidateTags.includes(tag) ? 10 : 0),
      0,
    );

    // BM25 content score (only meaningful if query has terms)
    const contentScore =
      queryTokens.length > 0
        ? bm25Score(queryTokens, tf, tokens.length, avgDocLen, docFreq, numDocs)
        : 0;

    return {
      projectName,
      notes,
      score: tagScore + contentScore,
      isStructural,
    };
  });

  // Separate structural (always included) from scored
  const structural = scored.filter((s) => s.isStructural);
  const nonStructural = scored
    .filter((s) => !s.isStructural && s.score > 0)
    .sort((a, b) => b.score - a.score);

  // Build selection: structural first, then top scored up to maxProjects
  const remaining = maxProjects - structural.length;
  const selected = [
    ...structural,
    ...nonStructural.slice(0, Math.max(0, remaining)),
  ];

  // Apply char cap — truncate at project boundary
  const result: Array<{ projectName: string; notes: Note[] }> = [];
  let charCount = 0;

  for (const item of selected) {
    const projectChars = item.notes.reduce(
      (s, n) => s + n.title.length + n.content.length,
      0,
    );
    if (charCount + projectChars > maxChars) break;
    charCount += projectChars;
    result.push({ projectName: item.projectName, notes: item.notes });
  }

  return result;
}
