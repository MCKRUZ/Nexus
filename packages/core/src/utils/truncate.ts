/**
 * Smart truncation utility.
 *
 * Instead of naive `.slice(0, N)` which loses the end (where errors and
 * conclusions live), this uses a 60/40 head/tail split with line-boundary
 * snapping and a human-readable separator.
 */

export interface TruncateResult {
  text: string;
  truncated: boolean;
  originalBytes: number;
}

/**
 * Truncate text to fit within `maxBytes` (UTF-8), keeping 60% head + 40% tail
 * with line-boundary snapping.
 *
 * If the text fits within the budget, it's returned unchanged.
 */
export function smartTruncate(text: string, maxBytes: number): TruncateResult {
  const originalBytes = Buffer.byteLength(text, 'utf-8');

  if (originalBytes <= maxBytes || maxBytes <= 0) {
    return { text, truncated: false, originalBytes };
  }

  const lines = text.split('\n');

  // If only 1 line, do a byte-level cut
  if (lines.length <= 1) {
    const head = truncateToBytes(text, maxBytes);
    return { text: head, truncated: true, originalBytes };
  }

  // Reserve bytes for separator (estimate — we'll adjust)
  const separatorReserve = 80;
  const budget = maxBytes - separatorReserve;
  if (budget <= 0) {
    return { text: truncateToBytes(text, maxBytes), truncated: true, originalBytes };
  }

  const headBudget = Math.floor(budget * 0.6);
  const tailBudget = budget - headBudget;

  // Build head: take lines from the start until we'd exceed headBudget
  const headLines: string[] = [];
  let headBytes = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf-8') + 1; // +1 for \n
    if (headBytes + lineBytes > headBudget && headLines.length > 0) break;
    headLines.push(line);
    headBytes += lineBytes;
  }

  // Build tail: take lines from the end until we'd exceed tailBudget
  const tailLines: string[] = [];
  let tailBytes = 0;
  for (let i = lines.length - 1; i >= headLines.length; i--) {
    const lineBytes = Buffer.byteLength(lines[i]!, 'utf-8') + 1;
    if (tailBytes + lineBytes > tailBudget && tailLines.length > 0) break;
    tailLines.unshift(lines[i]!);
    tailBytes += lineBytes;
  }

  const droppedLines = lines.length - headLines.length - tailLines.length;
  const droppedBytes = originalBytes - headBytes - tailBytes;
  const droppedKB = (droppedBytes / 1024).toFixed(1);

  const separator = `\n... [${droppedLines} lines / ${droppedKB}KB truncated] ...\n`;

  const result = headLines.join('\n') + separator + tailLines.join('\n');
  return { text: result, truncated: true, originalBytes };
}

/** Truncate a string to fit within maxBytes (UTF-8), breaking at the last safe char boundary. */
function truncateToBytes(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, 'utf-8');
  if (buf.length <= maxBytes) return str;
  // Slice and decode — Buffer.toString handles partial UTF-8 gracefully
  return buf.subarray(0, maxBytes).toString('utf-8');
}
