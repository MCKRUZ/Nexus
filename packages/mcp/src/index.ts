#!/usr/bin/env node
/**
 * Nexus MCP Server — Phase 2
 *
 * All 6 nexus_* tools are wired to @nexus/core via NexusService.
 * The server opens/closes the DB per request to avoid holding it open
 * across long idle periods.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { NexusService, isInitialized } from '@nexus/core';

const server = new McpServer({
  name: 'nexus',
  version: '0.1.0',
  description: 'Cross-project intelligence layer for Claude Code',
});

function withService<T>(fn: (svc: NexusService) => T): T {
  if (!isInitialized()) {
    throw new Error('Nexus is not initialized. Run `nexus init` in a terminal first.');
  }
  const svc = NexusService.open();
  try {
    return fn(svc);
  } finally {
    svc.close();
  }
}

// ─── nexus_query ─────────────────────────────────────────────────────────────

server.tool(
  'nexus_query',
  'Full-text search across the Nexus knowledge graph (decisions, patterns, preferences). Use this to look up architectural decisions made across projects, patterns, or preferences before making new choices.',
  {
    query: z.string().describe('Search query — keywords, technology names, or topic'),
    projectId: z.string().uuid().optional().describe('Scope to a specific project (omit for all projects)'),
    kinds: z
      .array(z.enum(['decision', 'pattern', 'preference']))
      .optional()
      .describe('Filter by record types (default: all)'),
    limit: z.number().int().min(1).max(50).default(10).describe('Max results per type'),
  },
  async ({ query, projectId, kinds, limit }) => {
    const results = withService((svc) =>
      svc.query({
        query,
        ...(projectId ? { projectId } : {}),
        ...(kinds ? { kinds } : {}),
        limit,
      }),
    );

    const total = results.decisions.length + results.patterns.length + results.preferences.length;
    if (total === 0) {
      return { content: [{ type: 'text', text: `No results found for "${query}".` }] };
    }

    const lines: string[] = [`Found ${total} results for "${query}":\n`];

    if (results.decisions.length > 0) {
      lines.push(`## Decisions (${results.decisions.length})`);
      for (const d of results.decisions) {
        lines.push(`- **[${d.kind}]** ${d.summary}`);
        if (d.rationale) lines.push(`  *Rationale:* ${d.rationale}`);
        lines.push(`  Project: ${d.projectId} | ${new Date(d.recordedAt).toLocaleDateString()}`);
      }
      lines.push('');
    }

    if (results.patterns.length > 0) {
      lines.push(`## Patterns (${results.patterns.length})`);
      for (const p of results.patterns) {
        lines.push(`- **${p.name}** (seen ×${p.frequency})`);
        lines.push(`  ${p.description}`);
        if (p.examplePath) lines.push(`  Example: \`${p.examplePath}\``);
      }
      lines.push('');
    }

    if (results.preferences.length > 0) {
      lines.push(`## Preferences (${results.preferences.length})`);
      for (const pref of results.preferences) {
        const scope = pref.scope === 'project' ? `(project)` : '(global)';
        lines.push(`- \`${pref.key}\` = ${pref.value} ${scope}`);
      }
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

// ─── nexus_decide ─────────────────────────────────────────────────────────────

server.tool(
  'nexus_decide',
  'Record an architectural decision made during this Claude Code session. Call this when you and the user agree on a significant technical choice (library selection, architecture pattern, naming convention, etc.).',
  {
    projectPath: z.string().describe('Absolute path to the project directory (use process.cwd() if unsure)'),
    kind: z.enum(['architecture', 'library', 'pattern', 'naming', 'security', 'other']).describe('Type of decision'),
    summary: z.string().max(500).describe('One-sentence summary of the decision (e.g., "Use Zod for all input validation")'),
    rationale: z.string().optional().describe('Why this decision was made — context for future sessions'),
    sessionId: z.string().optional().describe('Current Claude session ID if available'),
  },
  async ({ projectPath, kind, summary, rationale, sessionId }) => {
    const result = withService((svc) => {
      const project = svc.getProjectByPath(projectPath);
      if (!project) {
        return { error: `No Nexus project registered at "${projectPath}". Run \`nexus project add ${projectPath}\` to register it.` };
      }

      const decision = svc.recordDecision({
        projectId: project.id,
        kind,
        summary,
        ...(rationale ? { rationale } : {}),
        ...(sessionId ? { sessionId } : {}),
      }, 'mcp');

      return { decision, projectName: project.name };
    });

    if ('error' in result) {
      return { content: [{ type: 'text', text: result.error }], isError: true };
    }

    return {
      content: [
        {
          type: 'text',
          text: [
            `✓ Decision recorded for project **${result.projectName}**:`,
            ``,
            `- **Kind:** ${result.decision.kind}`,
            `- **Decision:** ${result.decision.summary}`,
            result.decision.rationale ? `- **Rationale:** ${result.decision.rationale}` : null,
            `- **ID:** ${result.decision.id}`,
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    };
  },
);

// ─── nexus_pattern ────────────────────────────────────────────────────────────

server.tool(
  'nexus_pattern',
  'Search for code patterns used across projects. Useful before implementing something to find if a similar pattern already exists in the portfolio.',
  {
    query: z.string().describe('Pattern name or description to search for'),
    projectPath: z.string().optional().describe('Scope to a specific project path'),
  },
  async ({ query, projectPath }) => {
    const results = withService((svc) => {
      let projectId: string | undefined;
      if (projectPath) {
        const project = svc.getProjectByPath(projectPath);
        if (!project) {
          return { error: `No project registered at "${projectPath}"` };
        }
        projectId = project.id;
      }
      return { patterns: svc.query({ query, ...(projectId ? { projectId } : {}), kinds: ['pattern'], limit: 20 }).patterns };
    });

    if ('error' in results) {
      return { content: [{ type: 'text', text: results.error }], isError: true };
    }

    if (results.patterns.length === 0) {
      return { content: [{ type: 'text', text: `No patterns found matching "${query}".` }] };
    }

    const lines = [`## Patterns matching "${query}" (${results.patterns.length}):\n`];
    for (const p of results.patterns) {
      lines.push(`### ${p.name} (×${p.frequency})`);
      lines.push(p.description);
      if (p.examplePath) lines.push(`*Example:* \`${p.examplePath}\``);
      lines.push('');
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

// ─── nexus_check_conflicts ────────────────────────────────────────────────────

server.tool(
  'nexus_check_conflicts',
  'Check for conflicting decisions or patterns across projects. Use before making a decision that could conflict with choices made in related projects.',
  {
    projectPaths: z.array(z.string()).min(1).describe('Absolute paths of projects to check against each other'),
    topic: z.string().optional().describe('Narrow conflict check to a specific topic or technology'),
  },
  async ({ projectPaths, topic }) => {
    const result = withService((svc) => {
      const projectIds: string[] = [];
      const notFound: string[] = [];

      for (const p of projectPaths) {
        const project = svc.getProjectByPath(p);
        if (project) projectIds.push(project.id);
        else notFound.push(p);
      }

      if (projectIds.length < 1) {
        return { error: `No registered projects found at: ${projectPaths.join(', ')}` };
      }

      const check = svc.checkConflicts(projectIds, topic);
      return { check, notFound, projectIds };
    });

    if ('error' in result) {
      return { content: [{ type: 'text', text: result.error }], isError: true };
    }

    const { check, notFound } = result;
    const lines: string[] = [];

    if (notFound.length > 0) {
      lines.push(`⚠ Some paths not registered with Nexus: ${notFound.join(', ')}\n`);
    }

    if (!check.hasConflicts) {
      lines.push('✓ No conflicts detected across the specified projects.');
    } else {
      if (check.conflicts.length > 0) {
        lines.push(`## Recorded Conflicts (${check.conflicts.length})`);
        for (const c of check.conflicts) {
          lines.push(`- ${c.description}`);
          lines.push(`  Projects: ${c.projectIds.join(', ')}`);
          lines.push(`  Detected: ${new Date(c.detectedAt).toLocaleDateString()}`);
        }
        lines.push('');
      }
      if (check.potentialConflicts.length > 0) {
        lines.push(`## Potential Conflicts (${check.potentialConflicts.length})`);
        for (const pc of check.potentialConflicts) {
          lines.push(`- **${pc.topic}:** ${pc.description}`);
        }
      }
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

// ─── nexus_dependencies ───────────────────────────────────────────────────────

server.tool(
  'nexus_dependencies',
  'Query the cross-project dependency graph. Shows how projects relate to each other.',
  {
    projectPath: z.string().describe('Absolute path of the root project to start from'),
    depth: z.number().int().min(1).max(5).default(2).describe('How many levels of relationships to traverse'),
  },
  async ({ projectPath, depth }) => {
    const result = withService((svc) => {
      const project = svc.getProjectByPath(projectPath);
      if (!project) {
        return { error: `No project registered at "${projectPath}"` };
      }
      const edges = svc.getDependencyGraph(project.id, depth);
      const allProjects = svc.listProjects();
      return { project, edges, allProjects };
    });

    if ('error' in result) {
      return { content: [{ type: 'text', text: result.error }], isError: true };
    }

    const { project, edges, allProjects } = result;
    const projectMap = new Map(allProjects.map((p) => [p.id, p]));

    if (edges.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `Project **${project.name}** has no child dependencies registered.\n\nUse \`nexus project add <path> --parent ${project.id}\` to register related projects.`,
          },
        ],
      };
    }

    const lines = [`## Dependency graph for **${project.name}** (depth ${depth})\n`];
    for (const edge of edges) {
      const from = projectMap.get(edge.from)?.name ?? edge.from;
      const to = projectMap.get(edge.to)?.name ?? edge.to;
      lines.push(`${from} → ${to}`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

// ─── nexus_preferences ────────────────────────────────────────────────────────

server.tool(
  'nexus_preferences',
  'Look up or set developer preferences (global or project-scoped). Use to remember consistent choices like code style, preferred libraries, or workflow settings.',
  {
    action: z.enum(['get', 'set', 'list']).describe('"get" a specific key, "set" a key-value pair, "list" all preferences'),
    key: z.string().max(200).optional().describe('Preference key (required for get/set)'),
    value: z.string().optional().describe('Value to set (required for set)'),
    projectPath: z.string().optional().describe('Project path for project-scoped preferences (omit for global)'),
  },
  async ({ action, key, value, projectPath }) => {
    let projectId: string | undefined;

    if (projectPath) {
      const project = withService((svc) => svc.getProjectByPath(projectPath));
      if (!project) {
        return { content: [{ type: 'text', text: `No project registered at "${projectPath}"` }], isError: true };
      }
      projectId = project.id;
    }

    if (action === 'list') {
      const prefs = withService((svc) => svc.listPreferences(projectId));
      if (prefs.length === 0) {
        return { content: [{ type: 'text', text: 'No preferences set yet.' }] };
      }
      const lines = prefs.map((p) => {
        const scope = p.scope === 'project' ? '(project)' : '(global)';
        return `- \`${p.key}\` = **${p.value}** ${scope}`;
      });
      return { content: [{ type: 'text', text: `## Preferences\n\n${lines.join('\n')}` }] };
    }

    if (!key) {
      return { content: [{ type: 'text', text: 'key is required for get/set actions' }], isError: true };
    }

    if (action === 'get') {
      const pref = withService((svc) => svc.getPreference(key, projectId));
      if (!pref) {
        return { content: [{ type: 'text', text: `No preference found for key "${key}".` }] };
      }
      return { content: [{ type: 'text', text: `\`${pref.key}\` = **${pref.value}** (${pref.scope})` }] };
    }

    if (action === 'set') {
      if (value === undefined) {
        return { content: [{ type: 'text', text: 'value is required for set action' }], isError: true };
      }
      const scope = projectId ? 'project' : 'global';
      const pref = withService((svc) => svc.setPreference(key, value, scope, projectId, 'mcp'));
      return {
        content: [
          { type: 'text', text: `✓ Set preference \`${pref.key}\` = **${pref.value}** (${pref.scope})` },
        ],
      };
    }

    return { content: [{ type: 'text', text: 'Unknown action' }], isError: true };
  },
);

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error('[nexus-mcp] Fatal error:', err);
  process.exit(1);
});
