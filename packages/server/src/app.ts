import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// @ts-expect-error — better-sqlite3 types are in @nexus/core, not this package
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { NexusService, isInitialized, listSessions, getSessionDetail, getNativeStats, computeSessionAnalytics, computeTokenAnalytics, computeContextOverhead, buildSessionSnapshot, getPricing, calculateCost } from '@nexus/core';
import type { SessionAnalytics, TokenAnalytics, ContextOverhead, DoctorReport, PipelineStats, ModelPricing, LlmCostSummary } from '@nexus/core';
import type { DecisionKind, UpsertNoteParams } from '@nexus/core';

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
  const tierParam = c.req.query('tier') as 'advisory' | 'conflict' | undefined;
  const projectIds = projectIdsParam ? projectIdsParam.split(',') : undefined;
  const check = withSvc((svc) =>
    svc.checkConflicts(projectIds ?? withSvc((s) => s.listProjects()).map((p) => p.id)),
  );
  // Optionally filter by tier
  if (tierParam) {
    if (tierParam === 'advisory') {
      return c.json({ ...check, conflicts: [], hasConflicts: check.advisories.length > 0 });
    }
    if (tierParam === 'conflict') {
      return c.json({ ...check, advisories: [], hasConflicts: check.conflicts.length > 0 || check.potentialConflicts.length > 0 });
    }
  }
  return c.json(check);
});

app.post('/api/conflicts/:id/dismiss', (c) => {
  const id = c.req.param('id');
  const dismissed = withSvc((svc) => svc.dismissAdvisory(id, 'daemon'));
  if (!dismissed) return c.json({ error: 'Not found or not an advisory' }, 404);
  return c.json({ dismissed: true });
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
      try {
        const updated = svc.syncProject(project.id);
        return {
          projectId: project.id,
          projectName: project.name,
          updated,
          error: null,
        };
      } catch (err: unknown) {
        return {
          projectId: project.id,
          projectName: project.name,
          updated: false,
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

// ─── Session Token Detail ─────────────────────────────────────────────────────

type MessageSource =
  | 'system_context'
  | 'hook_injection'
  | 'user_message'
  | 'tool_result'
  | 'assistant_text'
  | 'assistant_tool'
  | 'assistant_mixed';

interface TimelineMessage {
  index: number;
  timestamp: string;
  role: 'user' | 'assistant';
  source: MessageSource;
  summary: string;
  toolNames?: string[];
  tokens?: {
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    costUsd: number;
    cacheHitPct: number;
    inputDelta: number;
  };
  model?: string;
}

interface RawLine {
  type?: string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens?: number;
    };
  };
}

function classifyUserMessage(content: unknown, isFirst: boolean): MessageSource {
  if (isFirst) return 'system_context';
  const blocks: unknown[] = Array.isArray(content) ? content : [];

  // Check for tool_result blocks
  const hasToolResult = blocks.some(
    (b) => typeof b === 'object' && b !== null && (b as Record<string, unknown>)['type'] === 'tool_result',
  );
  if (hasToolResult) return 'tool_result';

  // Check for system-reminder tags in text content
  const textContent = blocks
    .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null && (b as Record<string, unknown>)['type'] === 'text')
    .map((b) => String((b as Record<string, unknown>)['text'] ?? ''))
    .join('');
  if (typeof content === 'string' && content.includes('<system-reminder>')) return 'hook_injection';
  if (textContent.includes('<system-reminder>')) return 'hook_injection';

  return 'user_message';
}

function classifyAssistantMessage(content: unknown): MessageSource {
  const blocks: unknown[] = Array.isArray(content) ? content : [];
  let hasText = false;
  let hasToolUse = false;
  for (const b of blocks) {
    if (typeof b !== 'object' || b === null) continue;
    const t = (b as Record<string, unknown>)['type'];
    if (t === 'text') hasText = true;
    if (t === 'tool_use') hasToolUse = true;
  }
  if (hasText && hasToolUse) return 'assistant_mixed';
  if (hasToolUse) return 'assistant_tool';
  return 'assistant_text';
}

function extractSummary(content: unknown, role: string): string {
  const blocks: unknown[] = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
  for (const b of blocks) {
    if (typeof b !== 'object' || b === null) continue;
    const t = (b as Record<string, unknown>)['type'];
    if (t === 'text') {
      const text = String((b as Record<string, unknown>)['text'] ?? '').trim();
      if (text) return text.slice(0, 200);
    }
    if (t === 'tool_use') {
      const name = String((b as Record<string, unknown>)['name'] ?? 'tool');
      return `[${name}]`;
    }
    if (t === 'tool_result') {
      const content2 = (b as Record<string, unknown>)['content'];
      if (typeof content2 === 'string') return content2.slice(0, 200);
      if (Array.isArray(content2)) {
        const first = content2[0];
        if (typeof first === 'object' && first !== null && (first as Record<string, unknown>)['type'] === 'text') {
          return String((first as Record<string, unknown>)['text'] ?? '').slice(0, 200);
        }
      }
      return '[tool result]';
    }
  }
  return '';
}

function extractToolNames(content: unknown, role: string): string[] {
  const blocks: unknown[] = Array.isArray(content) ? content : [];
  const names: string[] = [];
  const type = role === 'assistant' ? 'tool_use' : 'tool_result';
  for (const b of blocks) {
    if (typeof b !== 'object' || b === null) continue;
    if ((b as Record<string, unknown>)['type'] === type) {
      const name = (b as Record<string, unknown>)['name'];
      if (name && typeof name === 'string') names.push(name);
    }
  }
  return names.length > 0 ? names : undefined as unknown as string[];
}

app.get('/api/native/session-tokens', (c) => {
  const encodedPath = c.req.query('path');
  if (!encodedPath) {
    return c.json({ error: 'path query parameter required' }, 400);
  }
  let jsonlPath: string;
  try {
    // Decode URL-safe base64 (- → +, _ → /, re-pad with =)
    const standardB64 = encodedPath.replace(/-/g, '+').replace(/_/g, '/');
    const padded = standardB64 + '='.repeat((4 - (standardB64.length % 4)) % 4);
    jsonlPath = Buffer.from(padded, 'base64').toString('utf-8');
  } catch {
    return c.json({ error: 'Invalid path encoding' }, 400);
  }

  // Normalize both paths for comparison (handle mixed slashes on Windows)
  const normalizedPath = path.normalize(jsonlPath);
  const normalizedClaudeDir = path.normalize(CLAUDE_DIR);
  if (!normalizedPath.startsWith(normalizedClaudeDir)) {
    return c.json({ error: 'Path not allowed' }, 403);
  }
  // Use the normalized path for reading
  jsonlPath = normalizedPath;

  let fileContent: string;
  try {
    fileContent = fs.readFileSync(jsonlPath, 'utf-8');
  } catch {
    return c.json({ error: 'Session file not found' }, 404);
  }

  const timeline: TimelineMessage[] = [];
  let sessionId = '';
  let cwd = '';
  let startedAt = '';
  let lastTimestamp = '';
  let userTurnCount = 0;
  let totalToolCalls = 0;
  let firstUserSeen = false;
  let msgIndex = 0;

  // Track previous assistant input tokens for delta calculation
  let prevAssistantInput = 0;

  // Model cost accumulation
  const modelCosts = new Map<string, { requests: number; costUsd: number }>();

  // Source breakdown accumulation
  const sourceAccum = new Map<MessageSource, { count: number; estimatedTokens: number }>();

  // Totals
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheWrite = 0;
  let totalCacheRead = 0;
  let totalCost = 0;

  // We need to track user messages between assistant turns for attribution
  const pendingUserSources: MessageSource[] = [];

  for (const line of fileContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: RawLine;
    try {
      parsed = JSON.parse(trimmed) as RawLine;
    } catch {
      continue;
    }

    if (parsed.type === 'progress') continue;
    if (!parsed.uuid) continue;

    if (!sessionId && parsed.sessionId) sessionId = parsed.sessionId;
    if (!cwd && parsed.cwd) cwd = parsed.cwd;
    if (!startedAt && parsed.timestamp) startedAt = parsed.timestamp;
    if (parsed.timestamp) lastTimestamp = parsed.timestamp;

    const msg = parsed.message;
    if (!msg || !msg.role) continue;

    if (msg.role === 'user') {
      const isFirst = !firstUserSeen;
      firstUserSeen = true;
      const source = classifyUserMessage(msg.content, isFirst);

      // Count user turns (non-tool-result)
      if (source !== 'tool_result') userTurnCount++;

      const toolNames = extractToolNames(msg.content, 'user');

      timeline.push({
        index: msgIndex++,
        timestamp: parsed.timestamp ?? '',
        role: 'user',
        source,
        summary: extractSummary(msg.content, 'user'),
        ...(toolNames ? { toolNames } : {}),
      });

      pendingUserSources.push(source);

      // Accumulate source count
      const sa = sourceAccum.get(source) ?? { count: 0, estimatedTokens: 0 };
      sa.count++;
      sourceAccum.set(source, sa);

      continue;
    }

    if (msg.role !== 'assistant') continue;

    // Count tool calls
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === 'object' && block !== null && (block as Record<string, unknown>)['type'] === 'tool_use') {
          totalToolCalls++;
        }
      }
    }

    const source = classifyAssistantMessage(msg.content);
    const toolNames = extractToolNames(msg.content, 'assistant');
    const model = msg.model ?? 'unknown';

    let tokens: TimelineMessage['tokens'] | undefined;

    if (msg.usage) {
      const usage = msg.usage;
      const input = usage.input_tokens ?? 0;
      const cacheWrite = usage.cache_creation_input_tokens ?? 0;
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      const output = usage.output_tokens ?? 0;

      if (input > 0 || cacheWrite > 0 || cacheRead > 0 || output > 0) {
        const pricing = getPricing(model);
        const cost = calculateCost(pricing, input, cacheWrite, cacheRead, output);
        const totalInputForMsg = input + cacheWrite + cacheRead;
        const cacheHitPct = totalInputForMsg > 0 ? (cacheRead / totalInputForMsg) * 100 : 0;
        const inputDelta = input - prevAssistantInput;

        tokens = {
          inputTokens: input,
          outputTokens: output,
          cacheWriteTokens: cacheWrite,
          cacheReadTokens: cacheRead,
          costUsd: cost,
          cacheHitPct,
          inputDelta,
        };

        prevAssistantInput = input;

        totalInput += input;
        totalOutput += output;
        totalCacheWrite += cacheWrite;
        totalCacheRead += cacheRead;
        totalCost += cost;

        // Model accumulation
        const mc = modelCosts.get(model) ?? { requests: 0, costUsd: 0 };
        mc.requests++;
        mc.costUsd += cost;
        modelCosts.set(model, mc);

        // Attribute input delta to pending user sources
        if (pendingUserSources.length > 0 && inputDelta > 0) {
          const perSource = inputDelta / pendingUserSources.length;
          for (const ps of pendingUserSources) {
            const sa = sourceAccum.get(ps) ?? { count: 0, estimatedTokens: 0 };
            sa.estimatedTokens += perSource;
            sourceAccum.set(ps, sa);
          }
        }
        pendingUserSources.length = 0;
      }
    }

    timeline.push({
      index: msgIndex++,
      timestamp: parsed.timestamp ?? '',
      role: 'assistant',
      source,
      summary: extractSummary(msg.content, 'assistant'),
      ...(toolNames ? { toolNames } : {}),
      ...(tokens ? { tokens } : {}),
      ...(model !== 'unknown' ? { model } : {}),
    });
  }

  // Build source breakdown
  const totalAllInput = totalInput + totalCacheWrite + totalCacheRead;
  const sourceBreakdown = [...sourceAccum.entries()].map(([source, acc]) => ({
    source,
    count: acc.count,
    estimatedTokens: Math.round(acc.estimatedTokens),
    pctOfInput: totalAllInput > 0 ? Math.round((acc.estimatedTokens / totalAllInput) * 1000) / 10 : 0,
  })).sort((a, b) => b.estimatedTokens - a.estimatedTokens);

  // Cache savings
  // Compute per-model cache savings (based on pricing difference)
  let totalCacheSavings = 0;
  let hypotheticalCost = 0;
  for (const tm of timeline) {
    if (tm.role === 'assistant' && tm.tokens && tm.model) {
      const pricing = getPricing(tm.model);
      totalCacheSavings += (tm.tokens.cacheReadTokens * (pricing.input - pricing.cacheRead)) / 1_000_000;
      hypotheticalCost += calculateCost(
        pricing,
        tm.tokens.inputTokens + tm.tokens.cacheReadTokens,
        tm.tokens.cacheWriteTokens,
        0,
        tm.tokens.outputTokens,
      );
    }
  }

  const totalAllInputForRate = totalInput + totalCacheWrite + totalCacheRead;
  const cacheHitRate = totalAllInputForRate > 0 ? (totalCacheRead / totalAllInputForRate) * 100 : 0;

  const durationMs = startedAt && lastTimestamp
    ? new Date(lastTimestamp).getTime() - new Date(startedAt).getTime()
    : 0;

  const models = [...modelCosts.entries()].map(([model, mc]) => ({
    model,
    requests: mc.requests,
    costUsd: mc.costUsd,
  })).sort((a, b) => b.costUsd - a.costUsd);

  return c.json({
    sessionId,
    cwd,
    startedAt,
    lastActivityAt: lastTimestamp,
    durationMs,
    userTurns: userTurnCount,
    toolCalls: totalToolCalls,
    timeline,
    sourceBreakdown,
    totals: {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheWriteTokens: totalCacheWrite,
      cacheReadTokens: totalCacheRead,
      costUsd: totalCost,
      cacheSavingsUsd: totalCacheSavings,
      cacheHitRate,
      hypotheticalCostWithoutCache: hypotheticalCost,
    },
    models,
  });
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

// ─── Health / Diagnostics ─────────────────────────────────────────────────

app.get('/api/health/doctor', (c) => {
  try {
    const report = withSvc((svc) => svc.getDoctorReport());
    return c.json(report);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: msg }, 500);
  }
});

app.post('/api/health/fix', (c) => {
  try {
    const result = withSvc((svc) => svc.runDoctorFix());
    return c.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: msg }, 500);
  }
});

app.get('/api/health/pipeline', (c) => {
  try {
    const sinceParam = c.req.query('since');
    const projectId = c.req.query('projectId');
    let since: number | undefined;
    if (sinceParam) {
      const match = sinceParam.match(/^(\d+)d$/);
      if (match && match[1]) {
        since = Date.now() - parseInt(match[1], 10) * 24 * 60 * 60 * 1000;
      } else {
        since = parseInt(sinceParam, 10);
      }
    }
    const stats = withSvc((svc) =>
      svc.getPipelineStats(projectId ?? undefined, since),
    );
    return c.json(stats);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: msg }, 500);
  }
});

// ─── Nexus LLM Costs ─────────────────────────────────────────────────────────

app.get('/api/analytics/llm-costs', (c) => {
  try {
    const sinceParam = c.req.query('since');
    let since: number | undefined;
    if (sinceParam) {
      const match = sinceParam.match(/^(\d+)d$/);
      if (match && match[1]) {
        since = Date.now() - parseInt(match[1], 10) * 24 * 60 * 60 * 1000;
      } else {
        since = parseInt(sinceParam, 10);
      }
    }
    const costs = withSvc((svc) => svc.getLlmCosts(since));
    return c.json(costs);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: msg }, 500);
  }
});

// ─── Session Tracking (reads from ~/.claude/nexus-session.db) ────────────────

const SESSION_DB_PATH = path.join(os.homedir(), '.claude', 'nexus-session.db');

function withSessionDb<T>(fn: (db: Database.Database) => T): T | null {
  if (!fs.existsSync(SESSION_DB_PATH)) return null;
  const db = new Database(SESSION_DB_PATH, { readonly: true });
  db.pragma('journal_mode = WAL');
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

app.get('/api/sessions/active', (c) => {
  const sessions = withSessionDb((db) =>
    db.prepare(
      `SELECT session_id, project_dir, started_at, last_event, event_count, compact_count
       FROM session_meta ORDER BY last_event DESC LIMIT 50`,
    ).all(),
  );
  return c.json(sessions ?? []);
});

app.get('/api/sessions/:id/events', (c) => {
  const sessionId = c.req.param('id');
  const limit = parseInt(c.req.query('limit') ?? '200', 10);
  const events = withSessionDb((db) =>
    db.prepare(
      `SELECT id, type, category, priority, data, source, created_at
       FROM session_events WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
    ).all(sessionId, limit),
  );
  return c.json(events ?? []);
});

app.get('/api/sessions/:id/snapshot', (c) => {
  const sessionId = c.req.param('id');
  const events = withSessionDb((db) =>
    db.prepare(
      `SELECT type, category, priority, data, source
       FROM session_events WHERE session_id = ? ORDER BY id ASC`,
    ).all(sessionId),
  ) as Array<{ type: string; category: string; priority: number; data: string; source: string }> | null;

  if (!events || events.length === 0) {
    return c.json({ snapshot: '' });
  }

  const snapshot = buildSessionSnapshot(
    events.map((e) => ({
      type: e.type as any,
      category: e.category as any,
      priority: e.priority as any,
      data: e.data,
      source: e.source,
    })),
  );
  return c.json({ snapshot });
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

app.get('/api/langfuse/status', async (c) => {
  const lf = getLangfuseConfig();
  if (!lf) return c.json({ configured: false, reachable: false });

  // Quick reachability check (3s timeout)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    const res = await fetch(`${lf.baseUrl}/api/public/health`, {
      headers: { Authorization: lf.authHeader },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return c.json({ configured: true, reachable: res.ok });
  } catch {
    return c.json({ configured: true, reachable: false });
  }
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
    const timeout = setTimeout(() => controller.abort(), 5_000);
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

// ─── API 404 guard — return JSON for any unmatched /api/* route ───────────────
app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

// ─── Dashboard (static) ───────────────────────────────────────────────────────

app.use('/*', serveStatic({ root: './packages/dashboard/dist' }));

// SPA fallback — serve index.html for any unmatched route
app.use('/*', serveStatic({ path: './packages/dashboard/dist/index.html' }));

export { app };
