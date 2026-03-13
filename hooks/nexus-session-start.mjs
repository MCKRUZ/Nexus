#!/usr/bin/env node
/**
 * Nexus Session Tracker — SessionStart Hook
 *
 * Handles two scenarios:
 * 1. startup: Clean up old sessions (>24h), write initial session_meta row
 * 2. compact: Build a session snapshot from events and write to stdout
 *    so Claude can recover context after compaction
 *
 * Reads JSON from stdin: { session_id, type: 'startup'|'compact'|'resume', cwd }
 * DB location: ~/.claude/nexus-session.db
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const DB_PATH = join(homedir(), '.claude', 'nexus-session.db');
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── Inline snapshot builder ────────────────────────────────────────────────

function buildSnapshot(events, maxBytes = 2048) {
  if (!events || events.length === 0) return '';

  const p1 = events.filter(e => e.priority === 1);
  const p2 = events.filter(e => e.priority === 2);
  const p3 = events.filter(e => e.priority === 3);

  const header = '## Session Recovery (post-compaction)\n\n';
  let result = header;
  const budget = maxBytes - Buffer.byteLength(header);

  const p1Section = buildP1(p1);
  const p2Section = buildP2(p2);
  const p3Section = buildP3(p3);

  const p1Bytes = Buffer.byteLength(p1Section);
  const p2Bytes = Buffer.byteLength(p2Section);
  const p3Bytes = Buffer.byteLength(p3Section);

  if (p1Bytes + p2Bytes + p3Bytes <= budget) {
    result += p1Section + p2Section + p3Section;
  } else if (p1Bytes + p2Bytes <= budget) {
    result += p1Section + p2Section;
  } else if (p1Bytes <= budget) {
    result += p1Section;
  } else {
    result += p1Section.slice(0, budget);
  }

  return result.trim();
}

function buildP1(events) {
  if (!events.length) return '';
  const lines = ['### Active Context (P1)\n'];
  const files = [...new Set(events.filter(e => e.category === 'file').map(e => e.data))].slice(-10);
  if (files.length) {
    lines.push('**Files touched:**');
    files.forEach(f => lines.push(`- ${f}`));
    lines.push('');
  }
  const tasks = events.filter(e => e.category === 'task').slice(-5);
  if (tasks.length) {
    lines.push('**Tasks:**');
    tasks.forEach(t => lines.push(`- ${t.data}`));
    lines.push('');
  }
  return lines.join('\n');
}

function buildP2(events) {
  if (!events.length) return '';
  const lines = ['### Session History (P2)\n'];
  const errors = events.filter(e => e.category === 'error').slice(-3);
  if (errors.length) {
    lines.push('**Recent errors:**');
    errors.forEach(e => lines.push(`- ${e.data}`));
    lines.push('');
  }
  const git = events.filter(e => e.category === 'git').slice(-5);
  if (git.length) {
    lines.push('**Git operations:**');
    git.forEach(g => lines.push(`- ${g.data}`));
    lines.push('');
  }
  return lines.join('\n');
}

function buildP3(events) {
  if (!events.length) return '';
  const lines = ['### Tool Usage (P3)\n'];
  const counts = new Map();
  events.forEach(e => counts.set(e.source, (counts.get(e.source) ?? 0) + 1));
  [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .forEach(([t, c]) => lines.push(`- ${t}: ${c}x`));
  lines.push('');
  return lines.join('\n');
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  let input;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    input = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    process.exit(0);
  }

  const { session_id, type, cwd } = input;
  if (!session_id) process.exit(0);

  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    process.exit(0);
  }

  let db;
  try {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 1000');

    // Ensure schema exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        priority INTEGER NOT NULL,
        data TEXT NOT NULL,
        data_hash TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_se_session ON session_events(session_id);
      CREATE TABLE IF NOT EXISTS session_meta (
        session_id TEXT PRIMARY KEY,
        project_dir TEXT,
        started_at INTEGER,
        last_event INTEGER,
        event_count INTEGER DEFAULT 0,
        compact_count INTEGER DEFAULT 0
      );
    `);

    if (type === 'compact' || type === 'resume') {
      // Build snapshot from session events
      const events = db.prepare(
        'SELECT type, category, priority, data, source FROM session_events WHERE session_id = ? ORDER BY id ASC',
      ).all(session_id);

      if (events.length > 0) {
        const snapshot = buildSnapshot(events);
        if (snapshot) {
          process.stdout.write(snapshot);
        }
      }

      // Track compaction count
      if (type === 'compact') {
        db.prepare(
          `UPDATE session_meta SET compact_count = compact_count + 1 WHERE session_id = ?`,
        ).run(session_id);
      }
    } else {
      // startup — initialize session and clean old ones
      const now = Date.now();
      db.prepare(
        `INSERT OR REPLACE INTO session_meta (session_id, project_dir, started_at, last_event, event_count, compact_count)
         VALUES (?, ?, ?, ?, 0, 0)`,
      ).run(session_id, cwd ?? null, now, now);

      // Cleanup: remove sessions older than 24h
      const cutoff = now - SESSION_TTL_MS;
      const oldSessions = db.prepare(
        'SELECT session_id FROM session_meta WHERE started_at < ?',
      ).all(cutoff);

      for (const s of oldSessions) {
        db.prepare('DELETE FROM session_events WHERE session_id = ?').run(s.session_id);
        db.prepare('DELETE FROM session_meta WHERE session_id = ?').run(s.session_id);
      }
    }
  } catch {
    // Never block Claude
  } finally {
    if (db) db.close();
  }
}

main();
