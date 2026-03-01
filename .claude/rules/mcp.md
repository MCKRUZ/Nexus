---
paths: packages/mcp/**
---

# MCP Package Rules

## Tool Conventions
- All tools MUST use the `nexus_` prefix
- Input schemas validated with Zod — never skip validation
- All tools must return `{ content: [{ type: 'text', text: ... }] }`
- Error responses: `{ content: [...], isError: true }`

## Dependencies
- `packages/mcp` imports from `@nexus/core` only
- Never import from `@nexus/cli`
- Never import external HTTP clients

## Testing
- Every tool must have a unit test for its input schema validation
- Integration tests must use an in-memory SQLite DB (not production path)
