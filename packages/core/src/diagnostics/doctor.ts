/**
 * Nexus Doctor — system health diagnostics.
 *
 * Checks pipeline health, per-project knowledge coverage, and identifies gaps.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { NexusDb } from '../db/connection.js';
import { CONFIG_FILE, isInitialized } from '../config/index.js';
import { getPipelineStats } from './pipeline.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DoctorReport {
  overall: 'healthy' | 'degraded' | 'failing';
  checks: DoctorCheck[];
  projects: ProjectHealth[];
}

export interface DoctorCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
}

export interface ProjectHealth {
  projectId: string;
  projectName: string;
  coverageScore: number;
  lastSyncAge: number | null;
  noteCount: number;
  decisionCount: number;
  patternCount: number;
  gaps: string[];
}

// ─── Internal row types ─────────────────────────────────────────────────────

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  last_seen_at: number | null;
}

interface CountRow {
  cnt: number;
}

interface NoteRow {
  content: string;
}

interface SyncRow {
  at: number;
}

interface RelatedRow {
  cnt: number;
}

// ─── System checks ──────────────────────────────────────────────────────────

function checkDbAccessible(db: NexusDb): DoctorCheck {
  try {
    // If key pragma failed, any query would throw
    const row = db.prepare('SELECT count(*) AS cnt FROM projects').get() as CountRow;
    return {
      name: 'Database accessible & encrypted',
      status: 'pass',
      message: `SQLCipher OK, ${row.cnt} project(s) in DB`,
    };
  } catch (err) {
    return {
      name: 'Database accessible & encrypted',
      status: 'fail',
      message: err instanceof Error ? err.message : 'DB query failed',
    };
  }
}

function checkConfigExists(): DoctorCheck {
  if (fs.existsSync(CONFIG_FILE)) {
    return { name: 'Config file exists', status: 'pass', message: CONFIG_FILE };
  }
  return {
    name: 'Config file exists',
    status: 'fail',
    message: 'Missing ~/.nexus/config.json — run `nexus init`',
  };
}

function checkProjectsRegistered(db: NexusDb): DoctorCheck {
  const row = db.prepare('SELECT count(*) AS cnt FROM projects').get() as CountRow;
  if (row.cnt > 0) {
    return {
      name: 'Projects registered',
      status: 'pass',
      message: `${row.cnt} project(s)`,
    };
  }
  return {
    name: 'Projects registered',
    status: 'warn',
    message: 'No projects registered — run `nexus project add <path>`',
  };
}

function checkHookInstalled(): DoctorCheck {
  const hooksPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    if (fs.existsSync(hooksPath)) {
      const raw = fs.readFileSync(hooksPath, 'utf8');
      if (raw.includes('post-session')) {
        return {
          name: 'Post-session hook installed',
          status: 'pass',
          message: 'Found in ~/.claude/settings.json',
        };
      }
    }
    return {
      name: 'Post-session hook installed',
      status: 'warn',
      message: 'No post-session hook found in ~/.claude/settings.json',
    };
  } catch {
    return {
      name: 'Post-session hook installed',
      status: 'warn',
      message: 'Could not read ~/.claude/settings.json',
    };
  }
}

function checkRecentActivity(db: NexusDb): DoctorCheck {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const row = db
    .prepare(
      `SELECT count(*) AS cnt FROM audit_log
       WHERE operation LIKE 'pipeline.%' AND at >= ?`,
    )
    .get(since) as CountRow;

  if (row.cnt > 0) {
    return {
      name: 'Recent pipeline activity',
      status: 'pass',
      message: `${row.cnt} pipeline event(s) in last 24h`,
    };
  }
  return {
    name: 'Recent pipeline activity',
    status: 'warn',
    message: 'No pipeline events in last 24h — hook may not be running',
  };
}

// ─── Per-project coverage ───────────────────────────────────────────────────

function computeProjectHealth(db: NexusDb, project: ProjectRow): ProjectHealth {
  const noteCount = (
    db.prepare('SELECT count(*) AS cnt FROM notes WHERE project_id = ?').get(project.id) as CountRow
  ).cnt;

  const decisionCount = (
    db.prepare('SELECT count(*) AS cnt FROM decisions WHERE project_id = ?').get(project.id) as CountRow
  ).cnt;

  const patternCount = (
    db.prepare('SELECT count(*) AS cnt FROM patterns WHERE project_id = ?').get(project.id) as CountRow
  ).cnt;

  // Check if any note has >100 chars
  const substantialNote = db
    .prepare('SELECT content FROM notes WHERE project_id = ? AND length(content) > 100 LIMIT 1')
    .get(project.id) as NoteRow | undefined;

  // Last sync event for this project
  const lastSync = db
    .prepare(
      `SELECT at FROM audit_log
       WHERE project_id = ? AND operation = 'pipeline.sync.success'
       ORDER BY at DESC LIMIT 1`,
    )
    .get(project.id) as SyncRow | undefined;

  // Also check last_seen_at as a fallback for sync freshness
  const lastActivity = lastSync?.at ?? project.last_seen_at;
  const lastSyncAge = lastActivity ? (Date.now() - lastActivity) / (1000 * 60 * 60) : null;

  // Cross-project visibility: does this project appear in another project's related notes?
  // Approximation: check if this project has a parentId or is a parent of another
  const crossProjectVisible = (
    db.prepare(
      `SELECT count(*) AS cnt FROM projects
       WHERE (parent_id = ? OR id = (SELECT parent_id FROM projects WHERE id = ?))
       AND id != ?`,
    ).get(project.id, project.id, project.id) as RelatedRow
  ).cnt > 0;

  // Score calculation
  let score = 0;
  if (substantialNote) score += 30;
  if (decisionCount > 0) score += 20;
  if (patternCount > 0) score += 10;

  // Sync freshness (20 pts)
  if (lastSyncAge !== null) {
    const syncDays = lastSyncAge / 24;
    if (syncDays <= 7) score += 20;
    else if (syncDays <= 14) score += 10;
  }

  // Cross-project visibility (20 pts)
  if (crossProjectVisible) score += 20;

  // Gaps
  const gaps: string[] = [];
  if (noteCount === 0) gaps.push('No notes');
  else if (!substantialNote) gaps.push('Notes too short (<100 chars)');
  if (decisionCount === 0) gaps.push('No decisions');
  if (patternCount === 0) gaps.push('No patterns');
  if (lastSyncAge === null) gaps.push('Never synced');
  else if (lastSyncAge / 24 > 7) gaps.push(`Sync stale (${Math.round(lastSyncAge / 24)}d)`);
  if (!crossProjectVisible) gaps.push('Not visible cross-project');

  return {
    projectId: project.id,
    projectName: project.name,
    coverageScore: score,
    lastSyncAge: lastSyncAge !== null ? Math.round(lastSyncAge * 10) / 10 : null,
    noteCount,
    decisionCount,
    patternCount,
    gaps,
  };
}

// ─── Main report ────────────────────────────────────────────────────────────

export function runDoctor(db: NexusDb): DoctorReport {
  const checks: DoctorCheck[] = [
    checkDbAccessible(db),
    checkConfigExists(),
    checkProjectsRegistered(db),
    checkHookInstalled(),
    checkRecentActivity(db),
  ];

  // Per-project health
  const projects = db
    .prepare('SELECT id, name, path, last_seen_at FROM projects ORDER BY name')
    .all() as ProjectRow[];

  const projectHealths = projects.map((p) => computeProjectHealth(db, p));

  // Overall status
  const failCount = checks.filter((c) => c.status === 'fail').length;
  const warnCount = checks.filter((c) => c.status === 'warn').length;
  const lowCoverage = projectHealths.filter((p) => p.coverageScore < 50).length;

  let overall: DoctorReport['overall'] = 'healthy';
  if (failCount > 0) overall = 'failing';
  else if (warnCount >= 2 || lowCoverage > projects.length / 2) overall = 'degraded';

  return { overall, checks, projects: projectHealths };
}
