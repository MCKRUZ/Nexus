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
*Last sync: 2026-03-13*

### Portfolio
| Project | Description | Tech |
|---------|------------|------|
| code | Pinokio plugin — a VS Code-like code editor plugin running inside the Pinokio A… | — |
| app | **Qwen3-TTS** — a Gradio web UI for Alibaba's Qwen3-TTS text-to-speech models, … | — |
| kohya_ss | **Kohya's GUI** — the standard GUI/CLI for training Stable Diffusion models inc… | — |
| ComfyUI | **ComfyUI** — the main local ComfyUI installation at E:/ComfyUI-Easy-Install/Co… | — |
| openclaw | **OpenClaw** — a personal AI assistant platform you run on your own devices, an… | — |
| eShopLite | **eShopLite** — Microsoft reference .NET application implementing an eCommerce … | — |
| agent-framework | **Microsoft Agent Framework** — comprehensive multi-language framework for buil… | — |
| Agent365-dotnet | **Microsoft Agent 365 SDK** — C#/.NET SDK that extends the Microsoft 365 Agents… | — |
| firecrawl | **Firecrawl** — a web scraper API that takes URLs, crawls them, and converts co… | — |
| ai-toolkit | **AI Toolkit by Ostris** — all-in-one training suite for diffusion models (imag… | — |
| musubi-tuner | **Musubi Tuner** — LoRA training scripts for modern video and image diffusion a… | — |
| ComfyUI-Qwen-TTS | **ComfyUI-Qwen-TTS** — ComfyUI custom nodes for speech synthesis using Alibaba'… | — |
| claude-code-langfuse-template | **Claude Code + Langfuse Template** — production-ready setup for observing Clau… | — |
| fluxgym | **Flux Gym** — simple web UI for training FLUX LoRAs with low VRAM support (12G… | — |
| everything-claude-code | **Everything Claude Code** — complete collection of Claude Code configs from an… | — |
| awesome-claude-skills | **Awesome Claude Skills** — curated list of practical Claude Skills for Claude.… | — |
| clawd | **clawd** — local installation of the Claude Code CLI tool at C:/Users/kruz7/cl… | — |
| sage-voice | **sage-voice** — MCKRUZ project for Sage's voice capabilities.

Sage is the AI … | — |
| sage-voice-bridge | **sage-voice-bridge** — bridge service connecting Sage's voice system to the br… | — |
| openclaw-voice | **OpenClaw Voice** — Discord voice bot enabling AI agents (Jarvis and Sage) to … | — |
| openclaw-realism | **OpenClaw Realism** — framework/blueprint for making OpenClaw agents feel like… | — |
| openclaw-langfuse | **openclaw-langfuse** — OpenClaw plugin for sending agent traces to Langfuse fo… | — |
| matthewkruczek-ai | **matthewkruczek.ai** — static personal brand website for Matthew Kruczek (EY M… | — |
| jarvis-voice-bridge | **jarvis-voice-bridge** — bridge service for Jarvis agent's voice integration.
… | — |
| github-agentic-workflows-poc | **GitHub Agentic Workflows POC** — proof-of-concept for GitHub's Agentic Workfl… | — |
| claude-code-mastery | **Claude Code Mastery** — the definitive Claude Code setup and configuration sk… | — |
| TeamsBuddy | **TeamsBuddy** — real-time Microsoft Teams meeting transcript monitor with AI-p… | — |
| SocialMedia | **SocialMedia** — MCKRUZ social media project.

No documentation files found in… | — |
| ProjectPrism | **Prismcast / ProjectPrism** — autonomous AI news aggregation, synthesis, and v… | — |
| Microsoft-Agent-Skills-POC | **Microsoft Agent Skills POC** — proof-of-concept for building Agent Skills for… | — |
| DotNetSkills | **DotNetSkills / Skills Executor** — .NET orchestrator for executing Anthropic-… | — |
| ComfyUI Expert | **VideoAgent / ComfyUI Expert** — session-scoped Claude Code orchestrator that … | — |
| CodeReviewAssistant | **CodeReviewAssistant** — MCP server for capturing, analyzing, and documenting … | — |
| ArchitectureHelper | **AzureCraft / ArchitectureHelper** — AI-native Azure infrastructure designer f… | — |
| AI-SDLC | **AI-PDLC Platform** — multi-offering system for AI-assisted consulting and sof… | — |
| **Nexus** (this) | Nexus is a local-first cross-project intelligence layer for Claude Code. | — |

### Project Context
#### OpenClaw Ollama Fallback & Stop Hook JSON Validation Fix
(1) OpenClaw agent fallback chain requires tool-capable models; dolphin-llama3 doesn't support tools so was removed; llama3.1:8b being pulled as Olla…
*Tags: openclaw, ollama, hooks, bug-fix*

### Recorded Decisions
- **[security]** Add database-level CHECK constraints on tier and severity enum columns
  > Enforce valid values at storage layer to prevent invalid state propagation
- **[security]** Add dismissal tracking via `dismissAdvisory(db, id, source)` setting resolved_a…
  > Allows users to dismiss non-actionable advisories while preserving dismissal history (source/timestamp) for debugging false positive patterns and improving LLM prompt calibration.
- **[security]** Validate project relationships through explicit parent/child/sibling/tag links …
  > Reduces attack surface and prevents spurious detections by scoping comparison scope to semantically related projects only
- **[security]** Add severity field to Conflict type for prioritized display of architecture vio…
  > Enables filtering/sorting by impact level; distinguishes critical issues from minor inconsistencies in UI display
- **[security]** Use taskkill /F for forceful process termination without waiting for graceful s…
  > Installer must ensure clean file access; graceful shutdown unnecessary for pre-install cleanup

> **Cross-project rule**: Before making decisions that affect shared concerns (APIs, auth, data formats, deployment), run `nexus_query` to check for existing decisions and conflicts across the portfolio.

*[Nexus: run `nexus query` to search full knowledge base]*
<!-- nexus:end -->
