import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { NexusService, isInitialized, listSessions, getSessionDetail, getNativeStats, syncClaudeMd, selectRelevantProjects, computeSessionAnalytics, computeTokenAnalytics, computeContextOverhead } from '@nexus/core';
import type { SessionAnalytics, TokenAnalytics, ContextOverhead } from '@nexus/core';
import type { DecisionKind, UpsertNoteParams, Conflict } from '@nexus/core';

const app = new Hono();

// Allow dashboard (localhost:5173 vite dev) to call the API
app.use(
  '*',
  cors({
    origin: ['http://localhost:5173', 'http://localhost:4173', 'http://tauri.localhost'],
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
  }),
);

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (c) => {
  return c.json({ ok: true, initialized: isInitialized(), version: '0.1.0' });
});

// ─── Helper ───────────────────────────────────────────────────────────────────

function withSvc<T>(fn: (svc: NexusService) => T): T {
  const svc = NexusService.open();
  try {
    return fn(svc);
  } finally {
    svc.close();
  }
}

// ─── Projects ─────────────────────────────────────────────────────────────────

app.get('/api/projects', (c) => {
  const projects = withSvc((svc) => svc.listProjects());
  return c.json(projects);
});

app.get('/api/projects/counts', (c) => {
  const projects = withSvc((svc) => svc.listProjects());
  const counts = projects.map((p) => ({
    id: p.id,
    decisions: withSvc((svc) => svc.getDecisionsForProject(p.id)).length,
    patterns: withSvc((svc) => svc.getPatternsForProject(p.id)).length,
    notes: withSvc((svc) => svc.getNotesForProject(p.id)).length,
  }));
  return c.json(counts);
});

app.get('/api/projects/:id', (c) => {
  const id = c.req.param('id');
  const project = withSvc((svc) => svc.getProjectById(id));
  if (!project) return c.json({ error: 'Not found' }, 404);
  return c.json(project);
});

app.get('/api/projects/:id/decisions', (c) => {
  const id = c.req.param('id');
  const decisions = withSvc((svc) => svc.getDecisionsForProject(id));
  return c.json(decisions);
});

app.get('/api/projects/:id/patterns', (c) => {
  const id = c.req.param('id');
  const patterns = withSvc((svc) => svc.getPatternsForProject(id));
  return c.json(patterns);
});

app.get('/api/projects/:id/preferences', (c) => {
  const id = c.req.param('id');
  const preferences = withSvc((svc) => svc.listPreferences(id));
  return c.json(preferences);
});

app.get('/api/projects/:id/notes', (c) => {
  const id = c.req.param('id');
  const notes = withSvc((svc) => svc.getNotesForProject(id));
  return c.json(notes);
});

app.get('/api/projects/:id/dependencies', (c) => {
  const id = c.req.param('id');
  const depth = parseInt(c.req.query('depth') ?? '2', 10);
  const edges = withSvc((svc) => svc.getDependencyGraph(id, depth));
  return c.json(edges);
});

// ─── Notes ────────────────────────────────────────────────────────────────────

app.get('/api/notes/search', (c) => {
  const q = c.req.query('q');
  if (!q) return c.json({ error: 'q parameter required' }, 400);
  const projectId = c.req.query('projectId');
  const notes = withSvc((svc) => svc.searchNotes(q, projectId));
  return c.json(notes);
});

app.post('/api/notes', async (c) => {
  const body = await c.req.json<UpsertNoteParams>();
  const note = withSvc((svc) => svc.upsertNote(body, 'daemon'));
  return c.json(note, 201);
});

app.delete('/api/notes/:id', (c) => {
  const id = c.req.param('id');
  const deleted = withSvc((svc) => svc.deleteNote(id, 'daemon'));
  if (!deleted) return c.json({ error: 'Not found' }, 404);
  return c.json({ deleted: true });
});

// ─── Decisions ────────────────────────────────────────────────────────────────

app.post('/api/decisions', async (c) => {
  const body = await c.req.json<{
    projectId: string;
    kind: DecisionKind;
    summary: string;
    rationale?: string;
  }>();
  const decision = withSvc((svc) =>
    svc.recordDecision(
      {
        projectId: body.projectId,
        kind: body.kind,
        summary: body.summary,
        ...(body.rationale ? { rationale: body.rationale } : {}),
      },
      'cli',
    ),
  );
  return c.json(decision, 201);
});

// ─── Patterns ─────────────────────────────────────────────────────────────────

app.post('/api/patterns', async (c) => {
  const body = await c.req.json<{
    projectId: string;
    name: string;
    description: string;
    examplePath?: string;
  }>();
  const pattern = withSvc((svc) =>
    svc.upsertPattern(
      {
        projectId: body.projectId,
        name: body.name,
        description: body.description,
        ...(body.examplePath ? { examplePath: body.examplePath } : {}),
      },
      'daemon',
    ),
  );
  return c.json(pattern, 201);
});

// ─── Conflicts ────────────────────────────────────────────────────────────────

app.get('/api/conflicts', (c) => {
  const projectIdsParam = c.req.query('projectIds');
  const projectIds = projectIdsParam ? projectIdsParam.split(',') : undefined;
  const check = withSvc((svc) =>
    svc.checkConflicts(projectIds ?? withSvc((s) => s.listProjects()).map((p) => p.id)),
  );
  return c.json(check);
});

// ─── Preferences ──────────────────────────────────────────────────────────────

app.get('/api/preferences', (c) => {
  const projectId = c.req.query('projectId');
  const preferences = withSvc((svc) => svc.listPreferences(projectId));
  return c.json(preferences);
});

app.post('/api/preferences', async (c) => {
  const body = await c.req.json<{
    key: string;
    value: string;
    scope: 'global' | 'project';
    projectId?: string;
  }>();
  const pref = withSvc((svc) =>
    svc.setPreference(
      body.key,
      body.value,
      body.scope,
      body.projectId,
      'daemon',
    ),
  );
  return c.json(pref);
});

// ─── Query ────────────────────────────────────────────────────────────────────

app.get('/api/query', (c) => {
  const q = c.req.query('q');
  if (!q) return c.json({ error: 'q parameter required' }, 400);
  const projectId = c.req.query('projectId');
  const results = withSvc((svc) =>
    svc.query({
      query: q,
      ...(projectId ? { projectId } : {}),
      limit: parseInt(c.req.query('limit') ?? '10', 10),
    }),
  );
  return c.json(results);
});

// ─── Stats ────────────────────────────────────────────────────────────────────

app.get('/api/stats', (c) => {
  const stats = withSvc((svc) => {
    const projects = svc.listProjects();
    let totalDecisions = 0;
    let totalPatterns = 0;
    let totalNotes = 0;
    for (const p of projects) {
      totalDecisions += svc.getDecisionsForProject(p.id).length;
      totalPatterns += svc.getPatternsForProject(p.id).length;
      totalNotes += svc.getNotesForProject(p.id).length;
    }
    return {
      projects: projects.length,
      decisions: totalDecisions,
      patterns: totalPatterns,
      notes: totalNotes,
    };
  });
  return c.json(stats);
});

// ─── Sync ─────────────────────────────────────────────────────────────────────

app.post('/api/sync', (c) => {
  const results = withSvc((svc) => {
    const allProjects = svc.listProjects();

    return allProjects.map((project) => {
      const decisions = svc.getDecisionsForProject(project.id);
      const patterns = svc.getPatternsForProject(project.id);
      const preferences = svc.listPreferences(project.id);
      const notes = svc.getNotesForProject(project.id);
      const { conflicts } = svc.checkConflicts([project.id]);
      const otherProjects = allProjects.filter((p) => p.id !== project.id);
      const relatedProjects = otherProjects
        .filter((p) => p.parentId === project.id || project.parentId === p.id)
        .map((p) => ({ name: p.name, path: p.path }));
      const allNotesMap = otherProjects.map((p) => ({
        projectName: p.name,
        project: p,
        notes: svc.getNotesForProject(p.id),
      }));
      const relatedProjectNotes = selectRelevantProjects(
        { project, notes },
        allNotesMap,
      );

      try {
        const result = syncClaudeMd({
          projectPath: project.path,
          notes,
          relatedProjectNotes,
          decisions,
          patterns,
          preferences,
          conflicts: conflicts as Conflict[],
          relatedProjects,
        });
        return {
          projectId: project.id,
          projectName: project.name,
          updated: result.updated,
          claudeMdPath: result.claudeMdPath,
          error: null,
        };
      } catch (err: unknown) {
        return {
          projectId: project.id,
          projectName: project.name,
          updated: false,
          claudeMdPath: null,
          error: err instanceof Error ? err.message : 'Unknown error',
        };
      }
    });
  });

  const updatedCount = results.filter((r) => r.updated).length;
  return c.json({ results, updatedCount });
});

// ─── Activity ─────────────────────────────────────────────────────────────────

app.get('/api/activity', (c) => {
  const limit = parseInt(c.req.query('limit') ?? '500', 10);
  const events = withSvc((svc) => {
    const projects = svc.listProjects();
    const all: Array<{
      id: string;
      type: 'decision' | 'pattern';
      projectId: string;
      projectName: string;
      kind?: string;
      name?: string;
      summary?: string;
      description?: string;
      rationale?: string;
      frequency?: number;
      timestamp: number;
    }> = [];
    for (const p of projects) {
      for (const d of svc.getDecisionsForProject(p.id)) {
        all.push({
          id: d.id,
          type: 'decision',
          projectId: p.id,
          projectName: p.name,
          kind: d.kind,
          summary: d.summary,
          ...(d.rationale != null ? { rationale: d.rationale } : {}),
          timestamp: d.recordedAt,
        });
      }
      for (const pa of svc.getPatternsForProject(p.id)) {
        all.push({
          id: pa.id,
          type: 'pattern',
          projectId: p.id,
          projectName: p.name,
          name: pa.name,
          description: pa.description,
          frequency: pa.frequency,
          timestamp: pa.lastSeenAt,
        });
      }
    }
    return all.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  });
  return c.json(events);
});

// ─── Native Sessions (Claude Code JSONL) ──────────────────────────────────────

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

app.get('/api/native/stats', async (c) => {
  try {
    const stats = await getNativeStats(CLAUDE_DIR);
    return c.json(stats);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: msg }, 500);
  }
});

app.get('/api/native/sessions', async (c) => {
  try {
    const cwdFilter = c.req.query('cwd');
    let sessions = await listSessions(CLAUDE_DIR);
    if (cwdFilter) {
      sessions = sessions.filter(s => s.cwd.includes(cwdFilter));
    }
    return c.json(sessions);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: msg }, 500);
  }
});

app.get('/api/native/sessions/:encodedPath', async (c) => {
  const encodedPath = c.req.param('encodedPath');
  let jsonlPath: string;
  try {
    jsonlPath = Buffer.from(encodedPath, 'base64').toString('utf-8');
  } catch {
    return c.json({ error: 'Invalid path encoding' }, 400);
  }

  // Security: only allow paths within ~/.claude
  if (!jsonlPath.startsWith(CLAUDE_DIR)) {
    return c.json({ error: 'Path not allowed' }, 403);
  }

  try {
    const detail = await getSessionDetail(jsonlPath);
    return c.json(detail);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: msg }, 404);
  }
});

// ─── Analytics ───────────────────────────────────────────────────────────────

let sessionAnalyticsCache: { data: SessionAnalytics; at: number } | null = null;

app.get('/api/analytics/sessions', async (c) => {
  const sinceDays = parseInt(c.req.query('since') ?? '30', 10);

  // 60-second cache
  if (sessionAnalyticsCache && Date.now() - sessionAnalyticsCache.at < 60_000) {
    return c.json(sessionAnalyticsCache.data);
  }

  try {
    const data = await computeSessionAnalytics(CLAUDE_DIR, { sinceDays });
    sessionAnalyticsCache = { data, at: Date.now() };
    return c.json(data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: msg }, 500);
  }
});

let tokenAnalyticsCache: { data: TokenAnalytics; at: number; sinceDays: number } | null = null;

app.get('/api/analytics/tokens', async (c) => {
  const sinceDays = parseInt(c.req.query('since') ?? '30', 10);

  // 60-second cache (invalidate if range changes)
  if (tokenAnalyticsCache && tokenAnalyticsCache.sinceDays === sinceDays && Date.now() - tokenAnalyticsCache.at < 60_000) {
    return c.json(tokenAnalyticsCache.data);
  }

  try {
    const data = await computeTokenAnalytics(CLAUDE_DIR, { sinceDays });
    tokenAnalyticsCache = { data, at: Date.now(), sinceDays };
    return c.json(data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: msg }, 500);
  }
});

app.get('/api/analytics/context-overhead', (c) => {
  try {
    const data = computeContextOverhead(CLAUDE_DIR);
    return c.json(data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: msg }, 500);
  }
});

app.get('/api/analytics/audit/daily', (c) => {
  const since = c.req.query('since');
  const until = c.req.query('until');
  const counts = withSvc((svc) =>
    svc.getAuditCountsByDay({
      ...(since ? { since: parseInt(since, 10) } : {}),
      ...(until ? { until: parseInt(until, 10) } : {}),
    }),
  );
  return c.json(counts);
});

app.get('/api/analytics/audit/operations', (c) => {
  const since = c.req.query('since');
  const until = c.req.query('until');
  const counts = withSvc((svc) =>
    svc.getAuditCountsByOperation({
      ...(since ? { since: parseInt(since, 10) } : {}),
      ...(until ? { until: parseInt(until, 10) } : {}),
    }),
  );
  return c.json(counts);
});

// ─── Langfuse Proxy ───────────────────────────────────────────────────────────

function getLangfuseConfig(): { baseUrl: string; authHeader: string } | null {
  try {
    const cfgPath = path.join(os.homedir(), '.nexus', 'config.json');
    const raw = fs.readFileSync(cfgPath, 'utf-8');
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const lf = cfg['langfuse'] as Record<string, string> | undefined;
    if (!lf?.['baseUrl'] || !lf?.['publicKey'] || !lf?.['secretKey']) return null;
    const credentials = Buffer.from(`${lf['publicKey']}:${lf['secretKey']}`).toString('base64');
    return {
      baseUrl: lf['baseUrl'].replace(/\/$/, ''),
      authHeader: `Basic ${credentials}`,
    };
  } catch {
    return null;
  }
}

app.get('/api/langfuse/status', (c) => {
  return c.json({ configured: getLangfuseConfig() !== null });
});

// Generic read-only proxy: /api/langfuse/* → {langfuseBase}/api/public/*
app.get('/api/langfuse/*', async (c) => {
  const lf = getLangfuseConfig();
  if (!lf) return c.json({ error: 'Langfuse not configured' }, 503);

  const { pathname, search } = new URL(c.req.url);
  const suffix = pathname.slice('/api/langfuse'.length);
  const lfUrl = `${lf.baseUrl}/api/public${suffix}${search}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(lfUrl, {
      headers: { Authorization: lf.authHeader },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return c.json({ error: `Langfuse API error: ${res.status}` }, 502);
    }
    return c.json(await res.json() as Record<string, unknown>);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: `Langfuse unreachable: ${msg}` }, 502);
  }
});

// ─── Dashboard (static) ───────────────────────────────────────────────────────

app.use('/*', serveStatic({ root: './packages/dashboard/dist' }));

// SPA fallback — serve index.html for any unmatched route
app.use('/*', serveStatic({ path: './packages/dashboard/dist/index.html' }));

export { app };
