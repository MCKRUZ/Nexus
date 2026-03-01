# Project: Nexus

> "The missing layer between your projects and your AI."

A secure, local-first intelligence layer that observes, learns, and coordinates across all Claude Code sessions. Cross-project knowledge graph — never leaves your machine.

## Stack

- **Core/CLI/MCP**: TypeScript, Node.js 20+, pnpm workspaces
- **Database**: SQLite via `better-sqlite3` + SQLCipher (encryption required)
- **CLI**: Commander.js
- **MCP Server**: `@modelcontextprotocol/sdk`
- **Dashboard** (Phase 5+): Tauri v2 (Rust + React/TypeScript)

## Architecture

```
packages/
  core/       — Shared types, DB layer, orchestrator engine
  cli/        — nexus init/project/sync commands
  mcp/        — MCP server exposing nexus_* tools to Claude Code
  dashboard/  — Tauri desktop app (Phase 5)
```

IPC between dashboard and core daemon uses Tauri's IPC (local only, no network).

## Commands

- `pnpm build` — Build all packages
- `pnpm test` — Run all tests
- `pnpm test:unit` — Unit tests only
- `pnpm test:integration` — Integration tests
- `pnpm lint` — ESLint + Prettier check
- `pnpm -r dev` — Dev mode for all packages
- `cd packages/cli && node dist/index.js` — Run CLI locally

## Verification

After changes: `pnpm build && pnpm test`

## Critical Architecture Rules

### Security-first (NON-NEGOTIABLE)
- Database MUST use SQLCipher encryption — never plain SQLite
- Secret filter is conservative: false positives are BETTER than missing secrets
- No cloud dependencies in packages/core, packages/cli, packages/mcp
- Never log file contents, only paths — session transcripts may contain secrets
- Audit log every mutation operation with timestamp + source

### MCP Tool Naming
All MCP tools use the `nexus_` prefix: `nexus_query`, `nexus_decide`, `nexus_pattern`, `nexus_check_conflicts`, `nexus_dependencies`, `nexus_preferences`

### Package Boundaries
- `packages/core` has ZERO CLI/MCP-specific code — it is the pure logic layer
- `packages/cli` and `packages/mcp` import from `packages/core`, never each other
- Dashboard (packages/dashboard) talks to core via Tauri commands, NOT direct import

### SQLCipher Pattern
```typescript
// CORRECT
import Database from 'better-sqlite3';
const db = new Database(dbPath, { /* ... */ });
db.pragma(`key="${encryptionKey}"`);

// WRONG - never open unencrypted
const db = new Database(dbPath);
```

## Task Approach

1. **Ask before implementing cross-package changes** — moving logic between packages is architectural
2. **Phase discipline** — check the current phase before building ahead (see docs/phases.md)
3. **Always run secret filter before logging** — call `filterSecrets(content)` before any write to DB or logs
4. **MCP tools are the external API** — treat them like public API surface, be conservative with changes
5. **Test integration points** — MCP server ↔ core ↔ DB must have integration tests

## Common Mistakes

- **Opening DB without encryption**: Always set `key` pragma immediately after opening
- **Logging session content**: Only log file paths and metadata, never transcript content
- **Skipping secret filter**: Run `filterSecrets()` before any content hits the DB
- **Cross-package imports**: Never import CLI code in MCP package or vice versa
- **Hard-coding project paths**: All paths go through the project registry in core

## Compact Instructions

When compacting, preserve:
- Current phase (1–6) and active task
- Any DB schema decisions made this session
- MCP tool signatures agreed upon
- Secret filter regex patterns added

<!-- nexus:start -->
## Nexus Intelligence

*Auto-updated by Nexus — do not edit this section manually.*
*Last sync: 2026-03-01*

### Recorded Decisions
- **[architecture]** Use pnpm workspaces for monorepo structure
  > Better performance than npm, native workspace linking
- **[library]** Use better-sqlite3 with SQLCipher for encrypted local storage
  > SQLCipher is battle-tested encryption for SQLite

<!-- nexus:end -->
