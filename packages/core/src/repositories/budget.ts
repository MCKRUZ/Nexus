import { randomUUID } from 'node:crypto';
import type { NexusDb } from '../db/connection.js';
import type {
  BudgetConfig,
  BudgetState,
  BudgetEvent,
  BudgetAlertStatus,
  BudgetPeriod,
} from '../types/index.js';
import { auditLog } from './audit.js';

// ─── Row types ──────────────────────────────────────────────────────────────

interface BudgetConfigRow {
  id: string;
  project_id: string | null;
  name: string;
  period: string;
  warn_at: number;
  crit_at: number;
  warn_clear: number;
  crit_clear: number;
  enabled: number;
  silenced_until: number | null;
  created_at: number;
  updated_at: number;
}

interface BudgetStateRow {
  config_id: string;
  status: string;
  current_spend: number;
  period_start: number;
  last_evaluated_at: number;
  last_transition_at: number | null;
}

interface BudgetEventRow {
  id: string;
  config_id: string;
  previous_status: string;
  new_status: string;
  spend: number;
  threshold: number;
  at: number;
}

// ─── Row mappers ────────────────────────────────────────────────────────────

function rowToConfig(row: BudgetConfigRow): BudgetConfig {
  return {
    id: row.id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    name: row.name,
    period: row.period as BudgetPeriod,
    warnAt: row.warn_at,
    critAt: row.crit_at,
    warnClear: row.warn_clear,
    critClear: row.crit_clear,
    enabled: row.enabled === 1,
    ...(row.silenced_until ? { silencedUntil: row.silenced_until } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToState(row: BudgetStateRow): BudgetState {
  return {
    configId: row.config_id,
    status: row.status as BudgetAlertStatus,
    currentSpend: row.current_spend,
    periodStart: row.period_start,
    lastEvaluatedAt: row.last_evaluated_at,
    ...(row.last_transition_at != null ? { lastTransitionAt: row.last_transition_at } : {}),
  };
}

function rowToEvent(row: BudgetEventRow): BudgetEvent {
  return {
    id: row.id,
    configId: row.config_id,
    previousStatus: row.previous_status as BudgetAlertStatus,
    newStatus: row.new_status as BudgetAlertStatus,
    spend: row.spend,
    threshold: row.threshold,
    at: row.at,
  };
}

// ─── Period helpers ─────────────────────────────────────────────────────────

/** Returns Unix ms for the start of the current budget period (local time). */
export function computePeriodStart(period: BudgetPeriod, now?: number): number {
  const d = new Date(now ?? Date.now());
  if (period === 'daily') {
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (period === 'weekly') {
    const day = d.getDay();
    const diff = day === 0 ? 6 : day - 1; // Monday = 0
    d.setDate(d.getDate() - diff);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  // monthly
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ─── Config CRUD ────────────────────────────────────────────────────────────

export interface UpsertBudgetParams {
  projectId?: string | undefined;
  name: string;
  period: BudgetPeriod;
  warnAt: number;
  critAt: number;
  warnClear?: number | undefined;
  critClear?: number | undefined;
}

export function upsertBudgetConfig(
  db: NexusDb,
  params: UpsertBudgetParams,
  source: 'cli' | 'mcp' | 'daemon' = 'mcp',
): BudgetConfig {
  const now = Date.now();
  const warnClear = params.warnClear ?? params.warnAt * 0.9;
  const critClear = params.critClear ?? params.critAt * 0.9;

  const existing = db
    .prepare(
      params.projectId
        ? 'SELECT * FROM budget_configs WHERE project_id = ? AND name = ?'
        : 'SELECT * FROM budget_configs WHERE project_id IS NULL AND name = ?',
    )
    .get(...(params.projectId ? [params.projectId, params.name] : [params.name])) as BudgetConfigRow | undefined;

  if (existing) {
    db.prepare(
      `UPDATE budget_configs SET period = ?, warn_at = ?, crit_at = ?, warn_clear = ?, crit_clear = ?, updated_at = ?
       WHERE id = ?`,
    ).run(params.period, params.warnAt, params.critAt, warnClear, critClear, now, existing.id);

    auditLog(db, {
      operation: 'budget.update',
      source,
      ...(params.projectId ? { projectId: params.projectId } : {}),
      meta: { name: params.name },
    });

    return rowToConfig({ ...existing, period: params.period, warn_at: params.warnAt, crit_at: params.critAt, warn_clear: warnClear, crit_clear: critClear, updated_at: now });
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO budget_configs (id, project_id, name, period, warn_at, crit_at, warn_clear, crit_clear, enabled, silenced_until, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
  ).run(id, params.projectId ?? null, params.name, params.period, params.warnAt, params.critAt, warnClear, critClear, now, now);

  auditLog(db, {
    operation: 'budget.create',
    source,
    ...(params.projectId ? { projectId: params.projectId } : {}),
    meta: { name: params.name },
  });

  return {
    id,
    ...(params.projectId ? { projectId: params.projectId } : {}),
    name: params.name,
    period: params.period,
    warnAt: params.warnAt,
    critAt: params.critAt,
    warnClear,
    critClear,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

export function getBudgetConfigs(db: NexusDb, projectId?: string): BudgetConfig[] {
  let rows: BudgetConfigRow[];
  if (projectId === undefined) {
    rows = db.prepare('SELECT * FROM budget_configs ORDER BY created_at ASC').all() as BudgetConfigRow[];
  } else {
    rows = db.prepare('SELECT * FROM budget_configs WHERE project_id = ? ORDER BY created_at ASC').all(projectId) as BudgetConfigRow[];
  }
  return rows.map(rowToConfig);
}

export function getGlobalBudgetConfigs(db: NexusDb): BudgetConfig[] {
  const rows = db.prepare('SELECT * FROM budget_configs WHERE project_id IS NULL ORDER BY created_at ASC').all() as BudgetConfigRow[];
  return rows.map(rowToConfig);
}

export function getBudgetConfigById(db: NexusDb, id: string): BudgetConfig | undefined {
  const row = db.prepare('SELECT * FROM budget_configs WHERE id = ?').get(id) as BudgetConfigRow | undefined;
  return row ? rowToConfig(row) : undefined;
}

export function deleteBudgetConfig(
  db: NexusDb,
  id: string,
  source: 'cli' | 'mcp' | 'daemon' = 'mcp',
): boolean {
  const existing = db.prepare('SELECT * FROM budget_configs WHERE id = ?').get(id) as BudgetConfigRow | undefined;
  if (!existing) return false;

  auditLog(db, {
    operation: 'budget.delete',
    source,
    ...(existing.project_id ? { projectId: existing.project_id } : {}),
    meta: { name: existing.name },
  });

  db.prepare('DELETE FROM budget_configs WHERE id = ?').run(id);
  return true;
}

export function silenceBudget(
  db: NexusDb,
  configId: string,
  untilMs: number,
  source: 'cli' | 'mcp' | 'daemon' = 'mcp',
): boolean {
  const result = db.prepare('UPDATE budget_configs SET silenced_until = ?, updated_at = ? WHERE id = ?').run(untilMs, Date.now(), configId);
  if (result.changes === 0) return false;

  auditLog(db, {
    operation: 'budget.silence',
    source,
    meta: { configId, until: new Date(untilMs).toISOString() },
  });
  return true;
}

export function unsilenceBudget(
  db: NexusDb,
  configId: string,
  source: 'cli' | 'mcp' | 'daemon' = 'mcp',
): boolean {
  const result = db.prepare('UPDATE budget_configs SET silenced_until = NULL, updated_at = ? WHERE id = ?').run(Date.now(), configId);
  if (result.changes === 0) return false;

  auditLog(db, {
    operation: 'budget.unsilence',
    source,
    meta: { configId },
  });
  return true;
}

// ─── State Machine ──────────────────────────────────────────────────────────

function computeNewStatus(
  currentStatus: BudgetAlertStatus,
  spend: number,
  config: BudgetConfig,
): { newStatus: BudgetAlertStatus; crossedThreshold: number } {
  // Escalation
  if (spend >= config.critAt && currentStatus !== 'critical') {
    return { newStatus: 'critical', crossedThreshold: config.critAt };
  }
  if (spend >= config.warnAt && currentStatus === 'clear') {
    return { newStatus: 'warning', crossedThreshold: config.warnAt };
  }

  // De-escalation (with hysteresis)
  if (currentStatus === 'critical' && spend < config.critClear) {
    if (spend < config.warnClear) {
      return { newStatus: 'clear', crossedThreshold: config.warnClear };
    }
    return { newStatus: 'warning', crossedThreshold: config.critClear };
  }
  if (currentStatus === 'warning' && spend < config.warnClear) {
    return { newStatus: 'clear', crossedThreshold: config.warnClear };
  }

  return { newStatus: currentStatus, crossedThreshold: 0 };
}

export function evaluateBudget(
  db: NexusDb,
  config: BudgetConfig,
  currentSpend: number,
): { state: BudgetState; event: BudgetEvent | undefined } {
  const now = Date.now();
  const periodStart = computePeriodStart(config.period, now);

  return db.transaction(() => {
    let stateRow = db.prepare('SELECT * FROM budget_state WHERE config_id = ?').get(config.id) as BudgetStateRow | undefined;

    // Create initial state if none exists
    if (!stateRow) {
      db.prepare(
        `INSERT INTO budget_state (config_id, status, current_spend, period_start, last_evaluated_at)
         VALUES (?, 'clear', ?, ?, ?)`,
      ).run(config.id, currentSpend, periodStart, now);
      stateRow = {
        config_id: config.id,
        status: 'clear',
        current_spend: currentSpend,
        period_start: periodStart,
        last_evaluated_at: now,
        last_transition_at: null,
      };
    }

    let currentStatus = stateRow.status as BudgetAlertStatus;

    // Period rollover — reset to clear
    if (stateRow.period_start < periodStart) {
      currentStatus = 'clear';
      db.prepare(
        'UPDATE budget_state SET status = ?, period_start = ?, current_spend = ?, last_evaluated_at = ? WHERE config_id = ?',
      ).run('clear', periodStart, currentSpend, now, config.id);
    }

    const { newStatus, crossedThreshold } = computeNewStatus(currentStatus, currentSpend, config);

    let event: BudgetEvent | undefined;
    if (newStatus !== currentStatus) {
      const eventId = randomUUID();
      db.prepare(
        `INSERT INTO budget_events (id, config_id, previous_status, new_status, spend, threshold, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(eventId, config.id, currentStatus, newStatus, currentSpend, crossedThreshold, now);

      event = {
        id: eventId,
        configId: config.id,
        previousStatus: currentStatus,
        newStatus,
        spend: currentSpend,
        threshold: crossedThreshold,
        at: now,
      };

      db.prepare(
        'UPDATE budget_state SET status = ?, current_spend = ?, last_evaluated_at = ?, last_transition_at = ? WHERE config_id = ?',
      ).run(newStatus, currentSpend, now, now, config.id);

      auditLog(db, {
        operation: `budget.transition.${newStatus}`,
        source: 'daemon',
        ...(config.projectId ? { projectId: config.projectId } : {}),
        meta: { name: config.name, from: currentStatus, to: newStatus, spend: currentSpend.toFixed(2) },
      });
    } else {
      db.prepare(
        'UPDATE budget_state SET current_spend = ?, last_evaluated_at = ? WHERE config_id = ?',
      ).run(currentSpend, now, config.id);
    }

    const state: BudgetState = {
      configId: config.id,
      status: newStatus,
      currentSpend,
      periodStart,
      lastEvaluatedAt: now,
      ...(newStatus !== currentStatus ? { lastTransitionAt: now } : stateRow.last_transition_at != null ? { lastTransitionAt: stateRow.last_transition_at } : {}),
    };

    return { state, event };
  })();
}

// ─── Event history ──────────────────────────────────────────────────────────

export function getBudgetEvents(
  db: NexusDb,
  configId?: string,
  limit = 50,
): BudgetEvent[] {
  const rows = configId
    ? db.prepare('SELECT * FROM budget_events WHERE config_id = ? ORDER BY at DESC LIMIT ?').all(configId, limit) as BudgetEventRow[]
    : db.prepare('SELECT * FROM budget_events ORDER BY at DESC LIMIT ?').all(limit) as BudgetEventRow[];
  return rows.map(rowToEvent);
}

// ─── State query ────────────────────────────────────────────────────────────

export function getBudgetState(db: NexusDb, configId: string): BudgetState | undefined {
  const row = db.prepare('SELECT * FROM budget_state WHERE config_id = ?').get(configId) as BudgetStateRow | undefined;
  return row ? rowToState(row) : undefined;
}
