/**
 * FTS5 query sanitization and multi-layer search fallback.
 *
 * FTS5 has its own query syntax — raw user input containing operators like
 * AND, OR, NOT, quotes, or parentheses will cause query errors. These helpers
 * strip operators and produce safe quoted-term queries.
 */

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from',
  'had', 'has', 'have', 'he', 'her', 'his', 'how', 'i', 'if', 'in', 'into',
  'is', 'it', 'its', 'just', 'me', 'my', 'no', 'nor', 'not', 'of', 'on',
  'or', 'our', 'out', 'own', 'say', 'she', 'so', 'some', 'than', 'that',
  'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to',
  'too', 'us', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which',
  'who', 'will', 'with', 'would', 'you', 'your',
]);

/** Strip FTS5 operators, filter stopwords, quote each term. */
export function sanitizePorterQuery(query: string, mode: 'AND' | 'OR' = 'AND'): string {
  const terms = extractTerms(query).filter((t) => !STOPWORDS.has(t.toLowerCase()));
  if (terms.length === 0) return '';
  const quoted = terms.map((t) => `"${t}"`);
  return quoted.join(mode === 'AND' ? ' AND ' : ' OR ');
}

/** Same as porter but enforces 3-char minimum for trigram tokenizer. */
export function sanitizeTrigramQuery(query: string, mode: 'AND' | 'OR' = 'AND'): string {
  const terms = extractTerms(query)
    .filter((t) => !STOPWORDS.has(t.toLowerCase()))
    .filter((t) => t.length >= 3);
  if (terms.length === 0) return '';
  const quoted = terms.map((t) => `"${t}"`);
  return quoted.join(mode === 'AND' ? ' AND ' : ' OR ');
}

/** Extract alphanumeric terms from raw input, stripping FTS5 operators and punctuation. */
function extractTerms(query: string): string[] {
  // Remove FTS5 special chars: " ( ) * ^ { } :
  const cleaned = query.replace(/["""(){}*^:]/g, ' ');
  // Split on whitespace, filter empty
  return cleaned.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Execute search layers in order, returning the first non-empty result set.
 * Each layer is a function that returns an array of results.
 */
export function searchWithFallback<T>(layers: Array<() => T[]>): T[] {
  for (const layer of layers) {
    const results = layer();
    if (results.length > 0) return results;
  }
  return [];
}

export { STOPWORDS };
