# Nexus

> The missing layer between your projects and your AI.

Nexus is a **secure, local-first intelligence layer** that observes, learns, and coordinates across all Claude Code sessions. It builds a cross-project knowledge graph — tracking architectural decisions, code patterns, preferences, and notes — and syncs that context back into your `CLAUDE.md` files automatically.

Everything stays on your machine. No cloud. No telemetry.

---

## Features

- **Decision tracking** — Record architecture, library, pattern, naming, and security decisions per project
- **Pattern extraction** — LLM-powered extraction of recurring code patterns from Claude Code sessions
- **Notes** — Freeform context blocks per project, synced into `CLAUDE.md` and surfaced to every future session
- **Conflict detection** — Detect when projects make contradictory decisions (e.g., two projects using conflicting auth approaches)
- **CLAUDE.md sync** — Automatically writes learned context back into each project's `CLAUDE.md`
- **MCP server** — Expose Nexus tools directly to Claude Code via the Model Context Protocol
- **Desktop app** — Native Tauri v2 desktop application; single `.exe`, system tray, no separate server required
- **Web dashboard** — React/Vite UI with observability, project graph, and activity feed (also runs standalone)
- **Native session viewer** — Browse all Claude Code sessions from `~/.claude/projects/` with inline event timelines, tool call inspection, and aggregate stats — no configuration required
- **Langfuse overlay** — Optional: add Langfuse credentials to unlock LLM cost/token charts, trace trees, and session groupings

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
| Desktop app | Tauri v2 (Rust + WebView) |

---

## Package Structure

```
packages/
  core/       — Shared types, DB layer, security, LLM extraction, CLAUDE.md sync
  cli/        — nexus CLI commands
  mcp/        — MCP server (nexus_* tools exposed to Claude Code)
  server/     — Hono HTTP server at localhost:47340
  dashboard/  — React/Vite web dashboard + Tauri desktop shell
    src-tauri/  — Rust Tauri backend; spawns server sidecar, manages tray
```

**Boundary rules:**
- `core` has zero CLI/MCP/server-specific code — it is the pure logic layer
- `cli` and `mcp` import from `core` only, never each other
- `dashboard` calls the HTTP server at `/api/*` — no direct imports from core

---

## Installation

There are three ways to run Nexus, from easiest to most flexible.

### Option A: Desktop App (pre-built)

Download the latest `.exe` installer from [Releases](https://github.com/MCKRUZ/Nexus/releases) and run it. The app:

1. Spawns the Nexus HTTP server automatically as a background sidecar
2. Opens the dashboard in a native window
3. Hides to the system tray when you close the window (server keeps running)
4. Quit from the tray menu to exit completely

No Node.js, no terminal, no manual setup required.

### Option B: From Source (recommended for contributors)

#### Prerequisites

| Requirement | Why |
|-------------|-----|
| [Node.js 22+](https://nodejs.org/) | Runtime for all packages |
| [pnpm](https://pnpm.io/) | Workspace package manager (`npm install -g pnpm`) |
| C++ build tools | Required by `better-sqlite3` native addon |
| [Rust + Cargo](https://rustup.rs/) | Only needed if building the desktop app (Option C) |

**Windows note:** Install "Desktop development with C++" workload from [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) for the native SQLite compilation.

**macOS:** `xcode-select --install` provides the necessary build tools.

**Linux:** `sudo apt install build-essential python3` (Debian/Ubuntu) or equivalent.

#### Clone and build

```bash
git clone https://github.com/MCKRUZ/Nexus.git
cd Nexus
pnpm install
pnpm build
```

#### Initialize Nexus

```bash
node packages/cli/dist/index.js init
```

The interactive wizard walks you through:

1. **Encryption key** — auto-generated SQLCipher key for your database
2. **LLM provider** — Anthropic (API key or Claude Code OAuth), OpenRouter, or Ollama (local/free)
3. **Langfuse** — optional observability tracing (base URL + keys, with live connection test)
4. **Claude Code integration** — installs MCP server, Stop hook, and session tracking hooks
5. **Memory rule** — drops `nexus-memory.md` into `~/.claude/rules/`
6. **Project registration** — registers the current directory as your first project
7. **Health check** — verifies everything is wired up correctly

This creates `~/.nexus/nexus.db` (encrypted) and `~/.nexus/config.json`.

> **Important:** Back up `~/.nexus/config.json` — it contains your encryption key. Lose it and your database is unrecoverable.

#### Make `nexus` available globally (optional)

```bash
# Link the CLI so you can run "nexus" from anywhere
cd packages/cli && pnpm link --global
```

After linking, use `nexus init`, `nexus sync`, `nexus query`, etc. directly.

#### Restart Claude Code

After init, restart Claude Code so it picks up the new MCP server and hooks.

### Option C: Build the Desktop App from Source

Requires everything from Option B plus Rust/Cargo.

```bash
# Windows (from repo root)
nexus-build.bat

# Or manually:
pnpm build
pnpm --filter @nexus/server compile
pnpm tauri:build
```

The installer lands at `packages/dashboard/src-tauri/target/release/bundle/nsis/Nexus_*-setup.exe`.

---

## Running the Web Dashboard

If you installed from source (Option B), you can run the dashboard without the desktop app:

```bash
# Production mode — serves the built dashboard at localhost:47340
node packages/server/dist/index.js

# Dev mode — Vite hot-reload on :5173, API server on :47340
pnpm -r dev
```

Open [http://localhost:47340](http://localhost:47340) (production) or [http://localhost:5173](http://localhost:5173) (dev).

The server binds to `127.0.0.1` by default. To change the port or bind address:

```bash
node packages/server/dist/index.js --port 8080 --bind 0.0.0.0
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
| `nexus_query` | Full-text search across decisions, patterns, preferences, notes |
| `nexus_decide` | Record an architectural decision |
| `nexus_pattern` | Search code patterns |
| `nexus_record_pattern` | Record a new code pattern |
| `nexus_check_conflicts` | Detect cross-project conflicts |
| `nexus_dependencies` | Query the project dependency graph |
| `nexus_preferences` | Look up or set project/global preferences |
| `nexus_note` | Get, set, list, delete, or search project notes |

---

## Configuration

Config lives at `~/.nexus/config.json`. Created by `nexus init` — you can also edit it directly:

```jsonc
{
  "encryptionKey": "...",           // Auto-generated — DO NOT LOSE

  // LLM provider for extraction (pick one)
  "llmProvider": "anthropic",       // "anthropic" | "openrouter" | "ollama"
  "anthropicApiKey": "sk-ant-...",  // Optional — omit to use Claude Code OAuth
  "anthropicBaseUrl": "...",        // Optional — custom Anthropic endpoint

  "openrouterApiKey": "sk-or-...", // Required if provider is "openrouter"
  "openrouterModel": "anthropic/claude-haiku-4-5",

  "ollamaBaseUrl": "http://localhost:11434",  // Required if provider is "ollama"
  "ollamaModel": "llama3.1:8b",

  // Optional observability
  "langfuse": {
    "baseUrl": "https://your-langfuse-host",
    "publicKey": "pk-lf-...",
    "secretKey": "sk-lf-..."
  }
}
```

### Native Session Observability

The Observability dashboard works out of the box with **no configuration**. Nexus reads Claude Code's JSONL session files directly from `~/.claude/projects/` and surfaces:

- Session list with project, branch, duration, user turns, tool call count
- Inline event timeline per session — text messages, tool calls (expandable with JSON input), and tool results
- Aggregate stats: total sessions, user turns, tool calls, active projects

### Langfuse Integration (optional)

If you run a self-hosted [Langfuse](https://langfuse.com) instance, add credentials to `~/.nexus/config.json` to unlock LLM cost and token data. The Nexus server proxies Langfuse API calls, and the dashboard displays:

- Daily cost and usage metrics
- Full trace list with latency, cost, scores
- Session groupings
- Per-trace observation tree with input/output viewer

---

## Dashboard Pages

| Page | Description |
|------|-------------|
| **Overview** | Stats cards, recent decisions, active conflicts |
| **Projects** | Project list + per-project decisions, patterns, notes, graph |
| **Patterns** | Searchable pattern library with frequency bars |
| **Notes** | Freeform context per project; synced into CLAUDE.md |
| **Conflicts** | Open, potential, and resolved cross-project conflicts |
| **Preferences** | Global and per-project preference editor |
| **Search** | Full-text search across all knowledge |
| **Observability** | Native Claude Code sessions + optional Langfuse traces/cost charts |
| **Settings** | Server bind mode, autostart on login, port display |

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

# Run tests (packages/core)
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

### Build the desktop app

```bash
# Compile server sidecar + Tauri app
cd packages/dashboard
pnpm tauri:build
```

Requires Rust/Cargo. The build runs `pnpm build` (frontend) + `pnpm compile:server` (Node→exe via esbuild + pkg) before invoking Tauri.

---

## Phase Status

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Foundation — DB, CLI, secret filter | ✅ Complete |
| 2 | MCP Server — 8 tools | ✅ Complete |
| 3 | Hooks & LLM extraction | ✅ Complete |
| 4 | CLAUDE.md sync engine | ✅ Complete |
| 5 | HTTP server + React dashboard + Notes | ✅ Complete |
| 6 | Tauri desktop app + sidecar server | ✅ Complete |

---

## License

MIT
