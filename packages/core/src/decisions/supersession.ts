/**
 * Retiring decisions that a later decision has overtaken.
 *
 * Nexus records what was decided but had no way to record that a decision had
 * stopped being true. Of 8,820 decisions, 19 were ever marked superseded, and
 * the last time that happened was five months and 8,000 decisions ago — the
 * existing routine is a manual command nobody runs.
 *
 * That was tolerable while decisions merely sat in a list. It stopped being
 * tolerable once the prompt hook began quoting them as current: a knowledge base
 * that confidently states things that were true last month is worse than one
 * that says nothing. This is the observed failure, not a hypothetical — the hook
 * reported the database key as living in config.json hours after it was moved
 * out, because the decision saying so was still open.
 *
 * Two jobs, deliberately separated:
 *
 *   1. Shortlisting, which is cheap, deterministic and generous. Term overlap
 *      against decisions of the same kind in the same project.
 *   2. Adjudication, which is a small model call and is the only thing allowed
 *      to conclude that one decision replaces another.
 *
 * The existing deduplicator conflates these and gets both wrong: it matches on
 * wording similarity, so a decision phrased differently escapes it, and it keeps
 * whichever has the longer rationale, which has nothing to do with which is
 * still true. Here recency decides. In a decision log the later statement wins;
 * that is what makes it a log.
 */

import { z } from 'zod';
import type { NexusDb } from '../db/connection.js';
import type { Decision } from '../types/index.js';
import { auditLog } from '../repositories/audit.js';
import { significantTerms, rankCandidates, type Candidate } from '../advisories/relevance.js';
import { readConfig } from '../config/index.js';
import { createProvider } from '../llm/index.js';
import type { LlmUsageInfo } from '../extraction/extractor.js';

/**
 * How many prior decisions are put in front of the model.
 *
 * Small on purpose. A long list invites the model to find replacements that are
 * not there, and the shortlist is already ranked, so anything past the first
 * handful was a weak match to begin with.
 */
export const MAX_CANDIDATES = 5;

/**
 * Model recommended for judging supersession, when the install can reach one.
 *
 * NOT the default, deliberately. Extraction is mechanical — pull the decisions
 * out of this transcript — and a small model does it well. This is a judgement:
 * does this statement make that one false? Measured on 48 live decisions, the
 * extraction-tier model retired four unrelated decisions out of twelve, and a
 * wrong retirement silently removes something true, which nobody notices.
 *
 * Defaulting to this model was tried and reverted: these credentials are rate
 * limited for it, so every adjudication failed. Shipping a default an install
 * cannot reach makes the feature dead rather than careful. Set
 * `supersessionModel` in config to opt in where the capacity exists.
 *
 * Until a configuration is measured safe, reconciliation stays off by default.
 */
export const RECOMMENDED_ADJUDICATION_MODEL = 'claude-sonnet-5';

interface DecisionRow {
  id: string;
  project_id: string;
  kind: string;
  summary: string;
  rationale: string | null;
  session_id: string | null;
  recorded_at: number;
  superseded_by: string | null;
}

function rowToDecision(row: DecisionRow): Decision {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as Decision['kind'],
    summary: row.summary,
    ...(row.rationale ? { rationale: row.rationale } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    recordedAt: row.recorded_at,
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
  };
}

/**
 * Prior decisions this one might have overtaken, most similar first.
 *
 * Restricted to the same project and the same kind — a naming decision does not
 * retire an architecture decision however similar the words — and to decisions
 * recorded earlier, so the ordering can never invert.
 *
 * Generous by design: one shared distinctive term is enough to make the
 * shortlist, because the model decides and a missed candidate is invisible
 * whereas an extra one is merely rejected.
 */
export function findSupersessionCandidates(
  db: NexusDb,
  decision: Decision,
  limit = MAX_CANDIDATES,
  /** Ids that have already retired something in this pass. See reconcileDecisions. */
  protectedIds: ReadonlySet<string> = new Set(),
): Decision[] {
  const rows = db
    .prepare(
      `SELECT * FROM decisions
        WHERE project_id = ? AND kind = ? AND superseded_by IS NULL
          AND id != ? AND recorded_at < ?
        ORDER BY recorded_at DESC`,
    )
    .all(decision.projectId, decision.kind, decision.id, decision.recordedAt) as DecisionRow[];

  const priors = rows.map(rowToDecision).filter((d) => !protectedIds.has(d.id));
  if (priors.length === 0) return [];

  const terms = significantTerms(`${decision.summary} ${decision.rationale ?? ''}`);
  if (terms.length === 0) return [];

  const candidates: Candidate[] = priors.map((d) => ({
    id: d.id,
    text: `${d.summary} ${d.rationale ?? ''}`,
  }));

  const byId = new Map(priors.map((d) => [d.id, d]));
  return rankCandidates(terms, candidates, { minMatchedTerms: 1, limit })
    .map((m) => byId.get(m.id))
    .filter((d): d is Decision => d !== undefined);
}

const SUPERSESSION_SYSTEM = `You decide whether a new engineering decision REPLACES any earlier decision.

You will get one NEW decision and a numbered list of EARLIER decisions from the same project.

Mark an earlier decision as replaced ONLY when the new one makes it FALSE:
- It reverses it ("store the key in the config file" -> "store the key in the OS credential store")
- It completes a stated intention ("plan to move to X later" -> "moved to X")

Nothing else qualifies. In particular, do NOT mark it replaced when:
- The two say the SAME thing in different words. A restatement leaves the earlier
  decision true, and true decisions must stay. This is the most common mistake.
- The two are about the same area but decide different things
- The new one builds on, extends, or refines the earlier one without contradicting it
- The earlier one is narrower or broader but still holds
- The new one is about a related but distinct subject (third-party API credentials
  are not the same subject as a database encryption key, however similar the words)
- You are unsure

Test yourself before answering: read the earlier decision alone and ask whether a
colleague following it today would be doing the wrong thing. If they would be fine,
it is not replaced.

Being wrong is expensive in one direction only. Failing to replace leaves a stale
decision that someone will notice. Replacing wrongly hides a decision that is still
true and nobody will notice. Prefer an empty list. Returning [] is the normal answer.

Respond with JSON only:
{ "replaces": [<numbers of earlier decisions the new one replaces>], "reason": "one short sentence, or empty" }`;

const AdjudicationSchema = z.object({
  replaces: z.array(z.number().int().nonnegative()).default([]),
  reason: z.string().default(''),
});

export interface SupersessionVerdict {
  /** Ids of earlier decisions the new one replaces. Always a subset of the shortlist. */
  supersededIds: string[];
  reason: string;
  llmUsage?: LlmUsageInfo;
}

/**
 * Ask the model which shortlisted decisions the new one replaces.
 *
 * Returned indexes are mapped back through the shortlist rather than trusted as
 * identifiers. A model that invents an id would otherwise be able to retire an
 * arbitrary decision, and an out-of-range index is simply dropped.
 */
export async function adjudicateSupersession(
  decision: Decision,
  candidates: readonly Decision[],
): Promise<SupersessionVerdict> {
  if (candidates.length === 0) return { supersededIds: [], reason: '' };

  const describe = (d: Decision) =>
    d.rationale ? `${d.summary}\n   why: ${d.rationale}` : d.summary;

  const userMessage = [
    `## NEW DECISION (${decision.kind})`,
    describe(decision),
    '',
    `## EARLIER DECISIONS`,
    ...candidates.map((c, i) => `${i}. ${describe(c)}`),
  ].join('\n');

  const config = readConfig();
  const provider = createProvider(config);
  const result = await provider.chatCompletion({
    system: SUPERSESSION_SYSTEM,
    userMessage,
    maxTokens: 256,
    // Falls through to the configured model when unset — see
    // RECOMMENDED_ADJUDICATION_MODEL for why this is opt-in rather than default.
    ...(config.supersessionModel ? { model: config.supersessionModel } : {}),
  });

  const llmUsage: LlmUsageInfo = {
    provider: provider.name,
    model: result.model,
    inputTokens: result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
  };

  const match = result.text.match(/\{[\s\S]*\}/);
  if (!match) return { supersededIds: [], reason: '', llmUsage };

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return { supersededIds: [], reason: '', llmUsage };
  }

  const validated = AdjudicationSchema.safeParse(parsed);
  if (!validated.success) return { supersededIds: [], reason: '', llmUsage };

  const supersededIds = validated.data.replaces
    .map((i) => candidates[i]?.id)
    .filter((id): id is string => id !== undefined);

  return { supersededIds: [...new Set(supersededIds)], reason: validated.data.reason, llmUsage };
}

/**
 * Mark earlier decisions as replaced by this one.
 *
 * The rows stay; only `superseded_by` is set, so the history of what was
 * believed and when remains intact and the change can be undone.
 */
export function applySupersession(
  db: NexusDb,
  supersedingId: string,
  supersededIds: readonly string[],
  source: 'cli' | 'mcp' | 'daemon' = 'daemon',
  reason = '',
): number {
  if (supersededIds.length === 0) return 0;

  const stmt = db.prepare(
    'UPDATE decisions SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL',
  );

  const actuallyRetired: string[] = [];
  const run = db.transaction(() => {
    for (const id of supersededIds) {
      if (stmt.run(supersedingId, id).changes > 0) actuallyRetired.push(id);
    }
  });
  run();

  if (actuallyRetired.length > 0) {
    auditLog(db, {
      operation: 'decision.supersede',
      source,
      meta: {
        superseding_id: supersedingId,
        // The ids, not just a count. A bulk judgement call has to be precisely
        // undoable, and reconstructing it from current state only works while no
        // later pass has touched the same rows.
        superseded_ids: actuallyRetired.join(','),
        superseded_count: String(actuallyRetired.length),
        ...(reason ? { reason } : {}),
      },
    });
  }
  return actuallyRetired.length;
}

export interface ReconcileResult {
  /** Decisions examined. */
  examined: number;
  /** Earlier decisions retired as a result. */
  superseded: number;
  /**
   * Adjudications that could not be completed.
   *
   * Reported rather than swallowed. A provider that rejects every call produces
   * the same `superseded: 0` as a pass where nothing needed retiring, and those
   * two outcomes must not look alike — the first time this ran against a model
   * the credentials could not reach, it reported a clean result for 48 failures.
   */
  failed: number;
  /** First failure message, for diagnosis. */
  failureReason?: string;
  llmUsage: LlmUsageInfo[];
}

/**
 * Reconcile decisions recorded since a point in time against their predecessors.
 *
 * One integration point covers every way a decision can be recorded — the
 * extractor, the MCP tool and the CLI all land in the same table — and keeps the
 * model call off every interactive path. It is meant to run in the Stop hook,
 * which already does the session's other LLM work.
 *
 * A decision that fails adjudication is skipped rather than retried: this runs
 * every session, so the next one picks it up.
 */
export async function reconcileDecisions(
  db: NexusDb,
  projectId: string,
  since: number,
  source: 'cli' | 'mcp' | 'daemon' = 'daemon',
): Promise<ReconcileResult> {
  const rows = db
    .prepare(
      `SELECT * FROM decisions
        WHERE project_id = ? AND recorded_at >= ? AND superseded_by IS NULL
        ORDER BY recorded_at ASC`,
    )
    .all(projectId, since) as DecisionRow[];

  const result: ReconcileResult = { examined: 0, superseded: 0, failed: 0, llmUsage: [] };

  /**
   * Decisions that have already retired something in this pass.
   *
   * Without this, a pass over a day's work collapses into a chain: A retires B,
   * then C retires A, then D retires C. Every link looks defensible on its own
   * and the survivor ends up unrelated to where the chain started. Observed on
   * live data — a chain ending on third-party credential handling took the
   * database-key decision with it, leaving nothing that said where the key lived.
   *
   * Once a decision has been used to retire something, it is the current answer
   * for that subject and is off the table until the next pass.
   */
  const protectedIds = new Set<string>();

  for (const row of rows) {
    const decision = rowToDecision(row);

    // It may itself have been retired earlier in this same pass.
    const current = db
      .prepare('SELECT superseded_by FROM decisions WHERE id = ?')
      .get(decision.id) as { superseded_by: string | null } | undefined;
    if (!current || current.superseded_by !== null) continue;

    const candidates = findSupersessionCandidates(db, decision, MAX_CANDIDATES, protectedIds);
    if (candidates.length === 0) continue;

    result.examined++;
    try {
      const verdict = await adjudicateSupersession(decision, candidates);
      if (verdict.llmUsage) result.llmUsage.push(verdict.llmUsage);
      const applied = applySupersession(
        db,
        decision.id,
        verdict.supersededIds,
        source,
        verdict.reason,
      );
      result.superseded += applied;
      if (applied > 0) protectedIds.add(decision.id);
    } catch (err) {
      // A provider outage must not fail the session's Stop hook, but it must
      // not masquerade as a clean pass either.
      result.failed++;
      result.failureReason ??= err instanceof Error ? err.message : String(err);
    }
  }

  return result;
}
