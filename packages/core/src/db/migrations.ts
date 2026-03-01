import type { NexusDb } from './connection.js';

const MIGRATIONS: Array<{ version: number; up: string }> = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        path        TEXT NOT NULL UNIQUE,
        registered_at INTEGER NOT NULL,
        last_seen_at  INTEGER,
        parent_id   TEXT REFERENCES projects(id),
        tags        TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS decisions (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL REFERENCES projects(id),
        kind          TEXT NOT NULL,
        summary       TEXT NOT NULL,
        rationale     TEXT,
        session_id    TEXT,
        recorded_at   INTEGER NOT NULL,
        superseded_by TEXT REFERENCES decisions(id)
      );

      CREATE TABLE IF NOT EXISTS patterns (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL REFERENCES projects(id),
        name         TEXT NOT NULL,
        description  TEXT NOT NULL,
        example_path TEXT,
        frequency    INTEGER NOT NULL DEFAULT 1,
        last_seen_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conflicts (
        id           TEXT PRIMARY KEY,
        project_ids  TEXT NOT NULL, -- JSON array
        description  TEXT NOT NULL,
        detected_at  INTEGER NOT NULL,
        resolved_at  INTEGER,
        resolution   TEXT
      );

      CREATE TABLE IF NOT EXISTS preferences (
        id         TEXT PRIMARY KEY,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        scope      TEXT NOT NULL CHECK(scope IN ('global', 'project')),
        project_id TEXT REFERENCES projects(id),
        updated_at INTEGER NOT NULL,
        UNIQUE(key, scope, project_id)
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id         TEXT PRIMARY KEY,
        operation  TEXT NOT NULL,
        source     TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        at         INTEGER NOT NULL,
        meta       TEXT -- JSON object
      );

      CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_id);
      CREATE INDEX IF NOT EXISTS idx_decisions_kind ON decisions(kind);
      CREATE INDEX IF NOT EXISTS idx_patterns_project ON patterns(project_id);
      CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
    `,
  },
];

export function migrateDatabase(db: NexusDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const currentVersion =
    (
      db
        .prepare('SELECT MAX(version) as v FROM schema_version')
        .get() as { v: number | null }
    ).v ?? 0;

  const pending = MIGRATIONS.filter((m) => m.version > currentVersion);

  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.up);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        Date.now(),
      );
    })();
  }
}
