/**
 * CLAUDE.md Sync Engine
 *
 * Manages a `## Nexus Intelligence` section inside each project's CLAUDE.md.
 * Uses diff-based updates — only rewrites the Nexus section, leaving the
 * rest of the file completely untouched.
 *
 * Section format:
 * <!-- nexus:start -->
 * ## Nexus Intelligence
 * ...generated content...
 * <!-- nexus:end -->
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Decision, Conflict, Note } from '../types/index.js';

const SECTION_START = '<!-- nexus:start -->';
const SECTION_END = '<!-- nexus:end -->';

// Token budget constants — CLAUDE.md Nexus section hard cap
const MAX_SECTION_CHARS = 6000;       // ≈1,500 tokens (safety net)
const MAX_DECISION_SUMMARY_CHARS = 80; // truncate long decision summaries
const MAX_PORTFOLIO_DESC_CHARS = 80;  // portfolio map description

export interface PortfolioEntry {
  name: string;
  description: string;  // from "Project Overview" note, truncated
  tags: string[];
  isCurrent: boolean;
  lastSeenAt?: number;  // Unix ms — used for recency filtering
  parentId?: string;    // For structural relationship detection
}

export interface SyncInput {
  projectPath: string;
  notes: Note[];              // own-project notes
  portfolio: PortfolioEntry[];// ALL registered projects
  decisions: Decision[];      // own-project decisions
  conflicts: Conflict[];      // open conflicts involving this project
  relatedProjectNotes?: Array<{ projectName: string; notes: Note[] }>;
}

export interface SyncResult {
  updated: boolean;
  claudeMdPath: string;
  previousSection?: string;
  newSection: string;
}

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Build the Nexus Intelligence section lines with a given budget config.
 */
function buildLines(input: SyncInput, opts: {
  maxDecisions: number;
  ownNoteChars: number;
  portfolioDescChars: number;
  includeConflicts: boolean;
}): string[] {
  const lines: string[] = [
    SECTION_START,
    '## Nexus Intelligence',
    '',
    `*Auto-updated by Nexus — do not edit this section manually.*`,
    `*Last sync: ${new Date().toISOString().split('T')[0]}*`,
    '',
  ];

  // ── Portfolio Map ──────────────────────────────────────────────────────────
  // Only show: current project + structural relationships + recently active (30d), max 12
  const current = input.portfolio.find((e) => e.isCurrent);
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const currentParentId = current?.parentId;

  const filteredPortfolio = input.portfolio.filter((e) => {
    if (e.isCurrent) return true;
    // Structural: parent or sibling (same parent as current)
    if (currentParentId && e.parentId === currentParentId) return true;
    if (currentParentId && e.name === currentParentId) return true;
    // Recently active
    return (e.lastSeenAt ?? 0) >= thirtyDaysAgo;
  }).slice(0, 12);

  if (filteredPortfolio.length > 0) {
    const hiddenCount = input.portfolio.length - filteredPortfolio.length;
    lines.push('### Portfolio');
    lines.push('| Project | Description | Tech |');
    lines.push('|---------|------------|------|');
    for (const entry of filteredPortfolio) {
      const name = entry.isCurrent ? `**${entry.name}** (this)` : entry.name;
      const desc = entry.description
        ? trunc(entry.description, opts.portfolioDescChars)
        : '—';
      const tech = entry.tags.slice(0, 3).join(', ') || '—';
      lines.push(`| ${name} | ${desc} | ${tech} |`);
    }
    if (hiddenCount > 0) {
      lines.push(`| _+${hiddenCount} inactive_ | — | — |`);
    }
    lines.push('');
  }

  // ── Own-Project Context ────────────────────────────────────────────────────
  // Exclude "Project Overview" notes — that content is already in the portfolio map
  const contextNotes = [...input.notes]
    .filter((n) => n.title !== 'Project Overview')
    .sort((a, b) => b.updatedAt - a.updatedAt);

  if (contextNotes.length > 0) {
    lines.push('### Project Context');
    for (const note of contextNotes) {
      lines.push(`#### ${note.title}`);
      lines.push(trunc(note.content, opts.ownNoteChars));
      if (note.tags.length > 0) {
        lines.push(`*Tags: ${note.tags.join(', ')}*`);
      }
      lines.push('');
    }
  }

  // ── Related Project Context ──────────────────────────────────────────────
  if (input.relatedProjectNotes && input.relatedProjectNotes.length > 0) {
    for (const related of input.relatedProjectNotes) {
      const relatedNotes = related.notes.filter((n) => n.title !== 'Project Overview');
      if (relatedNotes.length === 0) continue;
      lines.push(`### Context from ${related.projectName}`);
      for (const note of relatedNotes) {
        lines.push(`#### ${note.title}`);
        lines.push(trunc(note.content, opts.ownNoteChars));
        if (note.tags.length > 0) {
          lines.push(`*Tags: ${note.tags.join(', ')}*`);
        }
        lines.push('');
      }
    }
  }

  // ── Recorded Decisions ─────────────────────────────────────────────────────
  const priorityOrder: Decision['kind'][] = ['security', 'architecture', 'library', 'pattern', 'naming', 'other'];
  const sortedDecisions = [...input.decisions]
    .sort((a, b) => priorityOrder.indexOf(a.kind) - priorityOrder.indexOf(b.kind))
    .slice(0, opts.maxDecisions);

  if (sortedDecisions.length > 0) {
    lines.push('### Recorded Decisions');
    for (const d of sortedDecisions) {
      const summary = trunc(d.summary, MAX_DECISION_SUMMARY_CHARS);
      lines.push(`- **[${d.kind}]** ${summary}`);
      if (d.rationale) lines.push(`  > ${d.rationale}`);
    }
    lines.push('');
  }

  // ── Active Conflicts ───────────────────────────────────────────────────────
  if (opts.includeConflicts) {
    const openConflicts = input.conflicts.filter((c) => !c.resolvedAt && c.tier === 'conflict');
    if (openConflicts.length > 0) {
      lines.push('### Active Conflicts');
      for (const c of openConflicts) {
        lines.push(`- [${c.severity}] ${c.description}`);
      }
      lines.push('');
    }

    const openAdvisories = input.conflicts.filter((c) => !c.resolvedAt && c.tier === 'advisory');
    if (openAdvisories.length > 0) {
      lines.push(`*${openAdvisories.length} cross-project advisor${openAdvisories.length === 1 ? 'y' : 'ies'} — run \`nexus query\` for details*`);
      lines.push('');
    }
  }

  // ── Behavioral Rule ────────────────────────────────────────────────────────
  lines.push('> **Cross-project rule**: Before making decisions that affect shared concerns (APIs, auth, data formats, deployment) or asking the user for server/SSH/infrastructure details, run `nexus_query` to check for existing decisions, notes, and conflicts across the portfolio.');
  lines.push('');

  // ── Footer ─────────────────────────────────────────────────────────────────
  lines.push(`*[Nexus: run \`nexus query\` to search full knowledge base]*`);
  lines.push(SECTION_END);
  return lines;
}

/**
 * Generate the Nexus Intelligence section content.
 * Enforces a hard token budget via progressive truncation.
 */
function generateSection(input: SyncInput): string {
  // Phase 0: full budget
  let lines = buildLines(input, {
    maxDecisions: 5,
    ownNoteChars: 150,
    portfolioDescChars: MAX_PORTFOLIO_DESC_CHARS,
    includeConflicts: true,
  });

  if (lines.join('\n').length <= MAX_SECTION_CHARS) {
    return lines.join('\n');
  }

  // Phase 1: reduce decisions
  lines = buildLines(input, {
    maxDecisions: 3,
    ownNoteChars: 150,
    portfolioDescChars: MAX_PORTFOLIO_DESC_CHARS,
    includeConflicts: true,
  });

  if (lines.join('\n').length <= MAX_SECTION_CHARS) {
    return lines.join('\n');
  }

  // Phase 2: compress descriptions and notes
  lines = buildLines(input, {
    maxDecisions: 3,
    ownNoteChars: 100,
    portfolioDescChars: 40,
    includeConflicts: true,
  });

  if (lines.join('\n').length <= MAX_SECTION_CHARS) {
    return lines.join('\n');
  }

  // Phase 3: drop conflicts section
  lines = buildLines(input, {
    maxDecisions: 3,
    ownNoteChars: 100,
    portfolioDescChars: 40,
    includeConflicts: false,
  });

  return lines.join('\n');
}

/**
 * Extract the existing Nexus section from a CLAUDE.md file, if present.
 */
function extractExistingSection(content: string): { before: string; section: string; after: string } | null {
  const startIdx = content.indexOf(SECTION_START);
  const endIdx = content.indexOf(SECTION_END);

  if (startIdx === -1 || endIdx === -1) return null;

  return {
    before: content.slice(0, startIdx),
    section: content.slice(startIdx, endIdx + SECTION_END.length),
    after: content.slice(endIdx + SECTION_END.length),
  };
}

/**
 * Sync the Nexus Intelligence section into a project's CLAUDE.md.
 * Creates CLAUDE.md if it doesn't exist.
 * Leaves all other content untouched.
 */
export function syncClaudeMd(input: SyncInput): SyncResult {
  const claudeMdPath = path.join(input.projectPath, 'CLAUDE.md');
  const newSection = generateSection(input);

  let existingContent = '';
  if (fs.existsSync(claudeMdPath)) {
    existingContent = fs.readFileSync(claudeMdPath, 'utf8');
  }

  const parsed = extractExistingSection(existingContent);

  if (parsed) {
    // Section already exists — check if it needs updating
    if (parsed.section === newSection) {
      return { updated: false, claudeMdPath, previousSection: parsed.section, newSection };
    }

    const newContent = parsed.before + newSection + parsed.after;
    fs.writeFileSync(claudeMdPath, newContent, 'utf8');

    return {
      updated: true,
      claudeMdPath,
      previousSection: parsed.section,
      newSection,
    };
  } else {
    // No section yet — append to file
    const separator = existingContent.endsWith('\n') || existingContent === '' ? '\n' : '\n\n';
    const newContent = existingContent + separator + newSection + '\n';
    fs.writeFileSync(claudeMdPath, newContent, 'utf8');

    return { updated: true, claudeMdPath, newSection };
  }
}

/**
 * Remove the Nexus section from a CLAUDE.md (used when project is unregistered).
 */
export function removeNexusSection(projectPath: string): boolean {
  const claudeMdPath = path.join(projectPath, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) return false;

  const content = fs.readFileSync(claudeMdPath, 'utf8');
  const parsed = extractExistingSection(content);
  if (!parsed) return false;

  const newContent = (parsed.before + parsed.after).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  fs.writeFileSync(claudeMdPath, newContent, 'utf8');
  return true;
}
