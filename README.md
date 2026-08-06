# Nexus

**Claude Code forgets everything between sessions. Nexus doesn't.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/MCKRUZ/Nexus?include_prereleases&sort=semver)](https://github.com/MCKRUZ/Nexus/releases)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-blue)](https://github.com/MCKRUZ/Nexus/releases)
[![Local-first](https://img.shields.io/badge/data-stays%20on%20your%20machine-informational)](#security)

---

## The problem

Every Claude Code session starts from nothing. You explain your architecture again.
You re-decide things you already decided. And because each project is its own island,
you can pick JWT auth in one repo on Monday and sessions in another on Thursday
without anything noticing the two now disagree.

The knowledge exists — it's scattered across hundreds of transcripts you'll never reread.

## What Nexus does

Nexus watches your Claude Code sessions, pulls out the decisions and patterns worth
keeping, and puts the important ones back in front of Claude automatically.

- **Remembers decisions across projects.** Architecture, library, naming, and security
  choices are extracted from real sessions — not typed into a form you'll stop maintaining.
- **Notices when you contradict yourself.** Two projects making incompatible choices get
  flagged, with both sides quoted.
- **Questions its own memory.** When a stored decision looks superseded, Nexus asks you
  rather than quietly deleting it. Reject it once and it never asks again.
- **Feeds context back automatically.** A budgeted summary is written into each project's
  `CLAUDE.md`, so every future session starts already knowing.
- **Answers directly.** Claude gets tools (`nexus_query`, `nexus_decide`, and others) to
  search your history mid-conversation.

Everything runs on your machine. The database is encrypted, no data leaves, and there is
no account to create.

---

## Install

### Desktop app

Download for your platform from [**Releases**](https://github.com/MCKRUZ/Nexus/releases):

| Platform | File |
|----------|------|
| Windows | `Nexus_x.y.z_x64-setup.exe` (or the `.msi`) |
| macOS (Apple Silicon) | `Nexus_x.y.z_aarch64.dmg` |
| macOS (Intel) | `Nexus_x.y.z_x64.dmg` |
| Linux | `.AppImage` (portable) or `.deb` (Debian/Ubuntu) |

The app runs its own local server, opens a native window, and lives in your system tray.
No Node.js and no terminal required.

> **The installers are not code-signed.** Signing certificates cost money per platform and
> this is a local-first tool with no company behind it, so your OS will warn you on first
> launch: Windows SmartScreen shows "Windows protected your PC" (*More info* → *Run anyway*),
> and macOS Gatekeeper refuses to open it (right-click the app → *Open*). If you'd rather not
> trust an unsigned binary, build from source below — that's the honest recommendation.

### From source

**Prerequisites**

| Requirement | Why |
|-------------|-----|
| [Node.js 22+](https://nodejs.org/) | Runs every package |
| [pnpm 9+](https://pnpm.io/) | Workspace manager (`npm install -g pnpm`) |
| C++ build tools | Compiles the native SQLite driver |
| [Rust](https://rustup.rs/) | Only if you want the desktop app |

C++ tooling by platform: Windows needs the "Desktop development with C++" workload from
[Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/);
macOS needs `xcode-select --install`; Debian/Ubuntu needs `build-essential python3`.

```bash
git clone https://github.com/MCKRUZ/Nexus.git
cd Nexus
pnpm install
pnpm build
node packages/cli/dist/index.js init
```

`init` walks you through generating an encryption key, choosing an extraction model,
wiring up Claude Code's hooks and MCP server, and registering your first project.
Then restart Claude Code so it picks up the new tools.

To build the desktop app yourself:

```bash
pnpm --filter @nexus/server compile   # server → standalone executable
pnpm tauri:build                      # → src-tauri/target/release/bundle/
```

New to the project? [`docs/GETTING_STARTED.md`](docs/GETTING_STARTED.md) is a five-minute walkthrough.

---

## How it fits together

```
packages/
  core/       — types, encrypted database, extraction, sync    (no CLI/server code)
  cli/        — the `nexus` command
  mcp/        — the nexus_* tools Claude Code calls
  server/     — local HTTP API on 127.0.0.1:47340
  dashboard/  — React UI + Tauri desktop shell
```

`core` is the only place that touches the database. `cli` and `mcp` depend on it and never
on each other. The dashboard talks HTTP, never imports `core` directly.

---

## Using it

Most of Nexus is meant to disappear — sessions get processed by a hook and context arrives
in `CLAUDE.md` on its own. The command line is there when you want to look directly.

```bash
nexus status                  # health and database stats
nexus query <text>            # search everything you've recorded
nexus project add <path>      # start tracking a repo
nexus sync --all              # rewrite every project's CLAUDE.md
nexus db proposals            # review decisions flagged as possibly out of date
nexus doctor                  # diagnose a broken install
```

### Tools Claude can call

| Tool | What it does |
|------|--------------|
| `nexus_query` | Search decisions, patterns, preferences, and notes |
| `nexus_decide` | Record an architectural decision |
| `nexus_pattern` | Search or record a code pattern |
| `nexus_note` | Keep living project context that syncs into `CLAUDE.md` |
| `nexus_check_conflicts` | Find cross-project contradictions |
| `nexus_check_impact` | Trace the blast radius of a proposed change |
| `nexus_dependencies` | Query the cross-project dependency graph |
| `nexus_preferences` | Read and set developer preferences |
| `nexus_supersede` | Accept or reject a flagged stale decision |
| `nexus_budget` | Set spending limits and alerts |

Registering the MCP server by hand, if `init` didn't:

```json
{
  "mcpServers": {
    "nexus": { "command": "node", "args": ["/path/to/Nexus/packages/mcp/dist/index.js"] }
  }
}
```

### The dashboard

The desktop app opens it for you. From source, `node packages/server/dist/index.js` serves it
at [localhost:47340](http://localhost:47340), bound to loopback only. It covers your project
portfolio, a decision graph, the pattern library, conflicts, token budgets, health checks, and
a session browser that reads Claude Code's own transcripts with no configuration at all.

---

## Security

Nexus reads your session transcripts, so the design assumes they contain things you would
not want leaked.

- **The database is encrypted, and that is verified rather than assumed.** Nexus opens
  `~/.nexus/nexus.db` through SQLCipher and refuses to proceed against a plaintext file.
  (Early builds *claimed* encryption while a driver silently ignored the key. `nexus db status`
  reports the truth, and `nexus db encrypt` converts an affected database.)
- **The encryption key lives in your OS credential store**, not next to the data. Copying
  `~/.nexus` to another machine gets you ciphertext and nothing else. Older installs that kept
  the key in `config.json` can move it with `nexus db secure-key`.
- **Third-party credentials are never stored in config files.** Nexus asks a command you
  configure — the same shape as a git credential helper — so keys stay in whatever store your
  machine already has:
  ```jsonc
  { "secretCommand": ["my-secret-tool", "get"] }   // invoked with the secret's name appended
  ```
- **Transcripts are never stored.** Only extracted decisions, patterns, and file paths — and
  everything passes a deliberately over-eager secret filter first, because a false positive
  costs you a redacted string and a miss costs you a leaked key.
- **Nothing phones home.** No telemetry, no accounts, no cloud. The only outbound calls are to
  whichever model provider you configure for extraction — and Ollama keeps even that local.

> **Back up your encryption key.** It is in your OS credential store under `nexus` /
> `db-encryption-key`. Lose it and the database is unrecoverable — there is no reset, by design.

---

## Development

```bash
pnpm build                          # all packages
pnpm --filter @nexus/core test      # the suite that matters
pnpm lint
```

Two integration tests spawn real Node processes instead of running in-process, and they look
redundant until you know why: the test runner supplies a module shim that once hid a bug which
broke every credential lookup in production while the suite stayed green. There is now one such
test per module format. Please don't "simplify" them back.

Contributions are welcome. The house rules are in [`CLAUDE.md`](CLAUDE.md) — the short version
is that encryption, the secret filter, and the local-only boundary are not negotiable.

---

## License

MIT — see [LICENSE](LICENSE).
