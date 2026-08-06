/**
 * What happens when the user submits a prompt.
 *
 * Two jobs: record what was asked, and — only when there is something genuinely
 * relevant — say what has already been decided or is already in conflict, before
 * the work starts rather than after it collides.
 *
 * This module is deliberately narrow in what it imports. It runs ahead of every
 * prompt, so its cost is paid on every prompt, and the full service surface
 * drags in the Anthropic SDK (~240ms of module loading) that nothing here needs.
 * Import repositories directly; do not reach for NexusService.
 */

import { openDatabase, type NexusDb } from '../db/connection.js';
import { migrateDatabase, getSchemaVersion, LATEST_SCHEMA_VERSION } from '../db/migrations.js';
import { resolveEncryptionKey } from '../security/key-store.js';
import { readConfig, DB_FILE } from '../config/index.js';
import { findProjectByPath } from '../repositories/project.js';
import { findDecisionsByProject } from '../repositories/decision.js';
import { findOpenConflictsForProject } from '../repositories/conflict.js';
import { recordPrompt } from '../repositories/prompt.js';
import { significantTerms, rankCandidates, type Candidate } from './relevance.js';

/**
 * How many recent decisions are searched.
 *
 * Ranking cost is linear in this, and it is paid before every prompt. Decisions
 * are returned newest-first, and older ones are the likeliest to have been
 * superseded in practice even when not formally marked so.
 */
const DECISION_SEARCH_LIMIT = 300;

/**
 * Per-line caps on injected text.
 *
 * This block is prepended to the user's prompt, so it competes with the actual
 * request for attention and for context. Summaries are headlines; anyone who
 * needs the full text can run `nexus_query`, which the block says.
 */
const MAX_SUMMARY_CHARS = 160;
const MAX_RATIONALE_CHARS = 140;

function clip(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

export interface PromptHookInput {
  /** Claude Code session identifier; groups prompts within one conversation. */
  sessionId: string;
  /** Working directory of the session, used to identify the project. */
  cwd: string;
  /** The raw prompt. Filtered for secrets before it is stored. */
  prompt: string;
}

export interface PromptHookResult {
  /** False when the directory is not a registered Nexus project. */
  recorded: boolean;
  /** Text to inject ahead of the prompt, or null when there is nothing to say. */
  context: string | null;
  /** Count of matched records, for diagnostics. */
  matchCount: number;
}

const SILENT: PromptHookResult = { recorded: false, context: null, matchCount: 0 };

/**
 * Record the prompt and build any advisory for it.
 *
 * Takes an open database so callers that already have one do not pay to open a
 * second; `runPromptHook` is the variant that opens its own.
 */
export function buildPromptAdvisory(db: NexusDb, input: PromptHookInput): PromptHookResult {
  const project = findProjectByPath(db, input.cwd);
  if (!project) return SILENT;

  recordPrompt(db, {
    projectId: project.id,
    sessionKey: input.sessionId,
    prompt: input.prompt,
  });

  const terms = significantTerms(input.prompt);
  if (terms.length === 0) return { recorded: true, context: null, matchCount: 0 };

  const decisions = findDecisionsByProject(db, project.id)
    .filter((d) => !d.supersededBy)
    .slice(0, DECISION_SEARCH_LIMIT);
  const conflicts = findOpenConflictsForProject(db, project.id);

  const decisionCandidates: Candidate[] = decisions.map((d) => ({
    id: d.id,
    text: `${d.kind} ${d.summary} ${d.rationale ?? ''}`,
  }));
  const conflictCandidates: Candidate[] = conflicts.map((c) => ({
    id: c.id,
    text: c.description,
  }));

  const decisionMatches = rankCandidates(terms, decisionCandidates);
  const conflictMatches = rankCandidates(terms, conflictCandidates);

  if (decisionMatches.length === 0 && conflictMatches.length === 0) {
    return { recorded: true, context: null, matchCount: 0 };
  }

  const byId = new Map(decisions.map((d) => [d.id, d]));
  const conflictById = new Map(conflicts.map((c) => [c.id, c]));

  const lines: string[] = ['## Nexus — related prior context'];

  if (conflictMatches.length > 0) {
    lines.push('', 'Open conflicts touching this request:');
    for (const match of conflictMatches) {
      const conflict = conflictById.get(match.id);
      if (conflict) {
        lines.push(`- [${conflict.severity}] ${clip(conflict.description, MAX_SUMMARY_CHARS)}`);
      }
    }
  }

  if (decisionMatches.length > 0) {
    lines.push('', 'Already decided:');
    for (const match of decisionMatches) {
      const decision = byId.get(match.id);
      if (!decision) continue;
      lines.push(`- **[${decision.kind}]** ${clip(decision.summary, MAX_SUMMARY_CHARS)}`);
      if (decision.rationale) lines.push(`  > ${clip(decision.rationale, MAX_RATIONALE_CHARS)}`);
    }
  }

  lines.push(
    '',
    'Follow these unless the user is explicitly changing them. ' +
      'Run `nexus_query` if you need the surrounding detail.',
  );

  return {
    recorded: true,
    context: lines.join('\n'),
    matchCount: decisionMatches.length + conflictMatches.length,
  };
}

/**
 * Open the database, record the prompt, and return any advisory.
 *
 * Never throws. This sits in front of every prompt the user types, and a Nexus
 * fault must not stop someone working — a missed advisory is a far smaller cost
 * than a blocked prompt.
 */
export function runPromptHook(input: PromptHookInput): PromptHookResult {
  let db: NexusDb | undefined;
  try {
    const { key } = resolveEncryptionKey(readConfig().encryptionKey);
    db = openDatabase({ dbPath: DB_FILE, encryptionKey: key });
    // Migrating unconditionally would take a write lock ahead of every prompt,
    // and could sit behind an in-flight extraction write for the full busy
    // timeout. Reading the version first costs nothing and is almost always
    // enough; the write path only runs on the one prompt after an upgrade.
    if (getSchemaVersion(db) < LATEST_SCHEMA_VERSION) migrateDatabase(db);
    return buildPromptAdvisory(db, input);
  } catch {
    return SILENT;
  } finally {
    try {
      db?.close();
    } catch {
      // nothing useful to do
    }
  }
}
