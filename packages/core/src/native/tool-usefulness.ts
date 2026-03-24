/**
 * Tool Usefulness Scanner
 *
 * Scans JSONL session files to correlate tool_use/tool_result pairs,
 * score each call on a 0-1 usefulness scale using four weighted heuristics,
 * and aggregate into dashboard-ready metrics.
 *
 * Supports two modes:
 * - Nexus-only: tracks nexus_* tools (original)
 * - All MCP: tracks all mcp__* tools including hub, plugins, etc.
 */

import fs from 'node:fs';
import path from 'node:path';
import { listSessions } from './session-reader.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UsefulnessSignal {
  type: 'result_content' | 'sequential_chain' | 'direct_reference' | 'result_substance';
  score: number;
  weight: number;
  detail?: string;
}

export interface NexusToolCallSummary {
  toolName: string;
  inputPreview: string;
  resultPreview: string;
  usefulnessScore: number;
  signals: UsefulnessSignal[];
  sessionId: string;
  timestamp: string;
}

export interface ToolUsefulnessAggregate {
  toolName: string;
  totalCalls: number;
  avgScore: number;
  emptyResultRate: number;
  followUpRate: number;
  referenceRate: number;
}

export interface ToolUsefulnessAnalytics {
  overallScore: number;
  totalToolCalls: number;
  byTool: ToolUsefulnessAggregate[];
  dailyScores: Array<{ date: string; avgScore: number; calls: number }>;
  topUseful: NexusToolCallSummary[];
  leastUseful: NexusToolCallSummary[];
}

export interface ServerToolAggregate {
  serverName: string;
  tools: ToolUsefulnessAggregate[];
  totalCalls: number;
  avgScore: number;
}

export interface McpToolAnalytics extends ToolUsefulnessAnalytics {
  byServer: ServerToolAggregate[];
}

// ─── Internal types ──────────────────────────────────────────────────────────

interface ToolCallDetail {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  resultText: string;
  resultLength: number;
  resultCount: number;
  hasResults: boolean;
  nextAssistantText: string;
  positionIndex: number;
  timestamp: string;
}

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

interface SessionUsefulnessResult {
  sessionId: string;
  cwd: string;
  startedAt: string;
  toolCalls: NexusToolCallSummary[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const NEXUS_TOOL_RE = /nexus_/;
const ALL_MCP_RE = /^mcp__/;
const MAX_RESULT_TEXT = 1000;
const MAX_ASSISTANT_TEXT = 500;
const MAX_INPUT_PREVIEW = 120;
const MAX_RESULT_PREVIEW = 200;

const SIGNAL_WEIGHTS = {
  result_content: 0.40,
  sequential_chain: 0.30,
  direct_reference: 0.20,
  result_substance: 0.10,
} as const;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her',
  'was', 'one', 'our', 'out', 'has', 'have', 'been', 'from', 'this',
  'that', 'with', 'they', 'will', 'each', 'make', 'like', 'long',
  'look', 'many', 'some', 'them', 'than', 'would', 'which', 'their',
  'said', 'what', 'about', 'into', 'more', 'other', 'time', 'very',
  'when', 'come', 'could', 'your', 'just', 'know', 'take', 'people',
  'found', 'results', 'project', 'note', 'notes', 'decision', 'pattern',
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractNexusToolName(fullName: string): string | null {
  const match = fullName.match(/(nexus_\w+)/);
  return match ? match[1]! : null;
}

/**
 * Extract server name and short tool name from full MCP tool name.
 * e.g. "mcp__hub__search" → { server: "hub", tool: "search" }
 * e.g. "mcp__nexus-local__nexus_query" → { server: "nexus-local", tool: "nexus_query" }
 * e.g. "mcp__plugin_discord_discord__reply" → { server: "plugin_discord_discord", tool: "reply" }
 */
export function extractMcpToolParts(fullName: string): { server: string; tool: string } | null {
  if (!fullName.startsWith('mcp__')) return null;
  // Find the last __ separator after the mcp__ prefix
  const withoutPrefix = fullName.slice(5); // skip "mcp__"
  const lastIdx = withoutPrefix.lastIndexOf('__');
  if (lastIdx <= 0) return null;
  return {
    server: withoutPrefix.slice(0, lastIdx),
    tool: withoutPrefix.slice(lastIdx + 2),
  };
}

function extractShortMcpName(fullName: string): string {
  const parts = extractMcpToolParts(fullName);
  if (parts) return `${parts.server}:${parts.tool}`;
  return fullName;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } =>
        typeof b === 'object' && b !== null && (b as Record<string, unknown>)['type'] === 'text')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '...' : s;
}

// ─── Result metrics parser ───────────────────────────────────────────────────

export function parseResultMetrics(toolName: string, resultText: string): { count: number; hasResults: boolean } {
  const lower = resultText.toLowerCase();

  if (toolName === 'nexus_query') {
    const match = resultText.match(/Found (\d+) results?/i);
    if (match) {
      const count = parseInt(match[1]!, 10);
      return { count, hasResults: count > 0 };
    }
    return { count: 0, hasResults: resultText.length > 100 };
  }

  if (toolName === 'nexus_note') {
    if (lower.includes('note saved') || lower.includes('note updated') || lower.includes('✓ note')) {
      return { count: 1, hasResults: true };
    }
    if (lower.includes('no notes found') || lower.includes('no note found')) {
      return { count: 0, hasResults: false };
    }
    const noteMatch = resultText.match(/\((\d+)\)/);
    if (noteMatch) {
      const count = parseInt(noteMatch[1]!, 10);
      return { count, hasResults: count > 0 };
    }
    return { count: resultText.length > 50 ? 1 : 0, hasResults: resultText.length > 50 };
  }

  if (toolName === 'nexus_decide' || toolName === 'nexus_record_pattern') {
    if (lower.includes('error') || lower.includes('failed')) {
      return { count: 0, hasResults: false };
    }
    return { count: 1, hasResults: true };
  }

  if (toolName === 'nexus_check_conflicts') {
    return { count: resultText.length > 100 ? 1 : 0, hasResults: true };
  }

  if (toolName === 'nexus_pattern') {
    const match = resultText.match(/(\d+) pattern/i);
    if (match) {
      const count = parseInt(match[1]!, 10);
      return { count, hasResults: count > 0 };
    }
    return { count: resultText.length > 100 ? 1 : 0, hasResults: resultText.length > 100 };
  }

  // Fallback for nexus_dependencies, nexus_preferences, etc.
  return { count: resultText.length > 50 ? 1 : 0, hasResults: resultText.length > 50 };
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

function scoreResultContent(detail: ToolCallDetail): number {
  const { toolName, hasResults, resultCount } = detail;

  if (toolName === 'nexus_query') {
    return hasResults ? Math.min(resultCount / 5, 1.0) : 0;
  }
  if (toolName === 'nexus_decide' || toolName === 'nexus_record_pattern' || toolName === 'nexus_note') {
    return hasResults ? 1.0 : 0;
  }
  if (toolName === 'nexus_check_conflicts') {
    return hasResults ? 0.7 : 0.5;
  }
  return hasResults ? 0.6 : 0;
}

function scoreSequentialChain(detail: ToolCallDetail, allCalls: ToolCallDetail[]): number {
  const lookAhead = 5;
  const startIdx = detail.positionIndex + 1;
  const endIdx = Math.min(detail.positionIndex + lookAhead + 1, allCalls.length);

  for (let i = startIdx; i < endIdx; i++) {
    if (allCalls[i]) return 1.0;
  }
  return 0;
}

function scoreDirectReference(detail: ToolCallDetail): number {
  if (!detail.nextAssistantText || !detail.resultText) return 0;

  const resultWords = detail.resultText
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 6 && !STOPWORDS.has(w));

  const uniqueWords = [...new Set(resultWords)].slice(0, 10);
  if (uniqueWords.length === 0) return 0;

  const assistantLower = detail.nextAssistantText.toLowerCase();
  let matches = 0;
  for (const word of uniqueWords) {
    if (assistantLower.includes(word)) matches++;
  }

  return Math.min(matches / 3, 1.0);
}

function scoreResultSubstance(detail: ToolCallDetail): number {
  if (detail.resultLength === 0) return 0;
  return Math.min(detail.resultLength / 2000, 1.0);
}

export function scoreToolCall(detail: ToolCallDetail, allCalls: ToolCallDetail[]): {
  score: number;
  signals: UsefulnessSignal[];
} {
  const signals: UsefulnessSignal[] = [
    {
      type: 'result_content',
      weight: SIGNAL_WEIGHTS.result_content,
      score: scoreResultContent(detail),
      detail: detail.hasResults ? `${detail.resultCount} results` : 'no results',
    },
    {
      type: 'sequential_chain',
      weight: SIGNAL_WEIGHTS.sequential_chain,
      score: scoreSequentialChain(detail, allCalls),
      detail: scoreSequentialChain(detail, allCalls) > 0 ? 'followed by nexus call' : 'isolated call',
    },
    {
      type: 'direct_reference',
      weight: SIGNAL_WEIGHTS.direct_reference,
      score: scoreDirectReference(detail),
    },
    {
      type: 'result_substance',
      weight: SIGNAL_WEIGHTS.result_substance,
      score: scoreResultSubstance(detail),
      detail: `${detail.resultLength} chars`,
    },
  ];

  const score = signals.reduce((sum, s) => sum + s.weight * s.score, 0);
  return { score, signals };
}

// ─── Session scanner ─────────────────────────────────────────────────────────

export function scanSessionToolUsefulness(jsonlPath: string): SessionUsefulnessResult | null {
  let fileContent: string;
  try {
    fileContent = fs.readFileSync(jsonlPath, 'utf-8');
  } catch {
    return null;
  }

  let sessionId = '';
  let cwd = '';
  let startedAt = '';

  const pendingToolUses = new Map<string, { name: string; shortName: string; input: Record<string, unknown>; timestamp: string }>();
  const completedCalls: ToolCallDetail[] = [];
  let awaitingNextAssistantIdx: number | null = null;

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
    if (!parsed.uuid || !parsed.timestamp) continue;

    if (!sessionId && parsed.sessionId) sessionId = parsed.sessionId;
    if (!cwd && parsed.cwd) cwd = parsed.cwd;
    if (!startedAt) startedAt = parsed.timestamp;

    const role = parsed.message?.role;
    const content = parsed.message?.content;
    if (!role || !content) continue;

    const contentArr: unknown[] = Array.isArray(content) ? content : [];

    if (role === 'assistant') {
      // Fill nextAssistantText for the most recent completed call
      if (awaitingNextAssistantIdx !== null) {
        const textBlocks = contentArr
          .filter((b): b is { type: string; text: string } =>
            typeof b === 'object' && b !== null && (b as Record<string, unknown>)['type'] === 'text')
          .map((b) => b.text)
          .join('\n');
        if (textBlocks && completedCalls[awaitingNextAssistantIdx]) {
          completedCalls[awaitingNextAssistantIdx]!.nextAssistantText = trunc(textBlocks, MAX_ASSISTANT_TEXT);
        }
        awaitingNextAssistantIdx = null;
      }

      // Collect nexus tool_use blocks
      for (const block of contentArr) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b['type'] !== 'tool_use') continue;

        const name = b['name'] as string;
        if (!name || !NEXUS_TOOL_RE.test(name)) continue;

        const shortName = extractNexusToolName(name) ?? name;
        const toolUseId = b['id'] as string;
        const input = (b['input'] as Record<string, unknown>) ?? {};

        pendingToolUses.set(toolUseId, {
          name,
          shortName,
          input,
          timestamp: parsed.timestamp,
        });
      }
    } else if (role === 'user') {
      // Match tool_result blocks to pending tool_uses
      for (const block of contentArr) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b['type'] !== 'tool_result') continue;

        const toolUseId = b['tool_use_id'] as string;
        if (!toolUseId) continue;

        const pending = pendingToolUses.get(toolUseId);
        if (!pending) continue;

        const resultText = trunc(extractTextFromContent(b['content']), MAX_RESULT_TEXT);
        const { count, hasResults } = parseResultMetrics(pending.shortName, resultText);

        completedCalls.push({
          toolUseId,
          toolName: pending.shortName,
          input: pending.input,
          resultText,
          resultLength: resultText.length,
          resultCount: count,
          hasResults,
          nextAssistantText: '',
          positionIndex: completedCalls.length,
          timestamp: pending.timestamp,
        });

        awaitingNextAssistantIdx = completedCalls.length - 1;
        pendingToolUses.delete(toolUseId);
      }
    }
  }

  if (completedCalls.length === 0) return null;

  const toolCalls: NexusToolCallSummary[] = completedCalls.map((detail) => {
    const { score, signals } = scoreToolCall(detail, completedCalls);
    return {
      toolName: detail.toolName,
      inputPreview: trunc(JSON.stringify(detail.input), MAX_INPUT_PREVIEW),
      resultPreview: trunc(detail.resultText, MAX_RESULT_PREVIEW),
      usefulnessScore: Math.round(score * 100) / 100,
      signals,
      sessionId: sessionId || path.basename(jsonlPath, '.jsonl'),
      timestamp: detail.timestamp,
    };
  });

  return {
    sessionId: sessionId || path.basename(jsonlPath, '.jsonl'),
    cwd,
    startedAt,
    toolCalls,
  };
}

// ─── Aggregator ──────────────────────────────────────────────────────────────

export interface ComputeUsefulnessOptions {
  sinceDays?: number;
}

export async function computeToolUsefulnessAnalytics(
  claudeDir: string,
  opts: ComputeUsefulnessOptions = {},
): Promise<ToolUsefulnessAnalytics> {
  const sessions = await listSessions(claudeDir);

  const cutoff = opts.sinceDays
    ? new Date(Date.now() - opts.sinceDays * 86400000).toISOString()
    : undefined;

  const filtered = cutoff
    ? sessions.filter((s) => s.startedAt >= cutoff)
    : sessions;

  const allCalls: NexusToolCallSummary[] = [];
  const dailyMap = new Map<string, { totalScore: number; count: number }>();

  for (const s of filtered) {
    const result = scanSessionToolUsefulness(s.jsonlPath);
    if (!result) continue;

    for (const call of result.toolCalls) {
      allCalls.push(call);

      const date = call.timestamp.slice(0, 10);
      const entry = dailyMap.get(date) ?? { totalScore: 0, count: 0 };
      entry.totalScore += call.usefulnessScore;
      entry.count++;
      dailyMap.set(date, entry);
    }
  }

  if (allCalls.length === 0) {
    return {
      overallScore: 0,
      totalToolCalls: 0,
      byTool: [],
      dailyScores: [],
      topUseful: [],
      leastUseful: [],
    };
  }

  // Overall score
  const overallScore = Math.round(
    (allCalls.reduce((s, c) => s + c.usefulnessScore, 0) / allCalls.length) * 100,
  ) / 100;

  // Per-tool aggregates
  const toolMap = new Map<string, { scores: number[]; emptyCount: number; chainCount: number; refCount: number }>();
  for (const call of allCalls) {
    const entry = toolMap.get(call.toolName) ?? { scores: [], emptyCount: 0, chainCount: 0, refCount: 0 };
    entry.scores.push(call.usefulnessScore);

    const resultSignal = call.signals.find((s) => s.type === 'result_content');
    if (resultSignal && resultSignal.score === 0) entry.emptyCount++;

    const chainSignal = call.signals.find((s) => s.type === 'sequential_chain');
    if (chainSignal && chainSignal.score > 0) entry.chainCount++;

    const refSignal = call.signals.find((s) => s.type === 'direct_reference');
    if (refSignal && refSignal.score > 0) entry.refCount++;

    toolMap.set(call.toolName, entry);
  }

  const byTool: ToolUsefulnessAggregate[] = [...toolMap.entries()]
    .map(([toolName, { scores, emptyCount, chainCount, refCount }]) => ({
      toolName,
      totalCalls: scores.length,
      avgScore: Math.round((scores.reduce((s, v) => s + v, 0) / scores.length) * 100) / 100,
      emptyResultRate: Math.round((emptyCount / scores.length) * 100) / 100,
      followUpRate: Math.round((chainCount / scores.length) * 100) / 100,
      referenceRate: Math.round((refCount / scores.length) * 100) / 100,
    }))
    .sort((a, b) => b.avgScore - a.avgScore);

  // Daily scores
  const dailyScores = [...dailyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, { totalScore, count }]) => ({
      date,
      avgScore: Math.round((totalScore / count) * 100) / 100,
      calls: count,
    }));

  // Top and bottom calls
  const sorted = [...allCalls].sort((a, b) => b.usefulnessScore - a.usefulnessScore);
  const topUseful = sorted.slice(0, 10);
  const leastUseful = sorted.slice(-10).reverse();

  return {
    overallScore,
    totalToolCalls: allCalls.length,
    byTool,
    dailyScores,
    topUseful,
    leastUseful,
  };
}

// ─── All-MCP Tool Scanner ────────────────────────────────────────────────────

/**
 * Scan a session for ALL MCP tool calls (mcp__*), not just nexus_*.
 * Uses the same scoring and correlation logic as the nexus scanner.
 */
export function scanSessionAllMcpTools(jsonlPath: string): SessionUsefulnessResult | null {
  let fileContent: string;
  try {
    fileContent = fs.readFileSync(jsonlPath, 'utf-8');
  } catch {
    return null;
  }

  let sessionId = '';
  let cwd = '';
  let startedAt = '';

  const pendingToolUses = new Map<string, { name: string; shortName: string; input: Record<string, unknown>; timestamp: string }>();
  const completedCalls: ToolCallDetail[] = [];
  let awaitingNextAssistantIdx: number | null = null;

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
    if (!parsed.uuid || !parsed.timestamp) continue;

    if (!sessionId && parsed.sessionId) sessionId = parsed.sessionId;
    if (!cwd && parsed.cwd) cwd = parsed.cwd;
    if (!startedAt) startedAt = parsed.timestamp;

    const role = parsed.message?.role;
    const content = parsed.message?.content;
    if (!role || !content) continue;

    const contentArr: unknown[] = Array.isArray(content) ? content : [];

    if (role === 'assistant') {
      if (awaitingNextAssistantIdx !== null) {
        const textBlocks = contentArr
          .filter((b): b is { type: string; text: string } =>
            typeof b === 'object' && b !== null && (b as Record<string, unknown>)['type'] === 'text')
          .map((b) => b.text)
          .join('\n');
        if (textBlocks && completedCalls[awaitingNextAssistantIdx]) {
          completedCalls[awaitingNextAssistantIdx]!.nextAssistantText = trunc(textBlocks, MAX_ASSISTANT_TEXT);
        }
        awaitingNextAssistantIdx = null;
      }

      for (const block of contentArr) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b['type'] !== 'tool_use') continue;

        const name = b['name'] as string;
        if (!name || !ALL_MCP_RE.test(name)) continue;

        const shortName = extractShortMcpName(name);
        const toolUseId = b['id'] as string;
        const input = (b['input'] as Record<string, unknown>) ?? {};

        pendingToolUses.set(toolUseId, { name, shortName, input, timestamp: parsed.timestamp });
      }
    } else if (role === 'user') {
      for (const block of contentArr) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b['type'] !== 'tool_result') continue;

        const toolUseId = b['tool_use_id'] as string;
        if (!toolUseId) continue;

        const pending = pendingToolUses.get(toolUseId);
        if (!pending) continue;

        const resultText = trunc(extractTextFromContent(b['content']), MAX_RESULT_TEXT);
        // Use nexus-specific parsing for nexus tools, generic for others
        const nexusName = extractNexusToolName(pending.name);
        const { count, hasResults } = nexusName
          ? parseResultMetrics(nexusName, resultText)
          : parseResultMetrics(pending.shortName, resultText);

        completedCalls.push({
          toolUseId,
          toolName: pending.shortName,
          input: pending.input,
          resultText,
          resultLength: resultText.length,
          resultCount: count,
          hasResults,
          nextAssistantText: '',
          positionIndex: completedCalls.length,
          timestamp: pending.timestamp,
        });

        awaitingNextAssistantIdx = completedCalls.length - 1;
        pendingToolUses.delete(toolUseId);
      }
    }
  }

  if (completedCalls.length === 0) return null;

  const toolCalls: NexusToolCallSummary[] = completedCalls.map((detail) => {
    const { score, signals } = scoreToolCall(detail, completedCalls);
    return {
      toolName: detail.toolName,
      inputPreview: trunc(JSON.stringify(detail.input), MAX_INPUT_PREVIEW),
      resultPreview: trunc(detail.resultText, MAX_RESULT_PREVIEW),
      usefulnessScore: Math.round(score * 100) / 100,
      signals,
      sessionId: sessionId || path.basename(jsonlPath, '.jsonl'),
      timestamp: detail.timestamp,
    };
  });

  return {
    sessionId: sessionId || path.basename(jsonlPath, '.jsonl'),
    cwd,
    startedAt,
    toolCalls,
  };
}

// ─── All-MCP Aggregator ──────────────────────────────────────────────────────

function buildByServer(byTool: ToolUsefulnessAggregate[]): ServerToolAggregate[] {
  const serverMap = new Map<string, ToolUsefulnessAggregate[]>();

  for (const tool of byTool) {
    const colonIdx = tool.toolName.indexOf(':');
    const server = colonIdx > 0 ? tool.toolName.slice(0, colonIdx) : 'other';
    const existing = serverMap.get(server) ?? [];
    existing.push(tool);
    serverMap.set(server, existing);
  }

  return [...serverMap.entries()]
    .map(([serverName, tools]) => {
      const totalCalls = tools.reduce((s, t) => s + t.totalCalls, 0);
      const avgScore = totalCalls > 0
        ? Math.round((tools.reduce((s, t) => s + t.avgScore * t.totalCalls, 0) / totalCalls) * 100) / 100
        : 0;
      return { serverName, tools, totalCalls, avgScore };
    })
    .sort((a, b) => b.totalCalls - a.totalCalls);
}

export async function computeAllMcpToolAnalytics(
  claudeDir: string,
  opts: ComputeUsefulnessOptions = {},
): Promise<McpToolAnalytics> {
  const sessions = await listSessions(claudeDir);

  const cutoff = opts.sinceDays
    ? new Date(Date.now() - opts.sinceDays * 86400000).toISOString()
    : undefined;

  const filtered = cutoff
    ? sessions.filter((s) => s.startedAt >= cutoff)
    : sessions;

  const allCalls: NexusToolCallSummary[] = [];
  const dailyMap = new Map<string, { totalScore: number; count: number }>();

  for (const s of filtered) {
    const result = scanSessionAllMcpTools(s.jsonlPath);
    if (!result) continue;

    for (const call of result.toolCalls) {
      allCalls.push(call);
      const date = call.timestamp.slice(0, 10);
      const entry = dailyMap.get(date) ?? { totalScore: 0, count: 0 };
      entry.totalScore += call.usefulnessScore;
      entry.count++;
      dailyMap.set(date, entry);
    }
  }

  if (allCalls.length === 0) {
    return {
      overallScore: 0,
      totalToolCalls: 0,
      byTool: [],
      byServer: [],
      dailyScores: [],
      topUseful: [],
      leastUseful: [],
    };
  }

  const overallScore = Math.round(
    (allCalls.reduce((s, c) => s + c.usefulnessScore, 0) / allCalls.length) * 100,
  ) / 100;

  const toolMap = new Map<string, { scores: number[]; emptyCount: number; chainCount: number; refCount: number }>();
  for (const call of allCalls) {
    const entry = toolMap.get(call.toolName) ?? { scores: [], emptyCount: 0, chainCount: 0, refCount: 0 };
    entry.scores.push(call.usefulnessScore);

    const resultSignal = call.signals.find((s) => s.type === 'result_content');
    if (resultSignal && resultSignal.score === 0) entry.emptyCount++;

    const chainSignal = call.signals.find((s) => s.type === 'sequential_chain');
    if (chainSignal && chainSignal.score > 0) entry.chainCount++;

    const refSignal = call.signals.find((s) => s.type === 'direct_reference');
    if (refSignal && refSignal.score > 0) entry.refCount++;

    toolMap.set(call.toolName, entry);
  }

  const byTool: ToolUsefulnessAggregate[] = [...toolMap.entries()]
    .map(([toolName, { scores, emptyCount, chainCount, refCount }]) => ({
      toolName,
      totalCalls: scores.length,
      avgScore: Math.round((scores.reduce((s, v) => s + v, 0) / scores.length) * 100) / 100,
      emptyResultRate: Math.round((emptyCount / scores.length) * 100) / 100,
      followUpRate: Math.round((chainCount / scores.length) * 100) / 100,
      referenceRate: Math.round((refCount / scores.length) * 100) / 100,
    }))
    .sort((a, b) => b.avgScore - a.avgScore);

  const byServer = buildByServer(byTool);

  const dailyScores = [...dailyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, { totalScore, count }]) => ({
      date,
      avgScore: Math.round((totalScore / count) * 100) / 100,
      calls: count,
    }));

  const sorted = [...allCalls].sort((a, b) => b.usefulnessScore - a.usefulnessScore);

  return {
    overallScore,
    totalToolCalls: allCalls.length,
    byTool,
    byServer,
    dailyScores,
    topUseful: sorted.slice(0, 10),
    leastUseful: sorted.slice(-10).reverse(),
  };
}
