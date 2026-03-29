import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { migrateDatabase } from '../db/migrations.js';
import {
  computePeriodStart,
  upsertBudgetConfig,
  getBudgetConfigs,
  getBudgetConfigById,
  deleteBudgetConfig,
  silenceBudget,
  unsilenceBudget,
  evaluateBudget,
  getBudgetEvents,
  getBudgetState,
} from './budget.js';
import type { NexusDb } from '../db/connection.js';
import type { BudgetConfig } from '../types/index.js';

function openTestDb(): NexusDb {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrateDatabase(db);
  return db;
}

function insertTestProject(db: NexusDb, id?: string): string {
  const projectId = id ?? randomUUID();
  db.prepare(
    'INSERT INTO projects (id, name, path, registered_at) VALUES (?, ?, ?, ?)',
  ).run(projectId, 'test-project', `/test/project/${projectId}`, Date.now());
  return projectId;
}

describe('BudgetRepository', () => {
  let db: NexusDb;

  beforeEach(() => {
    db = openTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // ─── computePeriodStart ──────────────────────────────────────────────────

  describe('computePeriodStart', () => {
    it('computes daily period start as midnight today', () => {
      const now = new Date(2026, 2, 24, 14, 30, 0).getTime(); // March 24, 2026, 14:30
      const result = computePeriodStart('daily', now);

      const expected = new Date(2026, 2, 24, 0, 0, 0, 0).getTime();
      expect(result).toBe(expected);
    });

    it('computes weekly period start as Monday midnight', () => {
      // March 24, 2026 is a Tuesday
      const tuesday = new Date(2026, 2, 24, 10, 0, 0).getTime();
      const result = computePeriodStart('weekly', tuesday);

      const expectedMonday = new Date(2026, 2, 23, 0, 0, 0, 0).getTime();
      expect(result).toBe(expectedMonday);

      // Verify Sunday wraps back to previous Monday
      const sunday = new Date(2026, 2, 29, 18, 0, 0).getTime();
      const sundayResult = computePeriodStart('weekly', sunday);
      const expectedMondayForSunday = new Date(2026, 2, 23, 0, 0, 0, 0).getTime();
      expect(sundayResult).toBe(expectedMondayForSunday);
    });

    it('computes monthly period start as 1st of month', () => {
      const midMonth = new Date(2026, 2, 15, 9, 0, 0).getTime(); // March 15
      const result = computePeriodStart('monthly', midMonth);

      const expected = new Date(2026, 2, 1, 0, 0, 0, 0).getTime();
      expect(result).toBe(expected);
    });
  });

  // ─── upsertBudgetConfig ─────────────────────────────────────────────────

  describe('upsertBudgetConfig', () => {
    it('creates a new global budget config (no projectId)', () => {
      const config = upsertBudgetConfig(db, {
        name: 'global-daily',
        period: 'daily',
        warnAt: 10,
        critAt: 20,
      });

      expect(config.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(config.projectId).toBeUndefined();
      expect(config.name).toBe('global-daily');
      expect(config.period).toBe('daily');
      expect(config.warnAt).toBe(10);
      expect(config.critAt).toBe(20);
      expect(config.enabled).toBe(true);
      expect(config.createdAt).toBeGreaterThan(0);
    });

    it('creates a per-project budget config', () => {
      const projectId = insertTestProject(db);
      const config = upsertBudgetConfig(db, {
        projectId,
        name: 'project-monthly',
        period: 'monthly',
        warnAt: 50,
        critAt: 100,
      });

      expect(config.projectId).toBe(projectId);
      expect(config.name).toBe('project-monthly');
      expect(config.period).toBe('monthly');
    });

    it('updates existing config by name+projectId', () => {
      const projectId = insertTestProject(db);
      const original = upsertBudgetConfig(db, {
        projectId,
        name: 'api-calls',
        period: 'daily',
        warnAt: 10,
        critAt: 20,
      });

      const updated = upsertBudgetConfig(db, {
        projectId,
        name: 'api-calls',
        period: 'weekly',
        warnAt: 50,
        critAt: 100,
      });

      expect(updated.id).toBe(original.id);
      expect(updated.period).toBe('weekly');
      expect(updated.warnAt).toBe(50);
      expect(updated.critAt).toBe(100);
      expect(updated.updatedAt).toBeGreaterThanOrEqual(original.updatedAt);
    });

    it('sets default hysteresis values when not provided', () => {
      const config = upsertBudgetConfig(db, {
        name: 'with-defaults',
        period: 'daily',
        warnAt: 100,
        critAt: 200,
      });

      expect(config.warnClear).toBe(90);   // 100 * 0.9
      expect(config.critClear).toBe(180);   // 200 * 0.9
    });

    it('uses explicit hysteresis values when provided', () => {
      const config = upsertBudgetConfig(db, {
        name: 'custom-hysteresis',
        period: 'daily',
        warnAt: 100,
        critAt: 200,
        warnClear: 80,
        critClear: 150,
      });

      expect(config.warnClear).toBe(80);
      expect(config.critClear).toBe(150);
    });
  });

  // ─── getBudgetConfigs / getBudgetConfigById ──────────────────────────────

  describe('getBudgetConfigs', () => {
    it('returns all configs when no filter', () => {
      const projectId = insertTestProject(db);
      upsertBudgetConfig(db, { name: 'global', period: 'daily', warnAt: 10, critAt: 20 });
      upsertBudgetConfig(db, { projectId, name: 'project', period: 'weekly', warnAt: 50, critAt: 100 });

      const all = getBudgetConfigs(db);
      expect(all).toHaveLength(2);
    });

    it('filters by projectId', () => {
      const projectId = insertTestProject(db);
      upsertBudgetConfig(db, { name: 'global', period: 'daily', warnAt: 10, critAt: 20 });
      upsertBudgetConfig(db, { projectId, name: 'project', period: 'weekly', warnAt: 50, critAt: 100 });

      const filtered = getBudgetConfigs(db, projectId);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe('project');
    });
  });

  describe('getBudgetConfigById', () => {
    it('returns config by id', () => {
      const config = upsertBudgetConfig(db, { name: 'findme', period: 'daily', warnAt: 10, critAt: 20 });
      const found = getBudgetConfigById(db, config.id);

      expect(found).toBeDefined();
      expect(found!.name).toBe('findme');
    });

    it('returns undefined for non-existent ID', () => {
      expect(getBudgetConfigById(db, randomUUID())).toBeUndefined();
    });
  });

  // ─── deleteBudgetConfig ─────────────────────────────────────────────────

  describe('deleteBudgetConfig', () => {
    it('deletes existing config and returns true', () => {
      const config = upsertBudgetConfig(db, { name: 'doomed', period: 'daily', warnAt: 10, critAt: 20 });
      const result = deleteBudgetConfig(db, config.id);

      expect(result).toBe(true);
      expect(getBudgetConfigById(db, config.id)).toBeUndefined();
    });

    it('returns false for non-existent config', () => {
      expect(deleteBudgetConfig(db, randomUUID())).toBe(false);
    });

    it('CASCADE deletes associated state and events', () => {
      const config = upsertBudgetConfig(db, { name: 'cascade-test', period: 'daily', warnAt: 10, critAt: 20 });

      // Create state and an event by evaluating budget
      evaluateBudget(db, config, 15); // CLEAR -> WARNING

      // Verify state and events exist
      expect(getBudgetState(db, config.id)).toBeDefined();
      expect(getBudgetEvents(db, config.id)).toHaveLength(1);

      // Delete the config
      deleteBudgetConfig(db, config.id);

      // State and events should be gone (CASCADE)
      expect(getBudgetState(db, config.id)).toBeUndefined();
      expect(getBudgetEvents(db, config.id)).toHaveLength(0);
    });
  });

  // ─── silenceBudget / unsilenceBudget ─────────────────────────────────────

  describe('silenceBudget', () => {
    it('sets silencedUntil timestamp', () => {
      const config = upsertBudgetConfig(db, { name: 'silence-me', period: 'daily', warnAt: 10, critAt: 20 });
      const untilMs = Date.now() + 3600_000; // 1 hour from now
      const result = silenceBudget(db, config.id, untilMs);

      expect(result).toBe(true);
      const updated = getBudgetConfigById(db, config.id);
      expect(updated!.silencedUntil).toBe(untilMs);
    });

    it('returns false for non-existent configId', () => {
      expect(silenceBudget(db, randomUUID(), Date.now())).toBe(false);
    });
  });

  describe('unsilenceBudget', () => {
    it('clears silencedUntil', () => {
      const config = upsertBudgetConfig(db, { name: 'unsilence-me', period: 'daily', warnAt: 10, critAt: 20 });
      silenceBudget(db, config.id, Date.now() + 3600_000);

      const result = unsilenceBudget(db, config.id);
      expect(result).toBe(true);

      const updated = getBudgetConfigById(db, config.id);
      expect(updated!.silencedUntil).toBeUndefined();
    });

    it('returns false for non-existent configId', () => {
      expect(unsilenceBudget(db, randomUUID())).toBe(false);
    });
  });

  // ─── evaluateBudget — state machine ──────────────────────────────────────

  describe('evaluateBudget', () => {
    function makeConfig(overrides: Partial<BudgetConfig> = {}): BudgetConfig {
      const id = randomUUID();
      const now = Date.now();
      const base: BudgetConfig = {
        id,
        name: 'test-budget',
        period: 'daily',
        warnAt: 100,
        critAt: 200,
        warnClear: 90,
        critClear: 180,
        enabled: true,
        createdAt: now,
        updatedAt: now,
        ...overrides,
      };
      // Insert directly into DB so evaluateBudget can find/create state
      db.prepare(
        `INSERT INTO budget_configs (id, project_id, name, period, warn_at, crit_at, warn_clear, crit_clear, enabled, silenced_until, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        base.id,
        base.projectId ?? null,
        base.name,
        base.period,
        base.warnAt,
        base.critAt,
        base.warnClear,
        base.critClear,
        base.enabled ? 1 : 0,
        base.silencedUntil ?? null,
        base.createdAt,
        base.updatedAt,
      );
      return base;
    }

    it('transitions CLEAR -> WARNING when spend >= warnAt', () => {
      const config = makeConfig({ warnAt: 100, critAt: 200 });
      const { state, event } = evaluateBudget(db, config, 100);

      expect(state.status).toBe('warning');
      expect(event).toBeDefined();
      expect(event!.previousStatus).toBe('clear');
      expect(event!.newStatus).toBe('warning');
      expect(event!.spend).toBe(100);
      expect(event!.threshold).toBe(100);
    });

    it('transitions CLEAR -> CRITICAL when spend >= critAt (skip WARNING)', () => {
      const config = makeConfig({ warnAt: 100, critAt: 200 });
      const { state, event } = evaluateBudget(db, config, 250);

      expect(state.status).toBe('critical');
      expect(event).toBeDefined();
      expect(event!.previousStatus).toBe('clear');
      expect(event!.newStatus).toBe('critical');
      expect(event!.threshold).toBe(200);
    });

    it('transitions WARNING -> CRITICAL when spend >= critAt', () => {
      const config = makeConfig({ warnAt: 100, critAt: 200 });

      // First move to WARNING
      evaluateBudget(db, config, 150);

      // Then to CRITICAL
      const { state, event } = evaluateBudget(db, config, 200);
      expect(state.status).toBe('critical');
      expect(event).toBeDefined();
      expect(event!.previousStatus).toBe('warning');
      expect(event!.newStatus).toBe('critical');
    });

    it('does NOT transition WARNING -> CLEAR when spend between warnClear and warnAt (hysteresis)', () => {
      const config = makeConfig({ warnAt: 100, critAt: 200, warnClear: 90, critClear: 180 });

      // Move to WARNING
      evaluateBudget(db, config, 110);

      // Spend drops to 95 (between warnClear=90 and warnAt=100) — should stay WARNING
      const { state, event } = evaluateBudget(db, config, 95);
      expect(state.status).toBe('warning');
      expect(event).toBeUndefined();
    });

    it('transitions WARNING -> CLEAR when spend < warnClear', () => {
      const config = makeConfig({ warnAt: 100, critAt: 200, warnClear: 90, critClear: 180 });

      // Move to WARNING
      evaluateBudget(db, config, 110);

      // Spend drops below warnClear threshold
      const { state, event } = evaluateBudget(db, config, 80);
      expect(state.status).toBe('clear');
      expect(event).toBeDefined();
      expect(event!.previousStatus).toBe('warning');
      expect(event!.newStatus).toBe('clear');
    });

    it('transitions CRITICAL -> WARNING when spend < critClear', () => {
      const config = makeConfig({ warnAt: 100, critAt: 200, warnClear: 90, critClear: 180 });

      // Move to CRITICAL
      evaluateBudget(db, config, 250);

      // Spend drops below critClear but above warnClear — should be WARNING
      const { state, event } = evaluateBudget(db, config, 150);
      expect(state.status).toBe('warning');
      expect(event).toBeDefined();
      expect(event!.previousStatus).toBe('critical');
      expect(event!.newStatus).toBe('warning');
    });

    it('transitions CRITICAL -> CLEAR when spend < warnClear', () => {
      const config = makeConfig({ warnAt: 100, critAt: 200, warnClear: 90, critClear: 180 });

      // Move to CRITICAL
      evaluateBudget(db, config, 250);

      // Spend drops below warnClear — should go straight to CLEAR
      const { state, event } = evaluateBudget(db, config, 50);
      expect(state.status).toBe('clear');
      expect(event).toBeDefined();
      expect(event!.previousStatus).toBe('critical');
      expect(event!.newStatus).toBe('clear');
    });

    it('creates BudgetEvent on transition', () => {
      const config = makeConfig({ warnAt: 100, critAt: 200 });
      evaluateBudget(db, config, 100); // CLEAR -> WARNING

      const events = getBudgetEvents(db, config.id);
      expect(events).toHaveLength(1);
      expect(events[0].configId).toBe(config.id);
      expect(events[0].previousStatus).toBe('clear');
      expect(events[0].newStatus).toBe('warning');
      expect(events[0].id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('does not create event when status unchanged', () => {
      const config = makeConfig({ warnAt: 100, critAt: 200 });

      // Move to WARNING
      evaluateBudget(db, config, 110);

      // Still in WARNING range — no new event
      const { event } = evaluateBudget(db, config, 120);
      expect(event).toBeUndefined();

      const events = getBudgetEvents(db, config.id);
      expect(events).toHaveLength(1); // Only the initial CLEAR->WARNING
    });

    it('resets to CLEAR on period rollover', () => {
      const config = makeConfig({ warnAt: 100, critAt: 200, period: 'daily' });

      // Move to WARNING
      evaluateBudget(db, config, 150);
      const stateAfterWarn = getBudgetState(db, config.id);
      expect(stateAfterWarn!.status).toBe('warning');

      // Manually set period_start to yesterday to simulate rollover
      const yesterday = computePeriodStart('daily') - 86400_000;
      db.prepare(
        'UPDATE budget_state SET period_start = ? WHERE config_id = ?',
      ).run(yesterday, config.id);

      // Evaluate with low spend — period rolled over, so state resets to CLEAR first
      const { state } = evaluateBudget(db, config, 10);
      expect(state.status).toBe('clear');
      expect(state.periodStart).toBe(computePeriodStart('daily'));
    });
  });

  // ─── getBudgetEvents ─────────────────────────────────────────────────────

  describe('getBudgetEvents', () => {
    it('returns events ordered by timestamp desc', () => {
      const config = upsertBudgetConfig(db, { name: 'event-order', period: 'daily', warnAt: 10, critAt: 20 });

      // CLEAR -> WARNING -> CRITICAL = 2 events
      evaluateBudget(db, config, 10);
      evaluateBudget(db, config, 20);

      const events = getBudgetEvents(db);
      expect(events).toHaveLength(2);
      // Most recent first
      expect(events[0].at).toBeGreaterThanOrEqual(events[1].at);
      expect(events[0].newStatus).toBe('critical');
      expect(events[1].newStatus).toBe('warning');
    });

    it('filters by configId', () => {
      const c1 = upsertBudgetConfig(db, { name: 'config-a', period: 'daily', warnAt: 10, critAt: 20 });
      const c2 = upsertBudgetConfig(db, { name: 'config-b', period: 'daily', warnAt: 10, critAt: 20 });

      evaluateBudget(db, c1, 10); // CLEAR -> WARNING
      evaluateBudget(db, c2, 10); // CLEAR -> WARNING

      const eventsC1 = getBudgetEvents(db, c1.id);
      expect(eventsC1).toHaveLength(1);
      expect(eventsC1[0].configId).toBe(c1.id);

      const eventsC2 = getBudgetEvents(db, c2.id);
      expect(eventsC2).toHaveLength(1);
      expect(eventsC2[0].configId).toBe(c2.id);
    });
  });
});
