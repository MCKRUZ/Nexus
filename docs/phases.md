# Nexus Build Phases

Track current phase here. Update when transitioning.

## Current Phase: 6 — Polish & Release

---

## Phase 1: Foundation (Week 1–2)
**Status: COMPLETE** ✓

- [x] SQLCipher database with full schema (`packages/core/src/db/`)
- [x] CLI skeleton with Commander.js (`packages/cli/`)
- [x] `nexus init` — project registration, hook installation, MCP config
- [x] `nexus project add/list/remove/show`
- [x] Secret filter (regex-based, conservative) (`packages/core/src/security/`)
- [x] Basic audit logging

## Phase 2: MCP Server (Week 2–3)
**Status: COMPLETE** ✓

- [x] MCP server with all 6 tools wired to core (`packages/mcp/`)
- [x] `nexus_query` — full-text search across graph
- [x] `nexus_decide` — decision recording
- [x] `nexus_pattern` — pattern search
- [x] `nexus_check_conflicts` — conflict detection
- [x] `nexus_dependencies` — project relationship graph
- [x] `nexus_preferences` — preference lookup

## Phase 3: Hooks & Extraction (Week 3–4)
**Status: COMPLETE** ✓

- [x] Post-command hook handler (`nexus hook post-session`)
- [x] LLM-powered decision extraction from session transcripts
- [x] Preference extraction
- [x] Conflict detection engine (LLM-powered)
- [x] Pattern extraction (batch)

## Phase 4: CLAUDE.md Sync (Week 4)
**Status: COMPLETE** ✓

- [x] Sync engine (`packages/core/src/sync/claude-md-sync.ts`)
- [x] Merge logic: decisions + patterns + preferences + conflicts
- [x] Diff-based updates (only change what's changed)
- [x] Sync on demand (`nexus sync`) + sync all (`nexus sync --all`)

## Phase 5: Dashboard (Week 5–7)
**Status: COMPLETE** ✓

- [x] Hono HTTP server at `localhost:47340` (`packages/server/`)
- [x] Full REST API: stats, projects, decisions, patterns, preferences, conflicts, query
- [x] React 18 + Vite dashboard (`packages/dashboard/`)
- [x] Overview page — stats cards, recent decisions, active conflicts
- [x] Projects page — list + per-project decisions & patterns detail
- [x] Decision graph — D3 force-directed visualization
- [x] Patterns library — searchable, frequency bars
- [x] Conflicts page — open/potential/resolved with refresh
- [x] Preferences editor — list + set new preferences
- [x] Global search — full-text across decisions, patterns, preferences
- [x] Server status indicator in sidebar
- [x] Proxy `/api` → `localhost:47340` in Vite dev server

## Phase 6: Polish & Release (Week 8)
**Status: IN PROGRESS**

### Generic Usability
- [x] Fix machine-specific references in JSDoc (`bablyon` → generic proxy example)
- [x] Add `docs/templates/nexus-memory.md` — installable cross-project memory rule
- [x] Add `nexus install-memory-rule` CLI command
- [x] Post-`nexus init` suggestion to run `nexus install-memory-rule`
- [x] Port collision detection: clear EADDRINUSE message + `--port` hint
- [x] `bindAddress` option on server (default `127.0.0.1`, toggleable to `0.0.0.0`)
- [x] Fix CLAUDE.md Tauri phase reference (Phase 5 = Hono/React, Phase 6 = Tauri)
- [x] `docs/GETTING_STARTED.md` — 5-minute onboarding walkthrough

### Tauri Desktop App
- [x] `packages/dashboard/src-tauri/` — Rust/Tauri v2 shell
- [x] System tray (Open Nexus / Quit)
- [x] Spawn Hono server as sidecar on startup
- [x] `tauri:dev` + `tauri:build` scripts in dashboard + root workspace
- [x] Vite config updated for Tauri build targets
- [x] Settings page (launch-at-login, theme, server mode, Claude root)

### Open Source Release
- [ ] Windows MSI installer (Tauri bundler)
- [ ] macOS DMG (Tauri bundler)
- [ ] Linux .deb + .AppImage (Tauri bundler)
- [ ] README overhaul with install badges
