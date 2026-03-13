/**
 * Session snapshot builder for compaction recovery.
 *
 * Given a list of classified events, produces a Markdown summary that can be
 * injected into context after a compaction event, so Claude can recover
 * session state without re-reading everything.
 *
 * Budget allocation: P1 (50%), P2 (35%), P3 (15%).
 */

import type { ClassifiedEvent } from '../types/index.js';

const DEFAULT_MAX_BYTES = 2048;

export function buildSessionSnapshot(
  events: ClassifiedEvent[],
  maxBytes: number = DEFAULT_MAX_BYTES,
): string {
  if (events.length === 0) return '';

  // Partition by priority
  const p1 = events.filter((e) => e.priority === 1);
  const p2 = events.filter((e) => e.priority === 2);
  const p3 = events.filter((e) => e.priority === 3);

  // Build sections
  const p1Section = buildP1Section(p1);
  const p2Section = buildP2Section(p2);
  const p3Section = buildP3Section(p3);

  const header = '## Session Recovery (post-compaction)\n\n';
  let result = header;

  const headerBytes = Buffer.byteLength(header);
  const budget = maxBytes - headerBytes;

  const p1Bytes = Buffer.byteLength(p1Section);
  const p2Bytes = Buffer.byteLength(p2Section);
  const p3Bytes = Buffer.byteLength(p3Section);

  // Progressive trimming: include all if fits, drop P3 first, then trim P2
  if (p1Bytes + p2Bytes + p3Bytes <= budget) {
    result += p1Section + p2Section + p3Section;
  } else if (p1Bytes + p2Bytes <= budget) {
    result += p1Section + p2Section;
  } else if (p1Bytes <= budget) {
    result += p1Section;
  } else {
    // Even P1 is over budget — truncate it
    result += p1Section.slice(0, budget);
  }

  return result.trim();
}

function buildP1Section(events: ClassifiedEvent[]): string {
  if (events.length === 0) return '';

  const lines: string[] = ['### Active Context (P1)\n'];

  // Files: deduplicate, last 10
  const fileEvents = events.filter((e) => e.category === 'file');
  const uniqueFiles = [...new Set(fileEvents.map((e) => e.data))].slice(-10);
  if (uniqueFiles.length > 0) {
    lines.push('**Files touched:**');
    for (const f of uniqueFiles) {
      lines.push(`- ${f}`);
    }
    lines.push('');
  }

  // Tasks
  const taskEvents = events.filter((e) => e.category === 'task');
  if (taskEvents.length > 0) {
    lines.push('**Tasks:**');
    for (const t of taskEvents.slice(-5)) {
      lines.push(`- ${t.data}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function buildP2Section(events: ClassifiedEvent[]): string {
  if (events.length === 0) return '';

  const lines: string[] = ['### Session History (P2)\n'];

  // Errors (last 3)
  const errors = events.filter((e) => e.category === 'error');
  if (errors.length > 0) {
    lines.push('**Recent errors:**');
    for (const e of errors.slice(-3)) {
      lines.push(`- ${e.data}`);
    }
    lines.push('');
  }

  // Git ops (last 5)
  const gitOps = events.filter((e) => e.category === 'git');
  if (gitOps.length > 0) {
    lines.push('**Git operations:**');
    for (const g of gitOps.slice(-5)) {
      lines.push(`- ${g.data}`);
    }
    lines.push('');
  }

  // Env changes
  const envOps = events.filter((e) => e.category === 'env');
  if (envOps.length > 0) {
    const last = envOps[envOps.length - 1]!;
    lines.push(`**Environment:** ${last.data}\n`);
  }

  return lines.join('\n');
}

function buildP3Section(events: ClassifiedEvent[]): string {
  if (events.length === 0) return '';

  const lines: string[] = ['### Tool Usage (P3)\n'];

  // Tool usage counts
  const toolCounts = new Map<string, number>();
  for (const e of events) {
    const key = e.source;
    toolCounts.set(key, (toolCounts.get(key) ?? 0) + 1);
  }

  const sorted = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (sorted.length > 0) {
    for (const [tool, count] of sorted) {
      lines.push(`- ${tool}: ${count}x`);
    }
    lines.push('');
  }

  // Subagents
  const subagents = events.filter((e) => e.category === 'subagent');
  if (subagents.length > 0) {
    lines.push('**Subagents used:**');
    for (const s of subagents.slice(-3)) {
      lines.push(`- ${s.data}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
