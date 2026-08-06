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
  {
    version: 2,
    up: `
      CREATE TABLE IF NOT EXISTS notes (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title      TEXT NOT NULL,
        content    TEXT NOT NULL,
        tags       TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source     TEXT NOT NULL DEFAULT 'mcp',
        UNIQUE(project_id, title)
      );
      CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project_id);
      CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at);
    `,
  },
  {
    version: 3,
    up: `
      -- FTS5 porter tables (ranked full-text search)
      CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
        summary, rationale, entity_id UNINDEXED,
        tokenize='porter unicode61'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS patterns_fts USING fts5(
        name, description, entity_id UNINDEXED,
        tokenize='porter unicode61'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        title, content, entity_id UNINDEXED,
        tokenize='porter unicode61'
      );

      -- FTS5 trigram tables (fuzzy/substring search fallback)
      CREATE VIRTUAL TABLE IF NOT EXISTS decisions_trigram USING fts5(
        summary, rationale, entity_id UNINDEXED,
        tokenize='trigram'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS patterns_trigram USING fts5(
        name, description, entity_id UNINDEXED,
        tokenize='trigram'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_trigram USING fts5(
        title, content, entity_id UNINDEXED,
        tokenize='trigram'
      );

      -- Sync triggers: decisions
      CREATE TRIGGER IF NOT EXISTS decisions_ai AFTER INSERT ON decisions BEGIN
        INSERT INTO decisions_fts(summary, rationale, entity_id)
          VALUES (NEW.summary, COALESCE(NEW.rationale, ''), NEW.id);
        INSERT INTO decisions_trigram(summary, rationale, entity_id)
          VALUES (NEW.summary, COALESCE(NEW.rationale, ''), NEW.id);
      END;
      CREATE TRIGGER IF NOT EXISTS decisions_au AFTER UPDATE ON decisions BEGIN
        DELETE FROM decisions_fts WHERE entity_id = OLD.id;
        DELETE FROM decisions_trigram WHERE entity_id = OLD.id;
        INSERT INTO decisions_fts(summary, rationale, entity_id)
          VALUES (NEW.summary, COALESCE(NEW.rationale, ''), NEW.id);
        INSERT INTO decisions_trigram(summary, rationale, entity_id)
          VALUES (NEW.summary, COALESCE(NEW.rationale, ''), NEW.id);
      END;
      CREATE TRIGGER IF NOT EXISTS decisions_ad AFTER DELETE ON decisions BEGIN
        DELETE FROM decisions_fts WHERE entity_id = OLD.id;
        DELETE FROM decisions_trigram WHERE entity_id = OLD.id;
      END;

      -- Sync triggers: patterns
      CREATE TRIGGER IF NOT EXISTS patterns_ai AFTER INSERT ON patterns BEGIN
        INSERT INTO patterns_fts(name, description, entity_id)
          VALUES (NEW.name, NEW.description, NEW.id);
        INSERT INTO patterns_trigram(name, description, entity_id)
          VALUES (NEW.name, NEW.description, NEW.id);
      END;
      CREATE TRIGGER IF NOT EXISTS patterns_au AFTER UPDATE ON patterns BEGIN
        DELETE FROM patterns_fts WHERE entity_id = OLD.id;
        DELETE FROM patterns_trigram WHERE entity_id = OLD.id;
        INSERT INTO patterns_fts(name, description, entity_id)
          VALUES (NEW.name, NEW.description, NEW.id);
        INSERT INTO patterns_trigram(name, description, entity_id)
          VALUES (NEW.name, NEW.description, NEW.id);
      END;
      CREATE TRIGGER IF NOT EXISTS patterns_ad AFTER DELETE ON patterns BEGIN
        DELETE FROM patterns_fts WHERE entity_id = OLD.id;
        DELETE FROM patterns_trigram WHERE entity_id = OLD.id;
      END;

      -- Sync triggers: notes
      CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(title, content, entity_id)
          VALUES (NEW.title, NEW.content, NEW.id);
        INSERT INTO notes_trigram(title, content, entity_id)
          VALUES (NEW.title, NEW.content, NEW.id);
      END;
      CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
        DELETE FROM notes_fts WHERE entity_id = OLD.id;
        DELETE FROM notes_trigram WHERE entity_id = OLD.id;
        INSERT INTO notes_fts(title, content, entity_id)
          VALUES (NEW.title, NEW.content, NEW.id);
        INSERT INTO notes_trigram(title, content, entity_id)
          VALUES (NEW.title, NEW.content, NEW.id);
      END;
      CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
        DELETE FROM notes_fts WHERE entity_id = OLD.id;
        DELETE FROM notes_trigram WHERE entity_id = OLD.id;
      END;

      -- Backfill existing data into FTS tables
      INSERT INTO decisions_fts(summary, rationale, entity_id)
        SELECT summary, COALESCE(rationale, ''), id FROM decisions;
      INSERT INTO decisions_trigram(summary, rationale, entity_id)
        SELECT summary, COALESCE(rationale, ''), id FROM decisions;

      INSERT INTO patterns_fts(name, description, entity_id)
        SELECT name, description, id FROM patterns;
      INSERT INTO patterns_trigram(name, description, entity_id)
        SELECT name, description, id FROM patterns;

      INSERT INTO notes_fts(title, content, entity_id)
        SELECT title, content, id FROM notes;
      INSERT INTO notes_trigram(title, content, entity_id)
        SELECT title, content, id FROM notes;
    `,
  },
  {
    version: 4,
    up: `
      ALTER TABLE conflicts ADD COLUMN tier TEXT NOT NULL DEFAULT 'conflict' CHECK(tier IN ('advisory', 'conflict'));
      ALTER TABLE conflicts ADD COLUMN severity TEXT NOT NULL DEFAULT 'medium' CHECK(severity IN ('critical', 'high', 'medium', 'low', 'info'));
    `,
  },
  {
    version: 5,
    up: `
      CREATE TABLE IF NOT EXISTS budget_configs (
        id             TEXT PRIMARY KEY,
        project_id     TEXT REFERENCES projects(id) ON DELETE CASCADE,
        name           TEXT NOT NULL,
        period         TEXT NOT NULL CHECK(period IN ('daily', 'weekly', 'monthly')),
        warn_at        REAL NOT NULL,
        crit_at        REAL NOT NULL,
        warn_clear     REAL NOT NULL,
        crit_clear     REAL NOT NULL,
        enabled        INTEGER NOT NULL DEFAULT 1,
        silenced_until INTEGER,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        UNIQUE(project_id, name)
      );
      CREATE INDEX IF NOT EXISTS idx_budget_configs_project ON budget_configs(project_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_configs_global_name
        ON budget_configs(name) WHERE project_id IS NULL;

      CREATE TABLE IF NOT EXISTS budget_state (
        config_id         TEXT PRIMARY KEY REFERENCES budget_configs(id) ON DELETE CASCADE,
        status            TEXT NOT NULL DEFAULT 'clear' CHECK(status IN ('clear', 'warning', 'critical')),
        current_spend     REAL NOT NULL DEFAULT 0,
        period_start      INTEGER NOT NULL,
        last_evaluated_at INTEGER NOT NULL,
        last_transition_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS budget_events (
        id              TEXT PRIMARY KEY,
        config_id       TEXT NOT NULL REFERENCES budget_configs(id) ON DELETE CASCADE,
        previous_status TEXT NOT NULL CHECK(previous_status IN ('clear', 'warning', 'critical')),
        new_status      TEXT NOT NULL CHECK(new_status IN ('clear', 'warning', 'critical')),
        spend           REAL NOT NULL,
        threshold       REAL NOT NULL,
        at              INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_budget_events_config ON budget_events(config_id);
      CREATE INDEX IF NOT EXISTS idx_budget_events_at ON budget_events(at);
    `,
  },
  {
    // Incremental extraction. Records how far through a session's transcript the
    // extractor has already read, so each run only processes new turns instead
    // of re-reading the whole session on every Stop.
    version: 6,
    up: `
      CREATE TABLE IF NOT EXISTS extraction_state (
        session_key      TEXT PRIMARY KEY,
        project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        last_event_index INTEGER NOT NULL DEFAULT 0,
        last_run_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_extraction_state_project ON extraction_state(project_id);
    `,
  },
  {
    // What the user actually asked for, captured as they ask it.
    //
    // Everything else Nexus knows is inferred after the fact from transcripts.
    // This is the only record of intent in the user's own words, which is what
    // makes it worth checking a request against past decisions before the work
    // starts rather than explaining a collision afterwards.
    //
    // Prompts are the most sensitive thing stored here, so they are filtered for
    // secrets before insertion and never leave the encrypted database.
    version: 7,
    up: `
      CREATE TABLE IF NOT EXISTS prompts (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        session_key TEXT NOT NULL,
        prompt      TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_prompts_project ON prompts(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_prompts_session ON prompts(session_key, created_at DESC);
    `,
  },
];

/** Schema version this build expects. */
export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/**
 * Applied schema version, or 0 on a database that has never been migrated.
 *
 * A pure read: it takes no write lock, so callers on a latency budget can check
 * whether migration is needed before paying for it.
 */
export function getSchemaVersion(db: NexusDb): number {
  try {
    const row = db
      .prepare('SELECT MAX(version) as v FROM schema_version')
      .get() as { v: number | null } | undefined;
    return row?.v ?? 0;
  } catch {
    return 0; // schema_version table does not exist yet
  }
}

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
