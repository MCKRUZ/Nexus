---
paths: packages/dashboard/**
---

# Dashboard Package Rules (Phase 5+)

## Tauri IPC Only
- Dashboard communicates with core exclusively via Tauri commands (invoke)
- Never import `@nexus/core` directly in the frontend TypeScript
- No direct SQLite access from the frontend

## Local Only
- No external API calls from the Rust backend
- No telemetry, no analytics, no cloud sync
- All data stays in `~/.nexus/`

## React Conventions
- Immutable state (never mutate objects — use spread or Immer)
- No prop drilling past 2 levels — use context or Zustand
- D3 visualizations isolated in their own components
