import { randomUUID } from 'node:crypto';
import type { NexusDb } from '../db/connection.js';
import type { Preference } from '../types/index.js';
import { auditLog } from './audit.js';

interface PreferenceRow {
  id: string;
  key: string;
  value: string;
  scope: string;
  project_id: string | null;
  updated_at: number;
}

function rowToPreference(row: PreferenceRow): Preference {
  return {
    id: row.id,
    key: row.key,
    value: row.value,
    scope: row.scope as 'global' | 'project',
    projectId: row.project_id ?? undefined,
    updatedAt: row.updated_at,
  };
}

export function getPreference(
  db: NexusDb,
  key: string,
  projectId?: string,
): Preference | undefined {
  const row = projectId
    ? (db
        .prepare(
          "SELECT * FROM preferences WHERE key = ? AND scope = 'project' AND project_id = ?",
        )
        .get(key, projectId) as PreferenceRow | undefined)
    : (db
        .prepare("SELECT * FROM preferences WHERE key = ? AND scope = 'global'")
        .get(key) as PreferenceRow | undefined);
  return row ? rowToPreference(row) : undefined;
}

export function setPreference(
  db: NexusDb,
  key: string,
  value: string,
  scope: 'global' | 'project',
  projectId?: string,
  source: 'cli' | 'mcp' | 'daemon' = 'mcp',
): Preference {
  const existing = getPreference(db, key, projectId);

  if (existing) {
    db.prepare('UPDATE preferences SET value = ?, updated_at = ? WHERE id = ?').run(
      value,
      Date.now(),
      existing.id,
    );
    auditLog(db, { operation: 'preference.update', source, ...(projectId ? { projectId } : {}), meta: { key } });
    return { ...existing, value, updatedAt: Date.now() };
  }

  const pref: Preference = {
    id: randomUUID(),
    key,
    value,
    scope,
    ...(projectId ? { projectId } : {}),
    updatedAt: Date.now(),
  };

  db.prepare(
    'INSERT INTO preferences (id, key, value, scope, project_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(pref.id, pref.key, pref.value, pref.scope, projectId ?? null, pref.updatedAt);

  auditLog(db, { operation: 'preference.set', source, ...(projectId ? { projectId } : {}), meta: { key } });
  return pref;
}

export function listPreferences(db: NexusDb, projectId?: string): Preference[] {
  const rows = (
    projectId
      ? db
          .prepare(
            "SELECT * FROM preferences WHERE scope = 'global' OR (scope = 'project' AND project_id = ?) ORDER BY key",
          )
          .all(projectId)
      : db.prepare("SELECT * FROM preferences WHERE scope = 'global' ORDER BY key").all()
  ) as PreferenceRow[];
  return rows.map(rowToPreference);
}
