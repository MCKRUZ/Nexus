import fs from 'node:fs';
import path from 'node:path';
import { listSessions } from './session-reader.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SessionScanResult {
  sessionId: string;
  cwd: string;
  startedAt: string;
  lastActivityAt: string;
  userTurns: number;
  toolCalls: number;
  nexusToolCalls: number;
  toolBreakdown: Record<string, number>;
}

export interface SessionAnalytics {
  totalSessions: number;
  sessionsWithNexus: number;
  sessionsWithoutNexus: number;
  nexusAdoptionRate: number;
  toolUsageCounts: Record<string, number>;
  totalNexusToolCalls: number;
  withNexusAvg: { userTurns: number; toolCalls: number; durationMs: number };
  withoutNexusAvg: { userTurns: number; toolCalls: number; durationMs: number };
  dailyAdoption: Array<{ date: string; withNexus: number; withoutNexus: number }>;
  topNexusSessions: Array<{
    sessionId: string;
    cwd: string;
    nexusToolCalls: number;
    userTurns: number;
    toolCalls: number;
    startedAt: string;
  }>;
}

// ─── JSONL line types ────────────────────────────────────────────────────────

interface RawLine {
  type?: string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

// ─── Nexus tool name extraction ──────────────────────────────────────────────

const NEXUS_TOOL_RE = /nexus_/;

/**
 * Extracts the short nexus tool name from a full MCP tool name.
 * e.g. "mcp__nexus-local__nexus_query" → "nexus_query"
 */
function extractNexusToolName(fullName: string): string | null {
  const match = fullName.match(/(nexus_\w+)/);
  return match ? match[1]! : null;
}

// ─── Session scanner ─────────────────────────────────────────────────────────

export function scanSessionForNexusTools(jsonlPath: string): SessionScanResult | null {
  let content: string;
  try {
    content = fs.readFileSync(jsonlPath, 'utf-8');
  } catch {
    return null;
  }

  let sessionId = '';
  let cwd = '';
  let startedAt = '';
  let lastActivityAt = '';
  let userTurns = 0;
  let toolCalls = 0;
  let nexusToolCalls = 0;
  const toolBreakdown: Record<string, number> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: RawLine;
    try {
      parsed = JSON.parse(trimmed) as RawLine;
    } catch {
      continue;
    }

    if (parsed.type === 'progress') continue;
    if (!parsed.uuid || !parsed.timestamp) continue;

    if (!sessionId && parsed.sessionId) sessionId = parsed.sessionId;
    if (!cwd && parsed.cwd) cwd = parsed.cwd;
    if (!startedAt) startedAt = parsed.timestamp;
    lastActivityAt = parsed.timestamp;

    const role = parsed.message?.role;
    const content = parsed.message?.content;
    if (!role || !content) continue;

    const contentArr: unknown[] = Array.isArray(content) ? content : [];

    if (role === 'user') {
      const hasToolResult = contentArr.some(
        (b): b is Record<string, unknown> =>
          typeof b === 'object' && b !== null &&
          (b as Record<string, unknown>)['type'] === 'tool_result',
      );
      if (!hasToolResult) userTurns++;
    } else if (role === 'assistant') {
      for (const block of contentArr) {
        if (
          typeof block === 'object' && block !== null &&
          (block as Record<string, unknown>)['type'] === 'tool_use'
        ) {
          toolCalls++;
          const name = (block as Record<string, unknown>)['name'] as string;
          if (name && NEXUS_TOOL_RE.test(name)) {
            nexusToolCalls++;
            const short = extractNexusToolName(name) ?? name;
            toolBreakdown[short] = (toolBreakdown[short] ?? 0) + 1;
          }
        }
      }
    }
  }

  if (!startedAt) return null;

  return {
    sessionId: sessionId || path.basename(jsonlPath, '.jsonl'),
    cwd,
    startedAt,
    lastActivityAt,
    userTurns,
    toolCalls,
    nexusToolCalls,
    toolBreakdown,
  };
}

// ─── Aggregate analytics ─────────────────────────────────────────────────────

function durationMs(startedAt: string, lastActivityAt: string): number {
  const start = new Date(startedAt).getTime();
  const end = new Date(lastActivityAt).getTime();
  return Math.max(0, end - start);
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export interface ComputeAnalyticsOptions {
  sinceDays?: number;
}

export async function computeSessionAnalytics(
  claudeDir: string,
  opts: ComputeAnalyticsOptions = {},
): Promise<SessionAnalytics> {
  const sessions = await listSessions(claudeDir);

  const cutoff = opts.sinceDays
    ? new Date(Date.now() - opts.sinceDays * 86400000).toISOString()
    : undefined;

  const filtered = cutoff
    ? sessions.filter((s) => s.startedAt >= cutoff)
    : sessions;

  const scanned: SessionScanResult[] = [];
  for (const s of filtered) {
    const result = scanSessionForNexusTools(s.jsonlPath);
    if (result) scanned.push(result);
  }

  const withNexus = scanned.filter((s) => s.nexusToolCalls > 0);
  const withoutNexus = scanned.filter((s) => s.nexusToolCalls === 0);

  // Aggregate tool usage
  const toolUsageCounts: Record<string, number> = {};
  let totalNexusToolCalls = 0;
  for (const s of withNexus) {
    totalNexusToolCalls += s.nexusToolCalls;
    for (const [tool, count] of Object.entries(s.toolBreakdown)) {
      toolUsageCounts[tool] = (toolUsageCounts[tool] ?? 0) + count;
    }
  }

  // Averages
  const withNexusAvg = {
    userTurns: Math.round(avg(withNexus.map((s) => s.userTurns))),
    toolCalls: Math.round(avg(withNexus.map((s) => s.toolCalls))),
    durationMs: Math.round(avg(withNexus.map((s) => durationMs(s.startedAt, s.lastActivityAt)))),
  };

  const withoutNexusAvg = {
    userTurns: Math.round(avg(withoutNexus.map((s) => s.userTurns))),
    toolCalls: Math.round(avg(withoutNexus.map((s) => s.toolCalls))),
    durationMs: Math.round(avg(withoutNexus.map((s) => durationMs(s.startedAt, s.lastActivityAt)))),
  };

  // Daily adoption buckets
  const dailyMap = new Map<string, { withNexus: number; withoutNexus: number }>();
  for (const s of scanned) {
    const date = s.startedAt.slice(0, 10);
    const entry = dailyMap.get(date) ?? { withNexus: 0, withoutNexus: 0 };
    if (s.nexusToolCalls > 0) entry.withNexus++;
    else entry.withoutNexus++;
    dailyMap.set(date, entry);
  }
  const dailyAdoption = [...dailyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, counts]) => ({ date, ...counts }));

  // Top sessions
  const topNexusSessions = [...withNexus]
    .sort((a, b) => b.nexusToolCalls - a.nexusToolCalls)
    .slice(0, 10)
    .map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      nexusToolCalls: s.nexusToolCalls,
      userTurns: s.userTurns,
      toolCalls: s.toolCalls,
      startedAt: s.startedAt,
    }));

  return {
    totalSessions: scanned.length,
    sessionsWithNexus: withNexus.length,
    sessionsWithoutNexus: withoutNexus.length,
    nexusAdoptionRate: scanned.length > 0 ? withNexus.length / scanned.length : 0,
    toolUsageCounts,
    totalNexusToolCalls,
    withNexusAvg,
    withoutNexusAvg,
    dailyAdoption,
    topNexusSessions,
  };
}
