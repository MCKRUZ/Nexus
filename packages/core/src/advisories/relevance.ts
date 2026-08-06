/**
 * Deciding whether a request is close enough to something already recorded to be
 * worth interrupting for.
 *
 * This runs before every prompt, so it has to be cheap and it has to be quiet.
 * An advisory that fires on most prompts is worse than none: it trains the
 * reader to skip the block, and the one time it matters they skip that too.
 * Everything here is therefore biased towards saying nothing.
 *
 * No model is involved. Matching is term overlap weighted by how rare each term
 * is across the candidates being searched — a prompt sharing the word "database"
 * with a decision means very little when half the decisions mention databases,
 * and a great deal when only one does.
 */

/**
 * Words carrying no signal about what a request is *about*.
 *
 * Two groups: ordinary English glue, and the vocabulary of asking for software
 * work. "Fix the failing test" is four words and none of them narrow anything
 * down, so all four are dropped.
 */
const STOPWORDS = new Set([
  // English glue
  'about', 'after', 'again', 'against', 'also', 'been', 'before', 'being', 'both',
  'because', 'could', 'does', 'doing', 'done', 'down', 'each', 'from', 'have',
  'having', 'here', 'into', 'just', 'like', 'more', 'most', 'much', 'must',
  'only', 'other', 'over', 'same', 'should', 'some', 'such', 'than', 'that',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through',
  'very', 'were', 'what', 'when', 'where', 'which', 'while', 'with', 'would',
  'your', 'yours', 'will', 'want', 'need', 'make', 'made', 'take', 'give',
  // the vocabulary of asking for software work
  'actually', 'add', 'added', 'adding', 'build', 'building', 'built', 'change',
  'changed', 'changes', 'check', 'clean', 'code', 'create', 'created', 'currently',
  'delete', 'fail', 'failed', 'failing', 'fails', 'file', 'files', 'fix', 'fixed',
  'fixing', 'function', 'implement', 'issue', 'let', 'look', 'looks', 'move',
  'now', 'please', 'problem', 'remove', 'run', 'running', 'see', 'set', 'start',
  'stuff', 'test', 'testing', 'tests', 'thing', 'things', 'try', 'update',
  'updated', 'use', 'used', 'using', 'work', 'working', 'write', 'wrote',
  'bump', 'refactor', 'rename', 'revert', 'tidy', 'wire',
]);

/** Terms shorter than this are noise regardless of what they are. */
const MIN_TERM_LENGTH = 4;

export interface Candidate {
  id: string;
  /** Everything about this record worth matching against, already concatenated. */
  text: string;
}

export interface Match {
  id: string;
  /** Higher is more relevant. Only comparable within a single ranking call. */
  score: number;
  /** Which prompt terms this candidate shares — useful for explaining the hit. */
  matchedTerms: string[];
}

export interface RankOptions {
  /**
   * How many distinct prompt terms a candidate must share before it can fire.
   * One shared term is a coincidence often enough to be worthless.
   */
  minMatchedTerms?: number;
  /** Never return more than this many. */
  limit?: number;
}

/**
 * Whether to speak is decided by matched term count alone; rarity only decides
 * the order.
 *
 * Rarity is tempting as a gate and is wrong for it. A term common across a
 * project's records is uninformative for *ranking* them, but a project whose
 * decisions all concern encryption is precisely the project where a question
 * about encryption deserves an answer. Gating on rarity stays silent exactly
 * where the history is richest. Filtering words that carry no subject matter is
 * the stopword list's job, and it does not vary by project.
 */
export const DEFAULT_MIN_MATCHED_TERMS = 2;
export const DEFAULT_LIMIT = 3;

/**
 * The words in a piece of text worth matching on, deduplicated.
 *
 * Splits on anything that is not a letter, digit, hyphen or underscore, so
 * identifiers like `nexus_query` and `better-sqlite3` survive as single terms —
 * those are exactly the high-signal words worth matching.
 */
export function significantTerms(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_-]+/)) {
    const term = raw.replace(/^[-_]+|[-_]+$/g, '');
    if (term.length < MIN_TERM_LENGTH) continue;
    if (STOPWORDS.has(term)) continue;
    if (/^\d+$/.test(term)) continue; // bare numbers match arbitrary things
    seen.add(term);
  }
  return [...seen];
}

/**
 * Rank candidates against a prompt's terms, most relevant first.
 *
 * A term's weight is inversely proportional to how many candidates contain it,
 * so a word appearing in every candidate contributes almost nothing and a word
 * appearing in one contributes a lot. This is what stops generic overlap
 * ("database", "config") from producing confident-looking matches.
 */
export function rankCandidates(
  promptTerms: readonly string[],
  candidates: readonly Candidate[],
  opts: RankOptions = {},
): Match[] {
  const minMatchedTerms = opts.minMatchedTerms ?? DEFAULT_MIN_MATCHED_TERMS;
  const limit = opts.limit ?? DEFAULT_LIMIT;

  if (promptTerms.length === 0 || candidates.length === 0) return [];

  const candidateTerms = candidates.map((c) => new Set(significantTerms(c.text)));

  // How many candidates contain each prompt term.
  const documentFrequency = new Map<string, number>();
  for (const term of promptTerms) {
    let count = 0;
    for (const terms of candidateTerms) if (terms.has(term)) count++;
    documentFrequency.set(term, count);
  }

  const total = candidates.length;
  const matches: Match[] = [];

  candidates.forEach((candidate, i) => {
    const terms = candidateTerms[i];
    if (!terms) return;

    const matchedTerms: string[] = [];
    let score = 0;

    for (const term of promptTerms) {
      if (!terms.has(term)) continue;
      matchedTerms.push(term);
      const df = documentFrequency.get(term) ?? 1;
      // Inverse document frequency, smoothed with `total + 1`. The unsmoothed
      // form collapses to zero when every candidate shares the term, which also
      // means a pool of one can never match anything — with a single recorded
      // decision the advisory would be permanently silent. Smoothing keeps a
      // ubiquitous term near zero without pinning it there.
      score += Math.log((total + 1) / df);
    }

    if (matchedTerms.length < minMatchedTerms) return;
    matches.push({ id: candidate.id, score, matchedTerms });
  });

  return matches.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}
