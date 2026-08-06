# Project: Nexus

> "The missing layer between your projects and your AI."
> Right-size intelligence — surface what matters, compress everything else.

A secure, local-first intelligence layer that observes, learns, and coordinates across all Claude Code sessions. Cross-project knowledge graph — never leaves your machine.

## Stack

- **Core/CLI/MCP**: TypeScript, Node.js 20+, pnpm workspaces
- **Database**: SQLite via `better-sqlite3` + SQLCipher (encryption required)
- **CLI**: Commander.js
- **MCP Server**: `@modelcontextprotocol/sdk`
- **Dashboard** (Phase 5): React 18 + Vite + Hono server
- **Desktop app** (Phase 6): Tauri v2 wrapper (Rust + native shell)

## Architecture

```
packages/
  core/       — Shared types, DB layer, orchestrator engine
  cli/        — nexus init/project/sync commands
  mcp/        — MCP server exposing nexus_* tools to Claude Code
  dashboard/  — React/Vite frontend + Tauri desktop shell (Phase 6)
```

In Phase 6, Tauri wraps the existing React dashboard: Tauri spawns the Hono server as a child process, then loads it in a native WebView window.

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

### Token Budget (NON-NEGOTIABLE)
- CLAUDE.md Nexus section: hard cap **1,500 tokens** (6,000 chars) — enforced in `generateSection()`
- Structure: Portfolio map → Own-project notes → Decisions → Active conflicts → Behavioral rule
- Portfolio map: one line per project, description ≤ 80 chars from "Project Overview" note
- Decisions: 5 max injected, each summary ≤ 80 chars
- Own-project notes: 150 chars (excludes "Project Overview" — already in portfolio map)
- Behavioral rule: teaches Claude to run `nexus_query` before cross-project decisions
- Principle: CLAUDE.md = headlines. Full detail lives in the DB. Use `nexus query` to surface it.

### MCP Tool Naming
All MCP tools use the `nexus_` prefix: `nexus_query`, `nexus_decide`, `nexus_pattern`, `nexus_check_conflicts`, `nexus_dependencies`, `nexus_preferences`, `nexus_note`
Note: `nexus_pattern` has `action: "search" | "record"` (consolidated from former `nexus_record_pattern`)

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

## Active Knowledge Recording

Call `nexus_note` (action=set) **proactively during sessions** when you encounter:
- **Project identity**: what the project is, who it's for, what problem it solves
- **Key entities**: characters, systems, APIs, or concepts central to this project
- **Cross-project relationships**: how this project connects to other registered projects
- **Domain context**: anything future sessions should load to be immediately productive

Use descriptive titles: `"Project Overview"`, `"Key Entities"`, `"[Feature] Architecture"`.

Notes are persisted to the DB and synced into CLAUDE.md at the next `nexus sync` or Stop hook — every future session on this project (and related child/sibling projects) loads them automatically.

```
# Example — write this when you first understand what a project does:
nexus_note action=set title="Project Overview" content="Nexus is a local-first..."
```

Notes are **not a log** — they're living documents. Update an existing note by calling `set` with the same title.

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
*Last sync: 2026-08-06*

### Portfolio
| Project | Description | Tech |
|---------|------------|------|
| ai-video-producer | — | — |
| personal-brand-assistant | — | — |
| project-avatar | — | — |
| matthewkruczek-ai | **matthewkruczek.ai** — static personal brand website for Matthew Kruczek (EY M… | — |
| **Nexus** (this) | Nexus is a local-first cross-project intelligence layer for Claude Code. | — |
| _+36 inactive_ | — | — |

### Project Context
#### Roadmap: Next Features
User-approved feature ideas (2026-03-24):

1. **MCP Tool Intelligence Layer** — Nexus sits on mcp-hub, learns which tools succeed/fail per project, i…
*Tags: roadmap, features, mcp-hub, planning*

#### Backlog: Show all active MCP servers in Claude Config tab
The Claude Config dashboard page only shows MCP servers from settings.json/settings.local.json, not the full set of running servers (plugins + projec…
*Tags: backlog, dashboard, mcp, claude-config*

#### Token Budget Optimization Session - 2026-03-18
## Token Budget Optimizations Applied

### 1. Portfolio Table Filter (claude-md-sync.ts)
- Before: All 35+ projects listed in every CLAUDE.md sync (~…
*Tags: token-budget, skills, portfolio, optimization*

#### Session Insights - 2026-03-17
## Session Insights - 2026-03-17

**Scope:** 20 sessions, ~1 month, 670 total messages, 33.5 avg msgs/session

### Top Projects
1. **OpenClaw** — 5 s…
*Tags: insights, sessions, analytics*

#### OpenClaw Ollama Fallback & Stop Hook JSON Validation Fix
(1) OpenClaw agent fallback chain requires tool-capable models; dolphin-llama3 doesn't support tools so was removed; llama3.1:8b being pulled as Olla…
*Tags: openclaw, ollama, hooks, bug-fix*

### Context from openclaw
#### OpenClaw Ollama Integration & Stop Hook Architecture
(1) OpenClaw uses agent model fallback chains requiring tool-capable models (Claude Opus/Sonnet, llama3.1:8b); (2) Two separate Ollama patterns: Open…

### Recorded Decisions
- **[security]** Verify vault write operations by immediately reading them back before removing …
  > Confirmed stored credentials were actually persisted to vault before deleting .pre-vault-bak file, preventing data loss from silent write failures.
- **[security]** Use project-prefixed naming convention for vault credentials (e.g., NEXUS_LANGF…
  > Existing LANGFUSE_SECRET_KEY in vault is used by hermes-agent and claude-code-mastery pointing to different Langfuse instance. Nexus has separate Synology instance credentials requiring distinct names to prevent breaking dependent projects.
- **[security]** Never expose secrets through shell argument printing; compare sensitive values …
  > PowerShell error messages printed plaintext secrets when command failed; must compare within Node to avoid accidental exposure through error paths
- **[security]** Database must verify encryption on every open by checking file header, decrypta…
  > Previous implementation silently succeeded without confirming encryption actually worked (SQLite ignores unknown pragmas). Health checks only verified queryability, not secrecy. Now the system fails open—refusing to open if encryption proof fails—rather than silently degrading.
- **[security]** Store database encryption key in Windows Credential Manager instead of plaintex…
  > Encryption at rest was ineffective with key in plaintext next to database. Credential Manager is in-process, available on Windows, and avoids 500ms+ round-trips through PowerShell/devsecrets. Allows secure separation of key and encrypted artifact.

### Active Conflicts
- [medium] personal-brand-assistant stores OAuth credentials in both DevSecrets PowerShell vault and .env files with vault as primary source of truth, while Nexus explicitly plans to migrate away from plaintext config.json to OS credential store—shared deployment infrastructure will have conflicting credential management strategies.
- [medium] jarvis-stack explicitly excludes Anthropic models (Google Gemini + OpenAI GPT only via OpenRouter) while Nexus assumes Claude integration via MCP for cross-project decision sync—if jarvis-stack consumes Nexus decisions via MCP, routing Claude outputs through OpenRouter creates vendor lock-in against stated goals.
- [high] jarvis-stack eliminates Anthropic models entirely (Google Gemini + OpenAI GPT only) via OpenRouter, but Nexus and other projects use Claude MCP tools and session-based decision persistence—switching jarvis-stack to non-Anthropic models breaks Claude-integrated workflows in shared MCP ecosystem.
- [high] claude-code-mastery's MCP gateway (Bifrost at 192.168.50.189:8090) and Nexus's MCP tool naming convention (nexus_query, nexus_note, nexus_decide) require coordinated registration in the same Claude settings—conflicting MCP server registrations or duplicate tool names will cause routing failures.

> **Cross-project rule**: Before making decisions that affect shared concerns (APIs, auth, data formats, deployment) or asking the user for server/SSH/infrastructure details, run `nexus_query` to check for existing decisions, notes, and conflicts across the portfolio.
> When the user says "save to nexus" or you learn something worth preserving across sessions (project identity, key entities, architecture decisions, cross-project relationships), call `nexus_note` with `action: "set"` and a descriptive `title`.

*[Nexus: `nexus_query` to search | `nexus_note` to save | `nexus_decide` to record decisions]*
<!-- nexus:end -->
