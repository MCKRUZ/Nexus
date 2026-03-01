import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { NexusService, isInitialized } from '@nexus/core';
import type { DecisionKind } from '@nexus/core';

const app = new Hono();

// Allow dashboard (localhost:5173 vite dev) to call the API
app.use(
  '*',
  cors({
    origin: ['http://localhost:5173', 'http://localhost:4173'],
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

app.get('/api/projects/:id/dependencies', (c) => {
  const id = c.req.param('id');
  const depth = parseInt(c.req.query('depth') ?? '2', 10);
  const edges = withSvc((svc) => svc.getDependencyGraph(id, depth));
  return c.json(edges);
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
    for (const p of projects) {
      totalDecisions += svc.getDecisionsForProject(p.id).length;
      totalPatterns += svc.getPatternsForProject(p.id).length;
    }
    return {
      projects: projects.length,
      decisions: totalDecisions,
      patterns: totalPatterns,
    };
  });
  return c.json(stats);
});

export { app };
