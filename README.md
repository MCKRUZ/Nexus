# Nexus

> The missing layer between your projects and your AI.

Nexus is a **secure, local-first intelligence layer** that observes, learns, and coordinates across all Claude Code sessions. It builds a cross-project knowledge graph — tracking architectural decisions, code patterns, preferences, and conflicts — and syncs that context back into your `CLAUDE.md` files automatically.

Everything stays on your machine. No cloud. No telemetry.

---

## Features

- **Decision tracking** — Record architecture, library, pattern, naming, and security decisions per project
- **Pattern extraction** — LLM-powered extraction of recurring code patterns from Claude Code sessions
- **Conflict detection** — Detect when projects make contradictory decisions (e.g., two projects using conflicting auth approaches)
- **CLAUDE.md sync** — Automatically writes learned context back into each project's `CLAUDE.md`
- **MCP server** — Expose Nexus tools directly to Claude Code via the Model Context Protocol
- **Dashboard** — React/Vite web UI with observability, project graph, and Langfuse integration
- **Langfuse proxy** — Route Langfuse LLM observability through the Nexus server for unified access

---

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 22+, TypeScript |
| Package manager | pnpm workspaces |
| Database | SQLite via `better-sqlite3` + SQLCipher (encrypted) |
| CLI | Commander.js |
| MCP | `@modelcontextprotocol/sdk` |
| LLM extraction | `@anthropic-ai/sdk` (claude-haiku-4-5) |
| HTTP server | Hono |
| Dashboard | React 18 + Vite |

---

## Package Structure

```
packages/
  core/       — Shared types, DB layer, security, LLM extraction, CLAUDE.md sync
  cli/        — nexus CLI commands
  mcp/        — MCP server (nexus_* tools exposed to Claude Code)
  server/     — Hono HTTP server at localhost:47340
  dashboard/  — React/Vite web dashboard
```

**Boundary rules:**
- `core` has zero CLI/MCP/server-specific code — it is the pure logic layer
- `cli` and `mcp` import from `core` only, never each other
- `dashboard` calls the HTTP server at `/api/*` — no direct imports from core

---

## Setup

### Prerequisites

- Node.js 22+
- pnpm (`npm install -g pnpm`)

### Install

```bash
git clone <this-repo>
cd Nexus
pnpm install
pnpm build
```

### Initialize

```bash
# Run once to create ~/.nexus/ and register your first project
node packages/cli/dist/index.js init

# Or if you've linked the CLI globally:
nexus init
```

This creates `~/.nexus/nexus.db` (SQLCipher-encrypted) and `~/.nexus/config.json`.

---

## Running the Server

The dashboard requires the Nexus HTTP server at `localhost:47340`.

```bash
# Start the server (auto-serves the built dashboard)
node packages/server/dist/index.js

# Or in dev mode (Vite proxy → server)
pnpm -r dev
```

Then open `http://localhost:5173` (Vite dev) or `http://localhost:47340` (production build).

To build the dashboard for production:

```bash
pnpm build
# Dashboard output: packages/dashboard/dist/
# Server serves it automatically from ./packages/dashboard/dist
```

---

## CLI Commands

```bash
# Initialize Nexus (first time setup)
nexus init

# Project management
nexus project add <path>          # Register a project
nexus project list                # List all registered projects
nexus project show <id|name>      # Show project details
nexus project remove <id|name>    # Unregister a project

# Decisions
nexus decision add                # Record an architectural decision
nexus decision list [project]     # List decisions

# Search
nexus query <text>                # Full-text search across all knowledge

# CLAUDE.md sync
nexus sync                        # Sync current project's CLAUDE.md
nexus sync --all                  # Sync all registered projects

# Hook integration
nexus hook post-session           # Process a completed Claude Code session
                                  # (pipe session transcript via stdin)

# Status
nexus status                      # Show Nexus health + DB stats
```

---

## MCP Server

Add Nexus to your Claude Code MCP configuration to give Claude direct access to the knowledge graph:

```json
{
  "mcpServers": {
    "nexus": {
      "command": "node",
      "args": ["/path/to/Nexus/packages/mcp/dist/index.js"]
    }
  }
}
```

Available MCP tools:

| Tool | Description |
|------|-------------|
| `nexus_query` | Full-text search across decisions, patterns, preferences |
| `nexus_decide` | Record an architectural decision |
| `nexus_pattern` | Search or record code patterns |
| `nexus_check_conflicts` | Detect cross-project conflicts |
| `nexus_dependencies` | Query the project dependency graph |
| `nexus_preferences` | Look up project or global preferences |

---

## Configuration

Config lives at `~/.nexus/config.json`:

```json
{
  "encryptionKey": "...",
  "langfuse": {
    "baseUrl": "https://your-langfuse-host",
    "publicKey": "pk-lf-...",
    "secretKey": "sk-lf-..."
  }
}
```

### Langfuse Integration

If you run a self-hosted [Langfuse](https://langfuse.com) instance, add the credentials above. The Nexus server proxies all Langfuse API calls through `/api/langfuse/*`, which the dashboard uses to display:

- Daily cost and usage metrics
- Full trace list with latency, cost, scores
- Session groupings
- Per-trace observation tree with input/output viewer
- Scores and metadata

---

## Dashboard Pages

| Page | Description |
|------|-------------|
| **Overview** | Stats cards, recent decisions, active conflicts |
| **Projects** | Project list + per-project decisions, patterns, graph |
| **Patterns** | Searchable pattern library with frequency bars |
| **Conflicts** | Open, potential, and resolved cross-project conflicts |
| **Preferences** | Global and per-project preference editor |
| **Search** | Full-text search across all knowledge |
| **Observability** | Langfuse LLM traces, sessions, observations, cost charts |

---

## Security

- Database is **always** SQLCipher-encrypted — `~/.nexus/nexus.db` is never plain SQLite
- Secret filter runs on all content before it touches the DB — false positives preferred over leaks
- Session transcripts are never stored — only extracted metadata (decisions, patterns, paths)
- No network calls from `core`, `cli`, or `mcp` except the configured Anthropic API for extraction

---

## Development

```bash
# Build all packages
pnpm build

# Run tests (packages/core — 36 tests)
cd packages/core && pnpm test

# Lint
pnpm lint

# Dev mode (all packages with watch)
pnpm -r dev
```

### Build a specific package

```bash
pnpm --filter @nexus/core build
pnpm --filter @nexus/server build
pnpm --filter @nexus/dashboard build
```

---

## Phase Status

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Foundation — DB, CLI, secret filter | ✅ Complete |
| 2 | MCP Server — all 6 tools | ✅ Complete |
| 3 | Hooks & LLM extraction | ✅ Complete |
| 4 | CLAUDE.md sync engine | ✅ Complete |
| 5 | HTTP server + React dashboard | ✅ Complete |
| 6 | Polish & release | 🔲 Not started |

---

## License

Private — not yet open source. Phase 6 includes the open source release.
