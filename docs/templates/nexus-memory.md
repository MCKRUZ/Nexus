# Nexus — Cross-Project Memory
<!-- Template: install at ~/.claude/rules/nexus-memory.md -->
<!-- Run: nexus install-memory-rule -->

You have multiple memory sources available:
- **Project CLAUDE.md** — current project's instructions and context
- **Global rules** (`~/.claude/rules/`) — conventions, infrastructure, patterns
- **Session memory files** — per-project MEMORY.md with accumulated notes
- **Nexus knowledge graph** — cross-project intelligence: notes, decisions, and patterns across ALL registered projects and sessions

## When to query Nexus

Nexus fills the gaps the other sources don't cover: knowledge that lives *across* projects, references to things discussed in a different project's session, named concepts/documents/systems that aren't defined in the current context.

**Rule:** When the user references something specific that you don't have full context for from your other memory sources — a named document, character, system, feature, concept, or ongoing work — call `nexus_query` BEFORE responding or asking the user to explain.

Do not ask the user "what is X?" or "can you give me more context on X?" — search Nexus first. If the search returns nothing useful, then ask.

## Examples of when to search

- "Update the Sage bible" → `nexus_query("sage bible")`
- "She needs to sound more like herself" → `nexus_query("sage voice personality")`
- "Add a new camera angle to the apartment" → `nexus_query("apartment camera angles")`
- "Continue where we left off on the pipeline" → `nexus_query("prismcast pipeline")`
- "Fix the voice latency issue" → `nexus_query("voice latency")`

Use natural language queries — Nexus does semantic search across notes, decisions, and patterns for all registered projects.
