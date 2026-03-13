import fs from 'node:fs';
import { listSessions } from './session-reader.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TokenUsageByModel {
  model: string;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  requestCount: number;
}

export interface SessionTokenUsage {
  sessionId: string;
  cwd: string;
  slug?: string;
  startedAt: string;
  models: TokenUsageByModel[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheWriteTokens: number;
  totalCacheReadTokens: number;
  totalEstimatedCostUsd: number;
  requestCount: number;
  userTurns: number;
  toolCalls: number;
}

export interface TokenAnalytics {
  totalEstimatedCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheWriteTokens: number;
  totalCacheReadTokens: number;
  totalRequests: number;
  byModel: TokenUsageByModel[];
  byDay: Array<{
    date: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    estimatedCostUsd: number;
    requestCount: number;
  }>;
  byProject: Array<{
    project: string;
    cwd: string;
    estimatedCostUsd: number;
    totalTokens: number;
    requestCount: number;
  }>;
  topSessions: SessionTokenUsage[];
  cacheSavingsUsd: number;
  efficiency: EfficiencyMetrics;
}

export interface ProjectEfficiency {
  project: string;
  cwd: string;
  sessions: number;
  avgCostPerSession: number;
  avgCostPerTurn: number;
  avgTokensPerTurn: number;
  avgOutputPerInput: number;
  cacheHitRate: number;
  avgTurnsPerSession: number;
  avgToolCallsPerSession: number;
  totalCost: number;
}

export interface EfficiencyMetrics {
  avgCostPerTurn: number;
  avgTokensPerTurn: number;
  avgOutputPerInput: number;
  cacheHitRate: number;
  avgTurnsPerSession: number;
  avgToolCallsPerSession: number;
  avgCostPerSession: number;
  totalSessions: number;
  totalUserTurns: number;
  totalToolCalls: number;
  byProject: ProjectEfficiency[];
}

// ─── Pricing (per million tokens) ────────────────────────────────────────────

export interface ModelPricing {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  // Opus 4.6 / 4.5
  'claude-opus-4-6': { input: 5, cacheWrite: 10, cacheRead: 0.5, output: 25 },
  'claude-opus-4-5-20250220': { input: 5, cacheWrite: 10, cacheRead: 0.5, output: 25 },
  // Opus 4.1 / 4
  'claude-opus-4-1': { input: 15, cacheWrite: 30, cacheRead: 1.5, output: 75 },
  'claude-4-opus-20250514': { input: 15, cacheWrite: 30, cacheRead: 1.5, output: 75 },
  // Sonnet 4.6 / 4.5 / 4
  'claude-sonnet-4-6': { input: 3, cacheWrite: 6, cacheRead: 0.3, output: 15 },
  'claude-sonnet-4-5-20250514': { input: 3, cacheWrite: 6, cacheRead: 0.3, output: 15 },
  'claude-sonnet-4-20250514': { input: 3, cacheWrite: 6, cacheRead: 0.3, output: 15 },
  // Haiku 4.5
  'claude-haiku-4-5-20251001': { input: 1, cacheWrite: 2, cacheRead: 0.1, output: 5 },
};

const DEFAULT_PRICING: ModelPricing = { input: 3, cacheWrite: 6, cacheRead: 0.3, output: 15 };

export function getPricing(model: string): ModelPricing {
  const exact = MODEL_PRICING[model];
  if (exact) return exact;
  // Fuzzy match
  const lower = model.toLowerCase();
  if (lower.includes('opus') && (lower.includes('4-6') || lower.includes('4-5') || lower.includes('4.6') || lower.includes('4.5'))) {
    return MODEL_PRICING['claude-opus-4-6']!;
  }
  if (lower.includes('opus')) return MODEL_PRICING['claude-opus-4-1']!;
  if (lower.includes('sonnet')) return MODEL_PRICING['claude-sonnet-4-6']!;
  if (lower.includes('haiku')) return MODEL_PRICING['claude-haiku-4-5-20251001']!;
  return DEFAULT_PRICING;
}

export function calculateCost(
  pricing: ModelPricing,
  input: number,
  cacheWrite: number,
  cacheRead: number,
  output: number,
): number {
  return (
    (input * pricing.input +
      cacheWrite * pricing.cacheWrite +
      cacheRead * pricing.cacheRead +
      output * pricing.output) /
    1_000_000
  );
}

// ─── JSONL line shape ────────────────────────────────────────────────────────

interface RawTokenLine {
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

// ─── Session token scanner ───────────────────────────────────────────────────

interface SessionTokenRaw {
  sessionId: string;
  cwd: string;
  slug?: string;
  startedAt: string;
  modelAccum: Map<string, { input: number; cacheWrite: number; cacheRead: number; output: number; count: number }>;
  timestamps: string[];
  userTurns: number;
  toolCalls: number;
}

function scanSessionTokens(jsonlPath: string): SessionTokenRaw | null {
  let content: string;
  try {
    content = fs.readFileSync(jsonlPath, 'utf-8');
  } catch {
    return null;
  }

  let sessionId = '';
  let cwd = '';
  let startedAt = '';
  const modelAccum = new Map<string, { input: number; cacheWrite: number; cacheRead: number; output: number; count: number }>();
  const timestamps: string[] = [];
  let userTurns = 0;
  let toolCalls = 0;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: RawTokenLine;
    try {
      parsed = JSON.parse(trimmed) as RawTokenLine;
    } catch {
      continue;
    }

    if (parsed.type === 'progress') continue;
    if (!parsed.uuid) continue;

    if (!sessionId && parsed.sessionId) sessionId = parsed.sessionId;
    if (!cwd && parsed.cwd) cwd = parsed.cwd;
    if (!startedAt && parsed.timestamp) startedAt = parsed.timestamp;

    const msg = parsed.message;
    if (!msg) continue;

    // Count user turns (exclude tool_result messages)
    if (msg.role === 'user') {
      const contentArr: unknown[] = Array.isArray(msg.content) ? msg.content : [];
      const isToolResult = contentArr.some(
        (b): b is Record<string, unknown> =>
          typeof b === 'object' && b !== null &&
          (b as Record<string, unknown>)['type'] === 'tool_result',
      );
      if (!isToolResult) userTurns++;
      continue;
    }

    if (msg.role !== 'assistant') continue;

    // Count tool calls from assistant content
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (
          typeof block === 'object' && block !== null &&
          (block as Record<string, unknown>)['type'] === 'tool_use'
        ) {
          toolCalls++;
        }
      }
    }

    if (!msg.usage) continue;

    const model = msg.model ?? 'unknown';
    const usage = msg.usage;
    const input = usage.input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;

    if (input === 0 && cacheWrite === 0 && cacheRead === 0 && output === 0) continue;

    const acc = modelAccum.get(model) ?? { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, count: 0 };
    acc.input += input;
    acc.cacheWrite += cacheWrite;
    acc.cacheRead += cacheRead;
    acc.output += output;
    acc.count += 1;
    modelAccum.set(model, acc);

    if (parsed.timestamp) timestamps.push(parsed.timestamp);
  }

  if (modelAccum.size === 0) return null;

  return { sessionId: sessionId || jsonlPath, cwd, startedAt, modelAccum, timestamps, userTurns, toolCalls };
}

// ─── Aggregate analytics ─────────────────────────────────────────────────────

export interface ComputeTokenAnalyticsOptions {
  sinceDays?: number;
}

export async function computeTokenAnalytics(
  claudeDir: string,
  opts: ComputeTokenAnalyticsOptions = {},
): Promise<TokenAnalytics> {
  const sessions = await listSessions(claudeDir);

  const cutoff = opts.sinceDays
    ? new Date(Date.now() - opts.sinceDays * 86400000).toISOString()
    : undefined;

  const filtered = cutoff
    ? sessions.filter((s) => s.startedAt >= cutoff)
    : sessions;

  // Scan all sessions
  const scanned: SessionTokenRaw[] = [];
  for (const s of filtered) {
    const result = scanSessionTokens(s.jsonlPath);
    if (result) scanned.push(result);
  }

  // Aggregate by model
  const globalModel = new Map<string, { input: number; cacheWrite: number; cacheRead: number; output: number; count: number }>();
  // Aggregate by day
  const dailyMap = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; count: number }>();
  // Aggregate by project (cwd)
  const projectMap = new Map<string, { cwd: string; cost: number; tokens: number; count: number }>();

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheWrite = 0;
  let totalCacheRead = 0;
  let totalCost = 0;
  let totalRequests = 0;
  let totalCacheSavings = 0;

  const sessionUsages: SessionTokenUsage[] = [];

  for (const raw of scanned) {
    let sessionCost = 0;
    let sessionInput = 0;
    let sessionOutput = 0;
    let sessionCacheWrite = 0;
    let sessionCacheRead = 0;
    let sessionRequests = 0;
    const sessionModels: TokenUsageByModel[] = [];

    for (const [model, acc] of raw.modelAccum) {
      const pricing = getPricing(model);
      const cost = calculateCost(pricing, acc.input, acc.cacheWrite, acc.cacheRead, acc.output);

      // Cache savings: what it would have cost at full input price
      const cacheSavings = (acc.cacheRead * (pricing.input - pricing.cacheRead)) / 1_000_000;
      totalCacheSavings += cacheSavings;

      sessionModels.push({
        model,
        inputTokens: acc.input,
        cacheWriteTokens: acc.cacheWrite,
        cacheReadTokens: acc.cacheRead,
        outputTokens: acc.output,
        estimatedCostUsd: cost,
        requestCount: acc.count,
      });

      sessionCost += cost;
      sessionInput += acc.input;
      sessionOutput += acc.output;
      sessionCacheWrite += acc.cacheWrite;
      sessionCacheRead += acc.cacheRead;
      sessionRequests += acc.count;

      // Global model aggregation
      const gm = globalModel.get(model) ?? { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, count: 0 };
      gm.input += acc.input;
      gm.cacheWrite += acc.cacheWrite;
      gm.cacheRead += acc.cacheRead;
      gm.output += acc.output;
      gm.count += acc.count;
      globalModel.set(model, gm);
    }

    totalInput += sessionInput;
    totalOutput += sessionOutput;
    totalCacheWrite += sessionCacheWrite;
    totalCacheRead += sessionCacheRead;
    totalCost += sessionCost;
    totalRequests += sessionRequests;

    sessionUsages.push({
      sessionId: raw.sessionId,
      cwd: raw.cwd,
      startedAt: raw.startedAt,
      models: sessionModels,
      totalInputTokens: sessionInput,
      totalOutputTokens: sessionOutput,
      totalCacheWriteTokens: sessionCacheWrite,
      totalCacheReadTokens: sessionCacheRead,
      totalEstimatedCostUsd: sessionCost,
      requestCount: sessionRequests,
      userTurns: raw.userTurns,
      toolCalls: raw.toolCalls,
    });

    // Daily aggregation
    const date = raw.startedAt.slice(0, 10);
    const day = dailyMap.get(date) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, count: 0 };
    day.input += sessionInput;
    day.output += sessionOutput;
    day.cacheRead += sessionCacheRead;
    day.cacheWrite += sessionCacheWrite;
    day.cost += sessionCost;
    day.count += sessionRequests;
    dailyMap.set(date, day);

    // Project aggregation
    const projectName = raw.cwd.split(/[/\\]/).pop() ?? raw.cwd;
    const proj = projectMap.get(raw.cwd) ?? { cwd: raw.cwd, cost: 0, tokens: 0, count: 0 };
    proj.cost += sessionCost;
    proj.tokens += sessionInput + sessionOutput + sessionCacheWrite + sessionCacheRead;
    proj.count += sessionRequests;
    projectMap.set(raw.cwd, proj);
  }

  // Build byModel
  const byModel: TokenUsageByModel[] = [...globalModel.entries()]
    .map(([model, acc]) => {
      const pricing = getPricing(model);
      return {
        model,
        inputTokens: acc.input,
        cacheWriteTokens: acc.cacheWrite,
        cacheReadTokens: acc.cacheRead,
        outputTokens: acc.output,
        estimatedCostUsd: calculateCost(pricing, acc.input, acc.cacheWrite, acc.cacheRead, acc.output),
        requestCount: acc.count,
      };
    })
    .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);

  // Build byDay
  const byDay = [...dailyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({
      date,
      inputTokens: d.input,
      outputTokens: d.output,
      cacheReadTokens: d.cacheRead,
      cacheWriteTokens: d.cacheWrite,
      estimatedCostUsd: d.cost,
      requestCount: d.count,
    }));

  // Build byProject
  const byProject = [...projectMap.entries()]
    .map(([, p]) => ({
      project: p.cwd.split(/[/\\]/).pop() ?? p.cwd,
      cwd: p.cwd,
      estimatedCostUsd: p.cost,
      totalTokens: p.tokens,
      requestCount: p.count,
    }))
    .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);

  // Top 15 sessions by cost
  const topSessions = [...sessionUsages]
    .sort((a, b) => b.totalEstimatedCostUsd - a.totalEstimatedCostUsd)
    .slice(0, 15);

  // ─── Efficiency metrics ──────────────────────────────────────────────────
  const totalUserTurns = sessionUsages.reduce((s, u) => s + u.userTurns, 0);
  const totalToolCalls = sessionUsages.reduce((s, u) => s + u.toolCalls, 0);
  const totalAllInput = totalInput + totalCacheWrite + totalCacheRead;

  // Per-project efficiency
  const projEffMap = new Map<string, {
    cwd: string; sessions: number; cost: number; turns: number; tools: number;
    input: number; output: number; cacheRead: number; cacheWrite: number; totalInput: number;
  }>();

  for (const su of sessionUsages) {
    const key = su.cwd;
    const pe = projEffMap.get(key) ?? {
      cwd: su.cwd, sessions: 0, cost: 0, turns: 0, tools: 0,
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalInput: 0,
    };
    pe.sessions += 1;
    pe.cost += su.totalEstimatedCostUsd;
    pe.turns += su.userTurns;
    pe.tools += su.toolCalls;
    pe.input += su.totalInputTokens;
    pe.output += su.totalOutputTokens;
    pe.cacheRead += su.totalCacheReadTokens;
    pe.cacheWrite += su.totalCacheWriteTokens;
    pe.totalInput += su.totalInputTokens + su.totalCacheWriteTokens + su.totalCacheReadTokens;
    projEffMap.set(key, pe);
  }

  const effByProject: ProjectEfficiency[] = [...projEffMap.entries()]
    .map(([, pe]) => ({
      project: pe.cwd.split(/[/\\]/).pop() ?? pe.cwd,
      cwd: pe.cwd,
      sessions: pe.sessions,
      avgCostPerSession: pe.sessions > 0 ? pe.cost / pe.sessions : 0,
      avgCostPerTurn: pe.turns > 0 ? pe.cost / pe.turns : 0,
      avgTokensPerTurn: pe.turns > 0 ? (pe.input + pe.output + pe.cacheRead + pe.cacheWrite) / pe.turns : 0,
      avgOutputPerInput: pe.totalInput > 0 ? pe.output / pe.totalInput : 0,
      cacheHitRate: pe.totalInput > 0 ? (pe.cacheRead / pe.totalInput) * 100 : 0,
      avgTurnsPerSession: pe.sessions > 0 ? pe.turns / pe.sessions : 0,
      avgToolCallsPerSession: pe.sessions > 0 ? pe.tools / pe.sessions : 0,
      totalCost: pe.cost,
    }))
    .sort((a, b) => b.sessions - a.sessions);

  const numSessions = sessionUsages.length;

  const efficiency: EfficiencyMetrics = {
    avgCostPerTurn: totalUserTurns > 0 ? totalCost / totalUserTurns : 0,
    avgTokensPerTurn: totalUserTurns > 0 ? (totalInput + totalOutput + totalCacheWrite + totalCacheRead) / totalUserTurns : 0,
    avgOutputPerInput: totalAllInput > 0 ? totalOutput / totalAllInput : 0,
    cacheHitRate: totalAllInput > 0 ? (totalCacheRead / totalAllInput) * 100 : 0,
    avgTurnsPerSession: numSessions > 0 ? totalUserTurns / numSessions : 0,
    avgToolCallsPerSession: numSessions > 0 ? totalToolCalls / numSessions : 0,
    avgCostPerSession: numSessions > 0 ? totalCost / numSessions : 0,
    totalSessions: numSessions,
    totalUserTurns,
    totalToolCalls,
    byProject: effByProject,
  };

  return {
    totalEstimatedCostUsd: totalCost,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCacheWriteTokens: totalCacheWrite,
    totalCacheReadTokens: totalCacheRead,
    totalRequests,
    byModel,
    byDay,
    byProject,
    topSessions,
    cacheSavingsUsd: totalCacheSavings,
    efficiency,
  };
}
