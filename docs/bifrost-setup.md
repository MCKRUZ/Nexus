# Bifrost Setup — Mac Mini (192.168.50.189)

## Overview

Replace mcp-hub + Context Lens with Bifrost as unified LLM proxy + MCP gateway.

```
BEFORE:
  Claude Code (FURIOUS)
    → Context Lens (bablyon:4040) → Anthropic API     [LLM proxy]
    → mcp-hub (local stdio, CodeMode)                  [MCP gateway: 3 meta-tools]
    → nexus-local (local stdio)                         [direct]
    → context-mode (plugin)                             [direct]

AFTER:
  Claude Code (FURIOUS)
    → Bifrost (mac-mini:8090) → Anthropic API           [LLM proxy + cache + observability]
    → Bifrost (mac-mini:8090/mcp)                       [MCP gateway: direct tool filtering]
    → nexus-local (local stdio)                         [direct, unchanged]
    → context-mode (plugin)                             [direct, unchanged]
```

**What this saves:**
- Context Lens removed (Nexus handles token analytics)
- mcp-hub removed (Bifrost replaces with better tool filtering)
- No more CodeMode 3-round-trip overhead per tool call
- Semantic caching on repeated/similar queries
- Per-project tool filtering (fewer tool defs in context)
- Budget controls built into the proxy layer

## Step 1: Deploy Bifrost on Mac Mini

SSH into Mac Mini:
```bash
ssh matthewkruczek@192.168.50.189
```

Create Bifrost directory:
```bash
mkdir -p ~/bifrost && cd ~/bifrost
```

### Option A: npx (Recommended — simplest, MCP stdio works out of the box)

```bash
# Install and run in background via pm2 or screen
npm install -g pm2
npx -y @maximhq/bifrost  # first run to test

# For persistent background:
pm2 start "npx -y @maximhq/bifrost" --name bifrost
pm2 save
pm2 startup  # auto-start on reboot
```

Bifrost runs at `http://localhost:8080`. Since Sage uses 8080, set a custom port:
```bash
BIFROST_PORT=8090 npx -y @maximhq/bifrost
# or configure in config.json
```

### Option B: Docker (if you prefer containers)

Note: The Go-based Docker image may not include Node.js/npx, which stdio MCP
servers need. You'd need to either build a custom image with Node.js or connect
MCP servers via HTTP/SSE transport from separate containers.

```yaml
version: '3.8'
services:
  bifrost:
    image: maximhq/bifrost:latest
    container_name: bifrost
    ports:
      - "8090:8080"
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

### Configure MCP Servers

Open the Bifrost UI at `http://192.168.50.189:8090` and add:

1. **Anthropic provider** — Add your API key (or the key Bifrost will proxy to)
2. **MCP servers** — Add via the UI or `config.json`:

```json
{
  "mcpServers": {
    "github": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}"
      }
    },
    "context7": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp@latest"]
    },
    "sequential-thinking": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
    },
    "firecrawl": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_URL": "https://firecrawl.bablyon.synology.me"
      }
    }
  }
}
```

Verify:
```bash
curl http://localhost:8090/health
# Should return 200
```

## Step 2: Update Claude Code Settings (FURIOUS)

In `~/.claude/settings.json`, make these changes:

### Change ANTHROPIC_BASE_URL
```diff
- "ANTHROPIC_BASE_URL": "http://bablyon:4040",
+ "ANTHROPIC_BASE_URL": "http://192.168.50.189:8090/anthropic",
```

### Replace mcp-hub with Bifrost
```diff
  "mcpServers": {
-   "hub": {
-     "command": "uv",
-     "args": [
-       "--directory",
-       "C:/Users/kruz7/OneDrive/Documents/Code Repos/MCKRUZ/mcp-hub",
-       "run",
-       "fastmcp",
-       "run",
-       "src/mcp_hub/server.py"
-     ],
-     "env": {
-       "GITHUB_PERSONAL_ACCESS_TOKEN": "",
-       "FIRECRAWL_API_URL": "https://firecrawl.bablyon.synology.me"
-     },
-     "description": "CodeMode hub — github, context7, sequential-thinking, firecrawl, chrome-devtools"
-   },
+   "bifrost": {
+     "type": "http",
+     "url": "http://192.168.50.189:8090/mcp",
+     "description": "Bifrost MCP gateway — github, context7, sequential-thinking, firecrawl"
+   },
    "nexus-local": {
      ...unchanged...
    }
  }
```

### Update permissions
```diff
- "mcp__hub__search",
- "mcp__hub__get_schemas",
- "mcp__hub__execute",
+ "mcp__bifrost__*",
```

## Step 3: Stop Context Lens on NAS

Context Lens is no longer needed (Nexus handles token analytics natively).

```bash
ssh Hyriel@bablyon
# Stop the Context Lens container/process
docker stop context-lens  # or however it's running
```

## Step 4: Verify

1. Start a new Claude Code session
2. Check Bifrost dashboard at http://192.168.50.189:8090/logs
3. Verify MCP tools are available: ask Claude to use a GitHub or Context7 tool
4. Verify nexus tools still work: `nexus_query "test"`
5. Verify context-mode still works: run a `ctx_execute`
6. Check that API calls route through Bifrost (visible in dashboard)

## Token Savings Summary

| Change | Savings |
|--------|---------|
| Remove mcp-hub CodeMode overhead | No more 3-round-trip per tool call |
| Bifrost tool filtering | Only project-relevant tools loaded |
| Semantic cache | Repeated similar queries served from cache |
| Shorter nexus descriptions (already done) | ~1,000 tokens/call |
| nexus_pattern consolidation (already done) | ~500 tokens/call |
| Remove Context Lens proxy hop | Slightly lower latency |

## Rollback

If Bifrost doesn't work out:
1. Revert `ANTHROPIC_BASE_URL` to `http://bablyon:4040`
2. Restore mcp-hub config in mcpServers
3. Restart Context Lens on NAS
