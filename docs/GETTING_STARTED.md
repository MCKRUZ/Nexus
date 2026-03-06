# Getting Started with Nexus

> The missing layer between your projects and your AI.

This guide gets you from zero to a running Nexus instance in about 5 minutes.

---

## Prerequisites

- **Node.js 22+** — [nodejs.org](https://nodejs.org)
- **pnpm 9+** — `npm install -g pnpm`
- **Claude Code** — [claude.ai/claude-code](https://claude.ai/claude-code)

---

## 1. Clone and build

```bash
git clone https://github.com/your-org/nexus.git
cd nexus
pnpm install
pnpm build
```

---

## 2. Initialize Nexus

```bash
node packages/cli/dist/index.js init
```

This creates `~/.nexus/` with an encrypted SQLite database and a config file containing your encryption key.

> **Important:** Back up `~/.nexus/config.json`. Without the encryption key inside it, your database cannot be decrypted.

---

## 3. Register your first project

```bash
node packages/cli/dist/index.js project add /path/to/your/project
```

Or register the current directory:

```bash
node packages/cli/dist/index.js project add .
```

---

## 4. Configure the MCP server

Open `~/.claude/settings.json` (create it if it doesn't exist) and add Nexus to the `mcpServers` section:

```json
{
  "mcpServers": {
    "nexus": {
      "command": "node",
      "args": ["/absolute/path/to/nexus/packages/mcp/dist/index.js"]
    }
  }
}
```

Replace `/absolute/path/to/nexus` with the actual path where you cloned the repo.

After saving, restart Claude Code. You should see `nexus_query`, `nexus_note`, `nexus_decide`, and other `nexus_*` tools available.

---

## 5. Configure the post-session hook

This hook runs after each Claude Code session to extract decisions, patterns, and notes automatically.

Add to `~/.claude/settings.json` under `hooks`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/nexus/packages/cli/dist/index.js hook post-session"
          }
        ]
      }
    ]
  }
}
```

---

## 6. Open the dashboard

```bash
node packages/server/dist/index.js
```

Then open [http://localhost:47340](http://localhost:47340) in your browser.

Or use the CLI shortcut:

```bash
node packages/cli/dist/index.js serve
```

The dashboard shows your projects, decisions, patterns, notes, and conflicts across all registered projects.

---

## 7. Install the memory rule (recommended)

This step teaches Claude Code to query Nexus automatically when it encounters unfamiliar references across your projects.

```bash
node packages/cli/dist/index.js install-memory-rule
```

This copies a rule file to `~/.claude/rules/nexus-memory.md`. Restart Claude Code to activate it.

---

## 8. Verify everything is working

```bash
node packages/cli/dist/index.js status
```

You should see:
- Nexus version
- Database path
- Number of registered projects
- MCP server status hint

---

## What's next?

- **Add more projects:** `nexus project add <path>`
- **Record a decision:** `nexus decision add` or use the `nexus_decide` MCP tool in Claude Code
- **Search your knowledge:** `nexus query "my search"` or use `nexus_query` in Claude Code
- **Sync CLAUDE.md files:** `nexus sync --all` (pushes decisions + notes into every project's CLAUDE.md)

See `docs/phases.md` for the full feature list and roadmap.
