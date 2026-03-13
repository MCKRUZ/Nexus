#!/usr/bin/env node
/**
 * Nexus Session Tracker — PostToolUse Hook
 *
 * Standalone ESM hook that records tool events in a lightweight SQLite DB
 * for session recovery after context compaction.
 *
 * Reads JSON from stdin: { tool_name, tool_input, tool_output, is_error, session_id }
 * Target: <10ms per invocation. No network, no LLM, no Nexus DB.
 *
 * Install: nexus hook install-session-tracking
 * DB location: ~/.claude/nexus-session.db (plain SQLite, no encryption)
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const DB_PATH = join(homedir(), '.claude', 'nexus-session.db');
const MAX_EVENTS_PER_SESSION = 500;
const MAX_DATA_CHARS = 300;

// ─── Schema (embedded, single-version) ──────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  type       TEXT NOT NULL,
  category   TEXT NOT NULL,
  priority   INTEGER NOT NULL,
  data       TEXT NOT NULL,
  data_hash  TEXT NOT NULL,
  source     TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);
CREATE INDEX IF NOT EXISTS idx_se_session ON session_events(session_id);
CREATE INDEX IF NOT EXISTS idx_se_hash ON session_events(session_id, data_hash);

CREATE TABLE IF NOT EXISTS session_meta (
  session_id   TEXT PRIMARY KEY,
  project_dir  TEXT,
  started_at   INTEGER,
  last_event   INTEGER,
  event_count  INTEGER DEFAULT 0,
  compact_count INTEGER DEFAULT 0
);
`;

// ─── Inline classifier (no Nexus dep) ───────────────────────────────────────

function classifyToolEvent(toolName, toolInput, toolOutput, isError) {
  const events = [];
  const lower = toolName.toLowerCase();
  const extractPath = (inp) =>
    String(inp?.file_path ?? inp?.path ?? inp?.notebook_path ?? '');

  if (lower === 'read') {
    events.push(mk('file_read', 'file', 1, extractPath(toolInput), toolName));
  } else if (lower === 'write') {
    events.push(mk('file_write', 'file', 1, extractPath(toolInput), toolName));
  } else if (lower === 'edit' || lower === 'multiedit') {
    events.push(mk('file_edit', 'file', 1, extractPath(toolInput), toolName));
  } else if (lower === 'notebookedit') {
    events.push(mk('file_edit', 'file', 1, extractPath(toolInput), toolName));
  } else if (lower === 'taskcreate') {
    events.push(mk('task_create', 'task', 1, trunc(String(toolInput?.subject ?? '')), toolName));
  } else if (lower === 'taskupdate') {
    events.push(mk('task_update', 'task', 1, trunc(`#${toolInput?.taskId ?? ''} -> ${toolInput?.status ?? ''}`), toolName));
  } else if (lower === 'bash') {
    const cmd = String(toolInput?.command ?? '');
    if (/\bgit\b/.test(cmd)) {
      const sub = cmd.match(/git\s+(\S+)/)?.[1] ?? 'unknown';
      events.push(mk('git', 'git', 2, trunc(`git ${sub}`), 'Bash'));
    } else if (/^\s*cd\b/.test(cmd)) {
      const dir = cmd.replace(/^\s*cd\s+/, '').replace(/["']/g, '');
      events.push(mk('env', 'env', 2, trunc(`cwd: ${dir}`), 'Bash'));
    }
    if (isError) {
      events.push(mk('error', 'error', 2, trunc(toolOutput.slice(0, 300)), 'Bash'));
    }
  } else if (lower === 'agent' || lower === 'skill') {
    events.push(mk('subagent', 'subagent', 3, trunc(String(toolInput?.description ?? toolInput?.skill ?? '')), toolName));
  } else if (toolName.includes('__')) {
    events.push(mk('mcp_tool', 'tool', 3, trunc(toolName), toolName));
  }

  if (isError && events.length === 0) {
    events.push(mk('error', 'error', 2, trunc(toolOutput.slice(0, 300)), toolName));
  }

  return events;
}

function mk(type, category, priority, data, source) {
  return { type, category, priority, data, source };
}

function trunc(s) {
  return s.length > MAX_DATA_CHARS ? s.slice(0, MAX_DATA_CHARS) : s;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  let input;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    input = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    process.exit(0); // Malformed input — don't block Claude
  }

  const { tool_name, tool_input, tool_output, is_error, session_id } = input;
  if (!tool_name || !session_id) process.exit(0);

  const classified = classifyToolEvent(
    tool_name,
    tool_input ?? {},
    typeof tool_output === 'string' ? tool_output : JSON.stringify(tool_output ?? ''),
    Boolean(is_error),
  );

  if (classified.length === 0) process.exit(0);

  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    // better-sqlite3 not available — silently exit
    process.exit(0);
  }

  let db;
  try {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 1000');

    // Create tables if needed
    db.exec(SCHEMA);

    const insertStmt = db.prepare(
      `INSERT INTO session_events (session_id, type, category, priority, data, data_hash, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const hashCheckStmt = db.prepare(
      `SELECT 1 FROM session_events WHERE session_id = ? AND data_hash = ? ORDER BY id DESC LIMIT 5`,
    );

    const upsertMeta = db.prepare(
      `INSERT INTO session_meta (session_id, last_event, event_count)
         VALUES (?, ?, 1)
       ON CONFLICT(session_id) DO UPDATE SET
         last_event = excluded.last_event,
         event_count = event_count + 1`,
    );

    const now = Date.now();

    db.transaction(() => {
      for (const evt of classified) {
        const hash = createHash('sha256')
          .update(`${evt.type}:${evt.data}`)
          .digest('hex')
          .slice(0, 16);

        // Dedup: skip if same hash in last 5 events
        const exists = hashCheckStmt.get(session_id, hash);
        if (exists) continue;

        insertStmt.run(session_id, evt.type, evt.category, evt.priority, evt.data, hash, evt.source);
      }
      upsertMeta.run(session_id, now);
    })();

    // FIFO eviction
    const countRow = db.prepare(
      'SELECT COUNT(*) as cnt FROM session_events WHERE session_id = ?',
    ).get(session_id);
    if (countRow && countRow.cnt > MAX_EVENTS_PER_SESSION) {
      const excess = countRow.cnt - MAX_EVENTS_PER_SESSION;
      db.prepare(
        `DELETE FROM session_events WHERE id IN (
           SELECT id FROM session_events WHERE session_id = ?
           ORDER BY id ASC LIMIT ?
         )`,
      ).run(session_id, excess);
    }
  } catch {
    // Never block Claude — silently exit on any DB error
  } finally {
    if (db) db.close();
  }
}

main();
