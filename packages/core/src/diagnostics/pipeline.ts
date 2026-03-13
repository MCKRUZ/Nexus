/**
 * Pipeline telemetry — structured audit events for the Nexus value chain.
 *
 * Emits events at each stage of: hook trigger -> extraction -> sync.
 * Uses the existing audit_log table, no schema changes needed.
 */

import type { NexusDb } from '../db/connection.js';
import { auditLog } from '../repositories/audit.js';

// ─── Event names ────────────────────────────────────────────────────────────

export type PipelineEvent =
  | 'pipeline.hook.start'
  | 'pipeline.hook.skip'
  | 'pipeline.extraction.start'
  | 'pipeline.extraction.success'
  | 'pipeline.extraction.fail'
  | 'pipeline.sync.start'
  | 'pipeline.sync.success'
  | 'pipeline.sync.fail'
  | 'pipeline.llm.call';

// ─── Emit ───────────────────────────────────────────────────────────────────

export function emitPipelineEvent(
  db: NexusDb,
  projectId: string | undefined,
  operation: PipelineEvent,
  metadata?: Record<string, string>,
): void {
  auditLog(db, {
    operation,
    source: 'daemon',
    ...(projectId ? { projectId } : {}),
    ...(metadata ? { meta: metadata } : {}),
  });
}

// ─── Stats ──────────────────────────────────────────────────────────────────

export interface PipelineStats {
  hookRuns: number;
  hookSkips: number;
  extractionSuccesses: number;
  extractionFailures: number;
  syncSuccesses: number;
  syncFailures: number;
  lastRun: string | null;
  avgExtractedItems: number;
}

interface CountRow {
  operation: string;
  cnt: number;
}

interface LastRunRow {
  at: number;
}

interface AvgRow {
  avg_items: number | null;
}

export function getPipelineStats(
  db: NexusDb,
  projectId?: string,
  since?: number,
): PipelineStats {
  const clauses: string[] = ["operation LIKE 'pipeline.%'"];
  const params: unknown[] = [];

  if (projectId) {
    clauses.push('project_id = ?');
    params.push(projectId);
  }
  if (since != null) {
    clauses.push('at >= ?');
    params.push(since);
  }

  const where = `WHERE ${clauses.join(' AND ')}`;

  // Counts by operation
  const rows = db
    .prepare(
      `SELECT operation, COUNT(*) AS cnt FROM audit_log ${where} GROUP BY operation`,
    )
    .all(...params) as CountRow[];

  const countMap = new Map(rows.map((r) => [r.operation, r.cnt]));

  // Last run timestamp
  const lastRow = db
    .prepare(
      `SELECT at FROM audit_log ${where} ORDER BY at DESC LIMIT 1`,
    )
    .get(...params) as LastRunRow | undefined;

  // Average extracted items from extraction.success metadata
  const extractWhere = where + " AND operation = 'pipeline.extraction.success'";
  const avgRow = db
    .prepare(
      `SELECT AVG(
        CAST(json_extract(meta, '$.decision_count') AS INTEGER) +
        CAST(json_extract(meta, '$.pattern_count') AS INTEGER)
      ) AS avg_items
      FROM audit_log ${extractWhere} AND meta IS NOT NULL`,
    )
    .get(...params) as AvgRow | undefined;

  return {
    hookRuns: countMap.get('pipeline.hook.start') ?? 0,
    hookSkips: countMap.get('pipeline.hook.skip') ?? 0,
    extractionSuccesses: countMap.get('pipeline.extraction.success') ?? 0,
    extractionFailures: countMap.get('pipeline.extraction.fail') ?? 0,
    syncSuccesses: countMap.get('pipeline.sync.success') ?? 0,
    syncFailures: countMap.get('pipeline.sync.fail') ?? 0,
    lastRun: lastRow ? new Date(lastRow.at).toISOString() : null,
    avgExtractedItems: Math.round((avgRow?.avg_items ?? 0) * 10) / 10,
  };
}

// ─── LLM Cost Tracking ────────────────────────────────────────────────────────

export interface LlmCostByDay {
  date: string;
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface LlmCostSummary {
  totalCostUsd: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byDay: LlmCostByDay[];
  byProvider: Array<{ provider: string; model: string; calls: number; costUsd: number }>;
}

interface LlmCostRow {
  day_bucket: number;
  provider: string;
  model: string;
  cnt: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export function getLlmCosts(
  db: NexusDb,
  since?: number,
): LlmCostSummary {
  const clauses: string[] = ["operation = 'pipeline.llm.call'", 'meta IS NOT NULL'];
  const params: unknown[] = [];

  if (since != null) {
    clauses.push('at >= ?');
    params.push(since);
  }

  const where = `WHERE ${clauses.join(' AND ')}`;

  const rows = db
    .prepare(
      `SELECT
        (at / 86400000) AS day_bucket,
        json_extract(meta, '$.provider') AS provider,
        json_extract(meta, '$.model') AS model,
        COUNT(*) AS cnt,
        SUM(CAST(json_extract(meta, '$.input_tokens') AS INTEGER)) AS input_tokens,
        SUM(CAST(json_extract(meta, '$.output_tokens') AS INTEGER)) AS output_tokens,
        SUM(CAST(json_extract(meta, '$.cost_usd') AS REAL)) AS cost_usd
      FROM audit_log ${where}
      GROUP BY day_bucket, provider, model
      ORDER BY day_bucket ASC`,
    )
    .all(...params) as LlmCostRow[];

  let totalCostUsd = 0;
  let totalCalls = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  const byDay: LlmCostByDay[] = [];
  const providerMap = new Map<string, { provider: string; model: string; calls: number; costUsd: number }>();

  for (const r of rows) {
    const date = new Date(r.day_bucket * 86400000).toISOString().slice(0, 10);
    byDay.push({
      date,
      provider: r.provider ?? 'unknown',
      model: r.model ?? 'unknown',
      calls: r.cnt,
      inputTokens: r.input_tokens ?? 0,
      outputTokens: r.output_tokens ?? 0,
      estimatedCostUsd: r.cost_usd ?? 0,
    });

    totalCostUsd += r.cost_usd ?? 0;
    totalCalls += r.cnt;
    totalInputTokens += r.input_tokens ?? 0;
    totalOutputTokens += r.output_tokens ?? 0;

    const key = `${r.provider}:${r.model}`;
    const existing = providerMap.get(key);
    if (existing) {
      existing.calls += r.cnt;
      existing.costUsd += r.cost_usd ?? 0;
    } else {
      providerMap.set(key, {
        provider: r.provider ?? 'unknown',
        model: r.model ?? 'unknown',
        calls: r.cnt,
        costUsd: r.cost_usd ?? 0,
      });
    }
  }

  return {
    totalCostUsd,
    totalCalls,
    totalInputTokens,
    totalOutputTokens,
    byDay,
    byProvider: [...providerMap.values()].sort((a, b) => b.costUsd - a.costUsd),
  };
}
