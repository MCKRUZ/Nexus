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
- Decisions: 5 max injected, each summary ≤ 80 chars
- Notes: 150 chars own project, 80 chars cross-project
- Principle: CLAUDE.md = headlines. Full detail lives in the DB. Use `nexus query` to surface it.
- Never inject raw content when a title + count achieves the same recall signal

### MCP Tool Naming
All MCP tools use the `nexus_` prefix: `nexus_query`, `nexus_decide`, `nexus_pattern`, `nexus_record_pattern`, `nexus_check_conflicts`, `nexus_dependencies`, `nexus_preferences`, `nexus_note`

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
*Last sync: 2026-03-10*

### Project Context
#### OpenClaw Ollama Fallback & Stop Hook JSON Validation Fix
(1) OpenClaw agent fallback chain requires tool-capable models; dolphin-llama3 doesn't support tools so was removed; llama3.1:8b being pulled as Ollama fallback replacement. (2) Stop hook JSON validation error caused by prompt hooks trying to call MCP tools directly instead of returning evaluator format {ok: true/false, reason: string}. (3) All 7 Stop hooks tested—the two prompt hooks now properly instruct main Claude via reason field instead of attempting MCP calls.
*Tags: openclaw, ollama, hooks, bug-fix*

#### Project Overview
Nexus is a local-first cross-project intelligence layer for Claude Code.
*Tags: context, overview*

### Context from openclaw
#### OpenClaw Ollama Integration & Stop Hook Architecture
(1) OpenClaw uses agent model fallback chains requiring tool-capable models (Claude Opus/Sonnet, llama3.1:8b); (2) Two separate Ollama patterns: OpenClaw agent fallback (requires tools) vs Sage direct NSFW routing via curl (any model); (3) OpenClaw auth-profiles.json has three critical sections (version, profiles, lastGood) - missing lastGood entries cause No API key found errors even when profile exists; (4) Claude Code Stop hooks: prompt-type hooks are single-turn evaluators that cannot call MCP tools - use {ok: false, reason: call mcp__tool} pattern to instruct main Claude instead; (5) llama3.1:8b (4.9GB) downloaded on Furious and configured as Ollama fallback in openclaw.json.

#### Project Overview
**OpenClaw** — a personal AI assistant platform you run on your own devices, answering across channels you already use.

**Stack:** Node.js 22+, npm global install (`npm install -g openclaw@latest`).

**Supported channels:** WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage, Microsoft Teams, WebChat, BlueBubbles, Matrix, Zalo. Voice on macOS/iOS/Android. Live Canvas UI.

**Recommended model:** Anthropic Pro/Max with Claude Opus 4.6 for long-context strength and prompt-injection resistance.

**Key commands:**
- `openclaw onboard --install-daemon` — initial setup
- `openclaw gateway --port 18789 --verbose` — start gateway
- `openclaw agent --message "..." --thinking high` — run agent

**Architecture note:** Personal, single-user assistant. The openclaw directory under openclaw/openclaw is the main repo. Related projects in this portfolio: openclaw-voice (Discord voice bot), openclaw-realism (personhood framework), openclaw-langfuse (observability plugin).
*Tags: overview, typescript, claude, mckruz-project*

### Context from claude-code-langfuse-template
#### Project Overview
**Claude Code + Langfuse Template** — production-ready setup for observing Claude Code sessions using self-hosted Langfuse.

**Stack:** Docker + Docker Compose (Langfuse at localhost:3050), Python 3.11+, Claude Code CLI hooks.

**What it captures:** Every Claude Code conversation — prompts, responses, tool calls, session grouping, incremental state management.

**Setup:** `docker compose up -d` → install hook via `./scripts/install-hook.sh` → sessions appear in Langfuse dashboard.

**Requirements:** Docker, Python 3.11+, Claude Code CLI, 4-6GB RAM.

**Note:** Template/reference project. The portfolio also has openclaw-langfuse (for OpenClaw observability) and the Nexus project itself integrates with Langfuse via ~/.nexus/config.json.
*Tags: overview, claude, typescript*

### Context from openclaw-langfuse
#### Project Overview
**openclaw-langfuse** — OpenClaw plugin for sending agent traces to Langfuse for LLM observability.

**Stack:** Node.js, no npm packages — uses Langfuse REST API directly via native `fetch`. No Docker rebuild needed — drop into workspace volume and restart.

**What it records per turn:**
- Trace name: `openclaw-turn`
- Session ID, User ID (agent ID), Tags, Input/Output, Token usage, Duration

**Install:** Copy plugin to `.openclaw/extensions/` in workspace volume and restart.

**Compatibility:** Works with self-hosted Langfuse (bablyon NAS: langfuse.bablyon.synology.me) and Langfuse Cloud.

**Note:** Nexus also integrates Langfuse via config.json for cross-project intelligence tracing.
*Tags: overview, mckruz-project, typescript*

### Context from DotNetSkills
#### Project Overview
**DotNetSkills / Skills Executor** — .NET orchestrator for executing Anthropic-style SKILL.md files with Azure OpenAI and MCP tool support.

**Stack:** C#/.NET, Azure OpenAI (function calling), MCP client.

**What it does:**
1. Parses SKILL.md files (YAML frontmatter + Markdown body)
2. Connects to MCP servers as a client to discover and execute tools
3. Orchestrates Azure OpenAI calls in an agentic loop
4. Bridges Azure OpenAI tool calls → MCP server execution

**Project structure:** SkillsCore (shared: ISkillLoader, SkillLoaderService), SkillsQuickstart (main orchestrator with skills/ directory).

**Included skills:** code-explainer, project-analyzer, github-assistant.

**Relationship to portfolio:** Demonstrates the same skills-first pattern used in AI-SDLC and Microsoft-Agent-Skills-POC but in a minimal, standalone .NET form.
*Tags: overview, dotnet, claude*

### Recorded Decisions
- **[architecture]** Use pnpm workspaces for monorepo structure
  > Better performance than npm, native workspace linking
- **[library]** Use better-sqlite3 with SQLCipher for encrypted local storage
  > SQLCipher is battle-tested encryption for SQLite

<!-- nexus:end -->
