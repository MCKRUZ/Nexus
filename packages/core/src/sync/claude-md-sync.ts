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
import type { Decision, Pattern, Preference, Conflict, Note } from '../types/index.js';

const SECTION_START = '<!-- nexus:start -->';
const SECTION_END = '<!-- nexus:end -->';

// Token budget constants — CLAUDE.md Nexus section hard cap
const MAX_SECTION_CHARS = 6000;       // ≈1,500 tokens
const MAX_DECISIONS = 5;              // injected decisions
const MAX_PATTERNS = 3;               // injected patterns
const MAX_OWN_NOTE_CHARS = 150;       // own project note content
const MAX_CROSS_NOTE_CHARS = 80;      // cross-project note content (excerpt)
const MAX_DECISION_SUMMARY_CHARS = 80; // truncate long decision summaries

export interface SyncInput {
  projectPath: string;
  notes: Note[];
  /** Notes inherited from parent/child/sibling projects — shared cross-project context */
  relatedProjectNotes?: Array<{ projectName: string; notes: Note[] }>;
  decisions: Decision[];
  patterns: Pattern[];
  preferences: Preference[];
  conflicts: Conflict[];
  relatedProjects: Array<{ name: string; path: string }>;
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
  maxPatterns: number;
  ownNoteChars: number;
  crossNoteChars: number;
}): string[] {
  const lines: string[] = [
    SECTION_START,
    '## Nexus Intelligence',
    '',
    `*Auto-updated by Nexus — do not edit this section manually.*`,
    `*Last sync: ${new Date().toISOString().split('T')[0]}*`,
    '',
  ];

  // Project context notes — truncated to budget, sorted by most recently updated
  const sortedNotes = [...input.notes].sort((a, b) => b.updatedAt - a.updatedAt);
  if (sortedNotes.length > 0) {
    lines.push('### Project Context');
    for (const note of sortedNotes) {
      lines.push(`#### ${note.title}`);
      lines.push(trunc(note.content, opts.ownNoteChars));
      if (note.tags.length > 0) {
        lines.push(`*Tags: ${note.tags.join(', ')}*`);
      }
      lines.push('');
    }
  }

  // Notes inherited from related projects (parent/child) — cross-project context
  const relatedWithNotes = (input.relatedProjectNotes ?? []).filter((rpn) => rpn.notes.length > 0);
  for (const rpn of relatedWithNotes) {
    const sorted = [...rpn.notes].sort((a, b) => b.updatedAt - a.updatedAt);
    lines.push(`### Context from ${rpn.projectName}`);
    for (const note of sorted) {
      lines.push(`#### ${note.title}`);
      lines.push(trunc(note.content, opts.crossNoteChars));
      if (note.tags.length > 0) {
        lines.push(`*Tags: ${note.tags.join(', ')}*`);
      }
      lines.push('');
    }
  }

  // Key decisions (priority-sorted, capped, summaries truncated)
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

  // Top patterns (capped)
  if (opts.maxPatterns > 0) {
    const topPatterns = [...input.patterns]
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, opts.maxPatterns);

    if (topPatterns.length > 0) {
      lines.push('### Established Patterns');
      for (const p of topPatterns) {
        lines.push(`- **${p.name}**: ${p.description}`);
      }
      lines.push('');
    }
  }

  // Preferences
  const projectPrefs = input.preferences.filter((p) => p.scope === 'project').slice(0, 8);
  const globalPrefs = input.preferences.filter((p) => p.scope === 'global').slice(0, 5);
  const allPrefs = [...projectPrefs, ...globalPrefs];

  if (allPrefs.length > 0) {
    lines.push('### Preferences');
    for (const pref of allPrefs) {
      const scope = pref.scope === 'global' ? ' *(global)*' : '';
      lines.push(`- \`${pref.key}\` = ${pref.value}${scope}`);
    }
    lines.push('');
  }

  // Open conflicts
  const openConflicts = input.conflicts.filter((c) => !c.resolvedAt);
  if (openConflicts.length > 0) {
    lines.push('### ⚠ Open Conflicts');
    for (const c of openConflicts) {
      lines.push(`- ${c.description}`);
    }
    lines.push('');
  }

  // Related projects
  if (input.relatedProjects.length > 0) {
    lines.push('### Related Projects');
    for (const rp of input.relatedProjects) {
      lines.push(`- **${rp.name}**: \`${rp.path}\``);
    }
    lines.push('');
  }

  lines.push(`*[Nexus: run \`nexus query\` to search full knowledge base]*`);
  lines.push(SECTION_END);
  return lines;
}

/**
 * Generate the Nexus Intelligence section content.
 * Enforces a hard token budget via progressive truncation.
 */
function generateSection(input: SyncInput): string {
  // Phase 0: standard limits
  let lines = buildLines(input, {
    maxDecisions: MAX_DECISIONS,
    maxPatterns: MAX_PATTERNS,
    ownNoteChars: MAX_OWN_NOTE_CHARS,
    crossNoteChars: MAX_CROSS_NOTE_CHARS,
  });

  if (lines.join('\n').length <= MAX_SECTION_CHARS) {
    return lines.join('\n');
  }

  // Phase 1: compress cross-project notes to title stubs (40 chars)
  lines = buildLines(input, {
    maxDecisions: MAX_DECISIONS,
    maxPatterns: MAX_PATTERNS,
    ownNoteChars: MAX_OWN_NOTE_CHARS,
    crossNoteChars: 40,
  });

  if (lines.join('\n').length <= MAX_SECTION_CHARS) {
    return lines.join('\n');
  }

  // Phase 2: reduce decisions to 3
  lines = buildLines(input, {
    maxDecisions: 3,
    maxPatterns: MAX_PATTERNS,
    ownNoteChars: MAX_OWN_NOTE_CHARS,
    crossNoteChars: 40,
  });

  if (lines.join('\n').length <= MAX_SECTION_CHARS) {
    return lines.join('\n');
  }

  // Phase 3: drop patterns entirely
  lines = buildLines(input, {
    maxDecisions: 3,
    maxPatterns: 0,
    ownNoteChars: MAX_OWN_NOTE_CHARS,
    crossNoteChars: 40,
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
