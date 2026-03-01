---
paths: packages/core/**
---

# Core Package Rules

## Zero External Dependencies
- No HTTP clients (no fetch, axios, got, node-fetch)
- No CLI frameworks (no commander, chalk, ora)
- No MCP SDK imports
- Allowed: better-sqlite3, zod, node built-ins

## Security Must-Haves
- `filterSecrets()` before every DB write that involves user content
- SQLCipher key pragma MUST be first pragma after opening DB
- Never expose raw DB handle outside this package — wrap in typed functions

## Exports
- Only export through `src/index.ts`
- Don't export internal implementation details
- Types are part of the public API — treat changes as breaking
