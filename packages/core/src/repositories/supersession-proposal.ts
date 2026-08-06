import { randomUUID } from 'node:crypto';
import type { NexusDb } from '../db/connection.js';
import { auditLog } from './audit.js';

/**
 * A suggestion that one decision has made an earlier one false.
 *
 * Suggestions only. Nothing here retires anything until someone says so, because
 * the judgement is wrong often enough to matter and its errors are silent: a
 * decision wrongly retired stops being quoted and nobody notices it went.
 *
 * The reverse is not silent — a stale decision gets quoted at someone and looks
 * wrong — which is why proposing is the safe direction to be imperfect in.
 */
export interface SupersessionProposal {
  id: string;
  projectId: string;
  /** The newer decision. */
  supersedingId: string;
  /** The older decision it may have made false. */
  supersededId: string;
  reason: string;
  proposedAt: number;
  status: 'pending' | 'accepted' | 'rejected';
  decidedAt?: number;
}

interface ProposalRow {
  id: string;
  project_id: string;
  superseding_id: string;
  superseded_id: string;
  reason: string | null;
  proposed_at: number;
  status: 'pending' | 'accepted' | 'rejected';
  decided_at: number | null;
}

function toProposal(row: ProposalRow): SupersessionProposal {
  return {
    id: row.id,
    projectId: row.project_id,
    supersedingId: row.superseding_id,
    supersededId: row.superseded_id,
    reason: row.reason ?? '',
    proposedAt: row.proposed_at,
    status: row.status,
    ...(row.decided_at !== null ? { decidedAt: row.decided_at } : {}),
  };
}

/**
 * Record a proposal, unless this exact pair has been raised before.
 *
 * Re-raising a rejected pair is what would turn this into the kind of list
 * people learn to ignore, so the pair is unique for the life of the database and
 * a repeat is silently dropped.
 *
 * Returns the new proposal, or undefined when the pair was already known.
 */
export function proposeSupersession(
  db: NexusDb,
  input: { projectId: string; supersedingId: string; supersededId: string; reason?: string },
  source: 'cli' | 'mcp' | 'daemon' = 'daemon',
): SupersessionProposal | undefined {
  if (input.supersedingId === input.supersededId) return undefined;

  const existing = db
    .prepare('SELECT 1 FROM supersession_proposals WHERE superseding_id = ? AND superseded_id = ?')
    .get(input.supersedingId, input.supersededId);
  if (existing) return undefined;

  const proposal: SupersessionProposal = {
    id: randomUUID(),
    projectId: input.projectId,
    supersedingId: input.supersedingId,
    supersededId: input.supersededId,
    reason: input.reason ?? '',
    proposedAt: Date.now(),
    status: 'pending',
  };

  db.prepare(
    `INSERT INTO supersession_proposals
       (id, project_id, superseding_id, superseded_id, reason, proposed_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
  ).run(
    proposal.id,
    proposal.projectId,
    proposal.supersedingId,
    proposal.supersededId,
    proposal.reason,
    proposal.proposedAt,
  );

  auditLog(db, {
    operation: 'supersession.propose',
    source,
    projectId: input.projectId,
    meta: { superseding_id: input.supersedingId, superseded_id: input.supersededId },
  });

  return proposal;
}

/** Pending proposals for a project, newest first. */
export function listPendingProposals(db: NexusDb, projectId: string): SupersessionProposal[] {
  const rows = db
    .prepare(
      `SELECT * FROM supersession_proposals
        WHERE project_id = ? AND status = 'pending'
        ORDER BY proposed_at DESC`,
    )
    .all(projectId) as ProposalRow[];
  return rows.map(toProposal);
}

/**
 * Pending proposals affecting any of these decisions, keyed by the decision that
 * may be stale. Used to annotate decisions at the moment they are quoted.
 */
export function pendingProposalsFor(
  db: NexusDb,
  supersededIds: readonly string[],
): Map<string, SupersessionProposal> {
  if (supersededIds.length === 0) return new Map();
  const placeholders = supersededIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT * FROM supersession_proposals
        WHERE status = 'pending' AND superseded_id IN (${placeholders})
        ORDER BY proposed_at DESC`,
    )
    .all(...supersededIds) as ProposalRow[];

  const byDecision = new Map<string, SupersessionProposal>();
  for (const row of rows) {
    // Newest first, so the first seen for a decision is the one that stands.
    if (!byDecision.has(row.superseded_id)) byDecision.set(row.superseded_id, toProposal(row));
  }
  return byDecision;
}

export function getProposal(db: NexusDb, id: string): SupersessionProposal | undefined {
  const row = db.prepare('SELECT * FROM supersession_proposals WHERE id = ?').get(id) as
    | ProposalRow
    | undefined;
  return row ? toProposal(row) : undefined;
}

/**
 * Accept a proposal: retire the older decision and close the proposal.
 *
 * The decision row stays and only its `superseded_by` is set, so this remains
 * undoable even after acceptance.
 */
export function acceptProposal(
  db: NexusDb,
  id: string,
  source: 'cli' | 'mcp' | 'daemon' = 'mcp',
): boolean {
  const proposal = getProposal(db, id);
  if (!proposal || proposal.status !== 'pending') return false;

  let applied = 0;
  db.transaction(() => {
    applied = db
      .prepare('UPDATE decisions SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL')
      .run(proposal.supersedingId, proposal.supersededId).changes;
    db.prepare(
      "UPDATE supersession_proposals SET status = 'accepted', decided_at = ? WHERE id = ?",
    ).run(Date.now(), id);
  })();

  auditLog(db, {
    operation: 'supersession.accept',
    source,
    projectId: proposal.projectId,
    meta: {
      proposal_id: id,
      superseding_id: proposal.supersedingId,
      superseded_id: proposal.supersededId,
      applied: String(applied),
    },
  });
  return true;
}

/** Reject a proposal. The pair is never raised again. */
export function rejectProposal(
  db: NexusDb,
  id: string,
  source: 'cli' | 'mcp' | 'daemon' = 'mcp',
): boolean {
  const proposal = getProposal(db, id);
  if (!proposal || proposal.status !== 'pending') return false;

  db.prepare(
    "UPDATE supersession_proposals SET status = 'rejected', decided_at = ? WHERE id = ?",
  ).run(Date.now(), id);

  auditLog(db, {
    operation: 'supersession.reject',
    source,
    projectId: proposal.projectId,
    meta: { proposal_id: id, superseded_id: proposal.supersededId },
  });
  return true;
}
