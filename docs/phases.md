# Nexus Build Phases

Track current phase here. Update when transitioning.

## Current Phase: 5 — Dashboard

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
**Status: NOT STARTED**

- [ ] Tauri app scaffolding (`packages/dashboard/`)
- [ ] Projects overview page
- [ ] Decision graph (D3 force-directed)
- [ ] Activity feed (real-time via IPC)
- [ ] Pattern library
- [ ] Conflict alerts with resolution workflow
- [ ] Session monitor
- [ ] Preferences editor

## Phase 6: Polish & Release (Week 8)
**Status: NOT STARTED**

- [ ] Windows MSI installer (Tauri bundler)
- [ ] First-run wizard
- [ ] Documentation
- [ ] Open source release
