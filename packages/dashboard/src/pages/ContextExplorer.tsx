import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import {
  api,
  type NativeSession,
  type SessionTokenDetail,
  type TimelineMessage,
  type MessageSource,
  type ContextOverhead,
} from '../api.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const SOURCE_COLORS: Record<MessageSource, string> = {
  system_context: '#58a6ff',
  hook_injection: '#bc8cff',
  user_message: '#3fb950',
  tool_result: '#d29922',
  assistant_text: '#8b949e',
  assistant_tool: '#f0883e',
  assistant_mixed: '#f85149',
};

const MODEL_BADGES: Record<string, { color: string; label: string }> = {
  'claude-opus-4-6': { color: '#bc8cff', label: 'Opus 4.6' },
  'claude-opus-4-5-20250220': { color: '#bc8cff', label: 'Opus 4.5' },
  'claude-opus-4-1': { color: '#bc8cff', label: 'Opus 4.1' },
  'claude-sonnet-4-6': { color: '#58a6ff', label: 'Sonnet 4.6' },
  'claude-sonnet-4-5-20241022': { color: '#58a6ff', label: 'Sonnet 4.5' },
  'claude-sonnet-4-1-20250414': { color: '#58a6ff', label: 'Sonnet 4.1' },
  'claude-haiku-4-5-20251001': { color: '#3fb950', label: 'Haiku 4.5' },
};

// ─── Formatters ─────────────────────────────────────────────────────────────

function fmtCost(usd: number): string {
  if (usd < 0.001) return '<$0.01';
  if (usd < 10) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(1)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtDuration(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return '<1m';
}

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const d = Math.floor(diff / 86_400_000);
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor(diff / 60_000);
  if (d > 30) return new Date(ts).toLocaleDateString();
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return 'just now';
}

function projectName(dir: string): string {
  const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('/') : parts[parts.length - 1] || dir;
}

function modelBadge(model?: string): { color: string; label: string } {
  if (!model) return { color: '#8b949e', label: 'Unknown' };
  return MODEL_BADGES[model] ?? { color: '#8b949e', label: model.replace('claude-', '').slice(0, 12) };
}

function encodePath(jsonlPath: string): string {
  const bytes = new TextEncoder().encode(jsonlPath);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Total context at a turn = non-cached input + cache written + cache read */
function ctxSize(t: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number {
  return t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
}

// ─── Types ──────────────────────────────────────────────────────────────────

/** A "chapter" = one user conversational exchange and ALL of Claude's work until the next user message */
interface Chapter {
  turnNumber: number;
  /** The user's message that kicked off this exchange */
  userAsk: string;
  userTokenEstimate: number;
  /** All the actions Claude took in response */
  actions: ChapterAction[];
  /** Final state after this chapter */
  finalContextSize: number;
  cumulativeCost: number;
  chapterCost: number;
  cacheHitPct: number;
  contextDelta: number;
  /** Number of API round-trips in this chapter */
  apiCalls: number;
  /** Total output tokens generated */
  totalOutputTokens: number;
  /** Total input tokens processed (sum across all API calls, not just final context) */
  totalInputProcessed: number;
  insights: Insight[];
}

interface ChapterAction {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'text_response';
  summary: string;
  toolNames?: string[];
  outputTokens: number;
  costUsd: number;
}

interface Insight {
  type: 'cache-hit' | 'large-growth' | 'expensive-turn' | 'compaction' | 'heavy-thinking' | 'empty-result' | 'repeated-tool';
  message: string;
  color: string;
  severity: 'info' | 'warn' | 'issue';
}

interface EfficiencyFinding {
  severity: 'good' | 'info' | 'warn' | 'issue' | 'action';
  title: string;
  detail: string;
  /** Specific actionable fix — shown as a code/config block */
  fix?: string;
  /** Estimated savings if fix is applied */
  savingsEstimate?: string;
}

// ─── Story Engine ───────────────────────────────────────────────────────────

function buildChapters(timeline: TimelineMessage[]): Chapter[] {
  const chapters: Chapter[] = [];
  let cumCost = 0;
  let prevCtx = 0;
  let turnNum = 0;

  // Group messages into chapters: each chapter starts with a user message
  // and includes all assistant/tool_result messages until the next user message.
  const groups: TimelineMessage[][] = [];
  let current: TimelineMessage[] = [];

  for (const msg of timeline) {
    const isUserInitiated = msg.role === 'user' && (msg.source === 'user_message' || msg.source === 'system_context');
    if (isUserInitiated) {
      if (current.length > 0) groups.push(current);
      current = [msg];
    } else {
      current.push(msg);
    }
  }
  if (current.length > 0) groups.push(current);

  for (const group of groups) {
    const userMsg = group[0]!;
    // Skip if this group has no assistant response at all
    const hasAssistant = group.some(m => m.role === 'assistant');
    if (!hasAssistant && group.length === 1 && !userMsg.summary) continue;

    turnNum++;
    const userAsk = userMsg.summary || '(no message)';
    const userTokenEstimate = userMsg.tokens ? ctxSize(userMsg.tokens) : 0;

    // Build actions from assistant messages and tool results
    const actions: ChapterAction[] = [];
    let chapterCost = 0;
    let lastCtx = prevCtx;
    let lastCacheHit = 0;
    let apiCalls = 0;
    let totalOutput = 0;
    let totalInputProcessed = 0;
    const toolCallCounts: Record<string, number> = {};
    let emptyResults = 0;

    for (let i = 1; i < group.length; i++) {
      const m = group[i]!;

      if (m.role === 'assistant') {
        if (m.tokens) {
          chapterCost += m.tokens.costUsd;
          lastCtx = ctxSize(m.tokens);
          lastCacheHit = m.tokens.cacheHitPct;
          apiCalls++;
          totalOutput += m.tokens.outputTokens;
          totalInputProcessed += ctxSize(m.tokens);
        }

        if (m.source === 'assistant_tool' && m.toolNames?.length) {
          for (const tn of m.toolNames) toolCallCounts[tn] = (toolCallCounts[tn] || 0) + 1;
          actions.push({
            type: 'tool_call',
            summary: m.toolNames.join(', '),
            toolNames: m.toolNames,
            outputTokens: m.tokens?.outputTokens ?? 0,
            costUsd: m.tokens?.costUsd ?? 0,
          });
        } else if (m.summary && m.summary.length > 0) {
          actions.push({
            type: 'text_response',
            summary: m.summary,
            outputTokens: m.tokens?.outputTokens ?? 0,
            costUsd: m.tokens?.costUsd ?? 0,
          });
        } else if (m.tokens && m.tokens.outputTokens > 100) {
          actions.push({
            type: 'thinking',
            summary: `Reasoning (${fmtTokens(m.tokens.outputTokens)} output tokens)`,
            outputTokens: m.tokens.outputTokens,
            costUsd: m.tokens.costUsd,
          });
        }
      } else if (m.source === 'tool_result') {
        const preview = m.summary?.slice(0, 120) || '(empty result)';
        if (!m.summary || m.summary.length < 5) emptyResults++;
        actions.push({
          type: 'tool_result',
          summary: preview,
          toolNames: m.toolNames,
          outputTokens: 0,
          costUsd: 0,
        });
      }
    }

    cumCost += chapterCost;
    const contextDelta = lastCtx - prevCtx;

    // Detect insights
    const insights: Insight[] = [];

    if (lastCacheHit > 80) {
      insights.push({ type: 'cache-hit', message: `${lastCacheHit.toFixed(0)}% of context served from cache`, color: '#3fb950', severity: 'info' });
    }
    if (contextDelta > 15000) {
      insights.push({ type: 'large-growth', message: `Context grew ${fmtTokens(contextDelta)} this chapter`, color: '#d29922', severity: 'warn' });
    }
    if (chapterCost > 0.50) {
      insights.push({ type: 'expensive-turn', message: `Expensive chapter: ${fmtCost(chapterCost)}`, color: '#f85149', severity: 'issue' });
    }
    if (contextDelta < -10000) {
      insights.push({ type: 'compaction', message: `Context compressed: shrank ${fmtTokens(Math.abs(contextDelta))}`, color: '#bc8cff', severity: 'info' });
    }
    if (emptyResults > 0) {
      insights.push({ type: 'empty-result', message: `${emptyResults} tool result${emptyResults > 1 ? 's' : ''} returned empty/minimal data`, color: '#d29922', severity: 'warn' });
    }
    const repeats = Object.entries(toolCallCounts).filter(([, c]) => c >= 3);
    if (repeats.length > 0) {
      const names = repeats.map(([n, c]) => `${n} x${c}`).join(', ');
      insights.push({ type: 'repeated-tool', message: `Repeated tool calls: ${names}`, color: '#d29922', severity: 'warn' });
    }

    chapters.push({
      turnNumber: turnNum,
      userAsk,
      userTokenEstimate,
      actions,
      finalContextSize: lastCtx,
      cumulativeCost: cumCost,
      chapterCost,
      cacheHitPct: lastCacheHit,
      contextDelta,
      apiCalls,
      totalOutputTokens: totalOutput,
      totalInputProcessed,
      insights,
    });

    prevCtx = lastCtx;
  }

  return chapters;
}

function analyzeEfficiency(chapters: Chapter[], detail: SessionTokenDetail, overhead: ContextOverhead | null): EfficiencyFinding[] {
  const findings: EfficiencyFinding[] = [];
  const totals = detail.totals;
  if (!totals || chapters.length === 0) return findings;

  const totalApiCalls = chapters.reduce((s, c) => s + c.apiCalls, 0);
  const totalInputProcessed = chapters.reduce((s, c) => s + c.totalInputProcessed, 0);
  const totalOutput = totals.outputTokens;
  const ioRatio = totalOutput > 0 ? Math.round(totalInputProcessed / totalOutput) : 0;
  const avgCtx = Math.round(totalInputProcessed / Math.max(totalApiCalls, 1));

  // ── TOOL DEFINITION OVERHEAD (the silent killer) ──
  if (overhead) {
    // Tool defs are ~25K tokens sent on EVERY API call
    const firstAssistant = detail.timeline.find(m => m.role === 'assistant' && m.tokens);
    const firstCtx = firstAssistant?.tokens ? ctxSize(firstAssistant.tokens) : 0;
    const toolDefTokens = Math.max(0, firstCtx - overhead.grandTotal);
    const toolDefCostPerCall = toolDefTokens * 0.0000005; // cache-read pricing for Opus
    const toolDefSessionCost = toolDefCostPerCall * totalApiCalls;
    const fullPricePerCall = toolDefTokens * 0.000005; // non-cached pricing
    const uncachedCalls = chapters.filter(c => c.cacheHitPct < 50).reduce((s, c) => s + c.apiCalls, 0);

    if (toolDefTokens > 15000) {
      findings.push({
        severity: 'action',
        title: `~${fmtTokens(toolDefTokens)} of tool definitions sent on every API call`,
        detail: `${totalApiCalls} API calls × ~${fmtTokens(toolDefTokens)} tool defs = ~${fmtTokens(toolDefTokens * totalApiCalls)} tokens just for tool schemas. Even cached, that's ~${fmtCost(toolDefSessionCost)} this session. On uncached calls (${uncachedCalls} in this session) it's ${fmtCost(fullPricePerCall)}/call at full price.`,
        fix: 'Reduce loaded tools: unload MCP servers and skills not needed for this project. Each MCP server adds all its tools to every API call. mcp-hub aggregates everything — consider per-project .mcp.json files that only load what you need.',
        savingsEstimate: `Removing 10K tokens of tool defs would save ~${fmtCost(10000 * 0.0000005 * totalApiCalls)}/session cached, much more on cold calls`,
      });
    }

    // Specific skill overhead
    const bigSkills = (overhead.skills || []).filter(s => s.estimatedTokens > 2000).sort((a, b) => b.estimatedTokens - a.estimatedTokens);
    if (bigSkills.length > 0) {
      const skillNames = bigSkills.slice(0, 4).map(s => `${s.name} (${fmtTokens(s.estimatedTokens)})`).join(', ');
      const skillTotal = bigSkills.reduce((s, sk) => s + sk.estimatedTokens, 0);
      findings.push({
        severity: 'action',
        title: `${bigSkills.length} large skills add ~${fmtTokens(skillTotal)} to every call`,
        detail: `${skillNames}. Skills are loaded into the system prompt and sent on every API call. If you don't use a skill in most sessions, unloading it saves tokens on every call.`,
        fix: `Review ~/.claude/commands/ and uninstall skills you rarely use. Each skill's prompt is sent on every API call whether you invoke it or not.`,
        savingsEstimate: `~${fmtTokens(skillTotal)} fewer tokens × ${totalApiCalls} calls = ~${fmtTokens(skillTotal * totalApiCalls)} tokens saved`,
      });
    }
  }

  // ── TASK MANAGEMENT OVERHEAD ──
  const taskTools: Record<string, number> = {};
  for (const ch of chapters) {
    for (const a of ch.actions) {
      if (a.toolNames) {
        for (const t of a.toolNames) {
          if (t === 'TaskCreate' || t === 'TaskUpdate' || t === 'TaskList' || t === 'TaskGet') {
            taskTools[t] = (taskTools[t] || 0) + 1;
          }
        }
      }
    }
  }
  const taskCallCount = Object.values(taskTools).reduce((s, c) => s + c, 0);
  if (taskCallCount >= 5) {
    const taskCostEst = avgCtx * taskCallCount * 0.0000005; // cache-read pricing
    const taskNames = Object.entries(taskTools).map(([n, c]) => `${n} x${c}`).join(', ');
    findings.push({
      severity: 'action',
      title: `${taskCallCount} task management calls (est. ~${fmtCost(taskCostEst)} overhead)`,
      detail: `${taskNames}. Every TaskCreate/TaskUpdate is a separate API round-trip carrying ~${fmtTokens(avgCtx)} of context.`,
      fix: 'Add to CLAUDE.md:\nDo not use TaskCreate or TaskUpdate unless I explicitly ask for task tracking. For multi-step work, just do the work sequentially without creating a checklist.',
      savingsEstimate: `~${fmtCost(taskCostEst)}/session`,
    });
  }

  // ── MOST EXPENSIVE CHAPTER ──
  const sorted = [...chapters].sort((a, b) => b.chapterCost - a.chapterCost);
  const costliest = sorted[0]!;
  const costPct = ((costliest.chapterCost / totals.costUsd) * 100).toFixed(0);
  const toolCalls = costliest.actions.filter(a => a.type === 'tool_call').length;
  findings.push({
    severity: 'issue',
    title: `Chapter ${costliest.turnNumber}: ${costPct}% of session cost (${fmtCost(costliest.chapterCost)})`,
    detail: `"${costliest.userAsk.slice(0, 60)}${costliest.userAsk.length > 60 ? '...' : ''}" — ${toolCalls} tool calls (${costliest.apiCalls} API round-trips), each sending ~${fmtTokens(Math.round(costliest.totalInputProcessed / Math.max(costliest.apiCalls, 1)))} context. Output: ${fmtTokens(costliest.totalOutputTokens)}.`,
  });

  // ── MODEL RECOMMENDATION ──
  const implementChapters = chapters.filter(c => {
    const edits = c.actions.filter(a => a.toolNames?.some(t => t === 'Edit' || t === 'Write' || t === 'MultiEdit'));
    return edits.length >= 3;
  });
  if (implementChapters.length > 0) {
    const implCost = implementChapters.reduce((s, c) => s + c.chapterCost, 0);
    const sonnetSavings = implCost * 0.67;
    findings.push({
      severity: 'action',
      title: `Use Sonnet for implementation chapters (save ~${fmtCost(sonnetSavings)})`,
      detail: `Chapter${implementChapters.length > 1 ? 's' : ''} ${implementChapters.map(c => c.turnNumber).join(', ')} — mostly Edit/Write operations (${fmtCost(implCost)} on Opus). Sonnet handles mechanical code changes at ~1/3 the price.`,
      fix: 'When Claude presents a plan and you\'re about to say "go", toggle /fast first (or switch to Sonnet). Switch back to Opus for investigation/planning.',
      savingsEstimate: `~${fmtCost(sonnetSavings)}/session for implementation work`,
    });
  }

  // ── CACHE DROPS ──
  for (let i = 1; i < chapters.length; i++) {
    const prev = chapters[i - 1]!;
    const curr = chapters[i]!;
    if (prev.cacheHitPct > 80 && curr.cacheHitPct < 50) {
      const warmCost = curr.chapterCost * 0.15;
      findings.push({
        severity: 'warn',
        title: `Cache cold-start at Chapter ${curr.turnNumber} (${prev.cacheHitPct.toFixed(0)}% -> ${curr.cacheHitPct.toFixed(0)}%)`,
        detail: `Cost ${fmtCost(curr.chapterCost)} vs ~${fmtCost(warmCost)} if cached. Anthropic's prompt cache has a ~5 minute TTL. Long pauses between turns invalidate it.`,
        fix: 'If you step away mid-session and come back, the first turn will be expensive (cold cache). Consider that cache warms up again after that first turn.',
        savingsEstimate: `~${fmtCost(curr.chapterCost - warmCost)} on this occurrence`,
      });
    }
  }

  // ── INPUT-TO-OUTPUT RATIO (summary) ──
  findings.push({
    severity: ioRatio > 200 ? 'issue' : ioRatio > 50 ? 'warn' : 'info',
    title: `${ioRatio}:1 input-to-output ratio across ${totalApiCalls} API calls`,
    detail: `${fmtTokens(totalInputProcessed)} total input processed, ${fmtTokens(totalOutput)} output generated. The primary cost driver is re-sending context on every tool call, not generating output.`,
  });

  // ── CACHE SAVINGS (the good news) ──
  if (totals.cacheSavingsUsd > 1) {
    findings.push({
      severity: 'good',
      title: `Cache saved ${fmtCost(totals.cacheSavingsUsd)} (${totals.cacheHitRate.toFixed(0)}% hit rate)`,
      detail: `Without caching: ${fmtCost(totals.hypotheticalCostWithoutCache)}. Caching reduces repeated context reads by 90%.`,
    });
  }

  // ── COST SUMMARY ──
  const avgCost = totals.costUsd / chapters.length;
  findings.push({
    severity: avgCost > 1.00 ? 'warn' : 'info',
    title: `${fmtCost(avgCost)} avg per exchange (${fmtCost(totals.costUsd)} total)`,
    detail: `${chapters.length} exchanges, ${totalApiCalls} API calls. Reducing tool calls and context size are the two biggest levers.`,
  });

  return findings;
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function SessionCard({ session, isSelected, onClick }: { session: NativeSession; isSelected: boolean; onClick: () => void }) {
  return (
    <div onClick={onClick} style={{
      padding: '12px 16px',
      borderLeft: isSelected ? '3px solid var(--accent, #58a6ff)' : '3px solid transparent',
      background: isSelected ? 'var(--bg3, #161b22)' : 'transparent',
      cursor: 'pointer',
      borderBottom: '1px solid var(--border, #30363d)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>{projectName(session.cwd)}</span>
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>{timeAgo(session.startedAt)}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, fontSize: 12, color: 'var(--text2)' }}>
        <span>{session.userTurns} turns</span>
        <span style={{ color: 'var(--text3)' }}>|</span>
        <span>{session.toolCalls} tools</span>
      </div>
    </div>
  );
}

function PrologueBlock({ detail, overhead }: { detail: SessionTokenDetail; overhead: ContextOverhead | null }) {
  const firstAssistant = detail.timeline.find(m => m.role === 'assistant' && m.tokens);
  const firstCtx = firstAssistant?.tokens ? ctxSize(firstAssistant.tokens) : 0;
  const startTime = new Date(detail.startedAt).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const modelInfo = detail.models?.[0];
  const [showBreakdown, setShowBreakdown] = useState(false);

  // Find project-specific overhead if available
  const projOverhead = overhead?.projects?.find(p => detail.cwd.includes(p.project));

  return (
    <div style={{ padding: '20px 24px', background: 'var(--bg3, #161b22)', borderRadius: 8, borderLeft: '4px solid #bc8cff', marginBottom: 24 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#bc8cff', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>Prologue</div>

      <p style={{ margin: 0, lineHeight: 1.7, fontSize: 14, color: 'var(--text)' }}>
        This session started on <strong>{startTime}</strong>
        {modelInfo && <> using <span style={{ color: modelBadge(modelInfo.model).color, fontWeight: 600 }}>{modelBadge(modelInfo.model).label}</span></>}.
        {' '}It ran for <strong>{fmtDuration(detail.durationMs)}</strong> across <strong>{detail.userTurns} exchanges</strong> with <strong>{detail.toolCalls} tool calls</strong>.
      </p>

      <p style={{ margin: '12px 0 0', lineHeight: 1.7, fontSize: 14, color: 'var(--text2)' }}>
        The first API call carried <strong>{fmtTokens(firstCtx)} tokens</strong> of context.
        {detail.totals.cacheHitRate > 0 && <> Prompt caching served <strong>{detail.totals.cacheHitRate.toFixed(0)}%</strong> of input across the session, saving <strong style={{ color: '#3fb950' }}>{fmtCost(detail.totals.cacheSavingsUsd)}</strong>.</>}
      </p>

      {/* Context breakdown */}
      {overhead && (
        <div style={{ marginTop: 16 }}>
          <button onClick={() => setShowBreakdown(!showBreakdown)} style={{
            background: 'none', border: 'none', color: '#58a6ff', fontSize: 12, cursor: 'pointer', padding: 0, fontFamily: 'inherit',
          }}>
            {showBreakdown ? '- Hide' : '+ Show'} context breakdown
          </button>
          {showBreakdown && (
            <div style={{ marginTop: 12, padding: '12px 16px', background: 'var(--bg, #0d1117)', borderRadius: 6, fontSize: 12, color: 'var(--text2)' }}>
              <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--text)' }}>What fills the context window (~{fmtTokens(overhead.grandTotal)} tokens overhead before your message):</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 16px' }}>
                <span>Global rules ({overhead.globalRules.length} files)</span>
                <span style={{ fontFamily: 'var(--mono)', color: '#58a6ff' }}>{fmtTokens(overhead.globalRulesTotal)}</span>
                <span>Skills ({overhead.skillsCount} loaded)</span>
                <span style={{ fontFamily: 'var(--mono)', color: '#bc8cff' }}>{fmtTokens(overhead.skillsEstTokens)}</span>
                {overhead.hookPromptsTotal > 0 && <>
                  <span>Hook prompts</span>
                  <span style={{ fontFamily: 'var(--mono)', color: '#d29922' }}>{fmtTokens(overhead.hookPromptsTotal)}</span>
                </>}
                {projOverhead && <>
                  <span>Project CLAUDE.md + memory</span>
                  <span style={{ fontFamily: 'var(--mono)', color: '#3fb950' }}>{fmtTokens(projOverhead.totalTokens)}</span>
                </>}
                <span style={{ color: 'var(--text3)' }}>Tool definitions (~58 tools)</span>
                <span style={{ fontFamily: 'var(--mono)', color: '#f0883e' }}>~{fmtTokens(Math.max(0, firstCtx - overhead.grandTotal))}</span>
              </div>
              {overhead.suggestions.length > 0 && (
                <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  <div style={{ fontWeight: 600, color: '#d29922', marginBottom: 4 }}>Optimization suggestions:</div>
                  {overhead.suggestions.slice(0, 3).map((s, i) => (
                    <div key={i} style={{ color: 'var(--text3)', marginBottom: 2 }}>- {s.title}: ~{fmtTokens(s.potentialSavings)} saveable</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChapterBlock({ chapter, totalChapters }: { chapter: Chapter; totalChapters: number }) {
  const [expanded, setExpanded] = useState(false);
  const toolCalls = chapter.actions.filter(a => a.type === 'tool_call');
  const textResponses = chapter.actions.filter(a => a.type === 'text_response');
  const lastText = textResponses[textResponses.length - 1];

  // Build the narrative
  const narrativeParts: string[] = [];
  if (toolCalls.length > 0) {
    const uniqueTools = [...new Set(toolCalls.flatMap(a => a.toolNames ?? []))];
    const toolStr = uniqueTools.slice(0, 5).join(', ') + (uniqueTools.length > 5 ? ` +${uniqueTools.length - 5} more` : '');
    narrativeParts.push(`Called ${toolCalls.length} tool${toolCalls.length > 1 ? 's' : ''} (${toolStr})`);
  }
  if (lastText) {
    const preview = lastText.summary.length > 200 ? lastText.summary.slice(0, 200) + '...' : lastText.summary;
    narrativeParts.push(narrativeParts.length > 0 ? `then responded: "${preview}"` : `Responded: "${preview}"`);
  }
  if (narrativeParts.length === 0) {
    narrativeParts.push('(internal processing — no visible output)');
  }

  const ctxPct = chapter.finalContextSize > 250_000
    ? (chapter.finalContextSize / 1_000_000) * 100
    : (chapter.finalContextSize / 200_000) * 100;
  const ctxLimit = chapter.finalContextSize > 250_000 ? 1_000_000 : 200_000;
  const barColor = ctxPct < 50 ? '#3fb950' : ctxPct < 80 ? '#d29922' : '#f85149';

  return (
    <div style={{ marginBottom: 24 }}>
      {/* Chapter header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 1 }}>
          Chapter {chapter.turnNumber} of {totalChapters}
        </span>
        <div style={{ flex: 1, height: 1, background: 'var(--border, #30363d)' }} />
        <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text3)' }}>{fmtCost(chapter.chapterCost)}</span>
      </div>

      {/* User ask */}
      <div style={{ padding: '12px 16px', background: 'rgba(63, 185, 80, 0.06)', borderLeft: '3px solid #3fb950', borderRadius: '0 6px 6px 0', marginBottom: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#3fb950', marginBottom: 4 }}>YOU</div>
        <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6 }}>
          {chapter.userAsk.length > 300 ? chapter.userAsk.slice(0, 300) + '...' : chapter.userAsk}
        </div>
      </div>

      {/* Claude narrative */}
      <div style={{ padding: '12px 16px', background: 'rgba(139, 148, 158, 0.06)', borderLeft: '3px solid #8b949e', borderRadius: '0 6px 6px 0', marginBottom: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#8b949e', marginBottom: 4 }}>CLAUDE</div>
        <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6 }}>
          {narrativeParts.join(', ')}
        </div>
        <div style={{ marginTop: 8, display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
          <span>Context: {fmtTokens(chapter.finalContextSize)}</span>
          {chapter.cacheHitPct > 0 && <span style={{ color: '#3fb950' }}>Cached: {chapter.cacheHitPct.toFixed(0)}%</span>}
          <span>Cost: {fmtCost(chapter.chapterCost)}</span>
        </div>

        {/* Expand to see all actions */}
        {chapter.actions.length > 2 && (
          <button onClick={() => setExpanded(!expanded)} style={{
            marginTop: 8, background: 'none', border: 'none', color: '#58a6ff', fontSize: 11, cursor: 'pointer', padding: 0, fontFamily: 'inherit',
          }}>
            {expanded ? '- Collapse' : `+ Show ${chapter.actions.length} actions`}
          </button>
        )}
        {expanded && (
          <div style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            {chapter.actions.map((a, i) => (
              <div key={i} style={{ fontSize: 11, color: 'var(--text3)', padding: '2px 0', display: 'flex', gap: 8 }}>
                <span style={{
                  color: a.type === 'tool_call' ? '#f0883e' : a.type === 'tool_result' ? '#d29922' : a.type === 'thinking' ? '#56d4dd' : '#8b949e',
                  width: 70, flexShrink: 0, fontFamily: 'var(--mono)',
                }}>
                  {a.type === 'tool_call' ? 'CALL' : a.type === 'tool_result' ? 'RESULT' : a.type === 'thinking' ? 'THINK' : 'TEXT'}
                </span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {a.summary.slice(0, 120)}
                </span>
                {a.costUsd > 0 && <span style={{ fontFamily: 'var(--mono)', flexShrink: 0 }}>{fmtCost(a.costUsd)}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Insight callouts */}
      {chapter.insights.map((insight, idx) => (
        <div key={idx} style={{
          padding: '6px 14px', borderLeft: `3px solid ${insight.color}`, background: `${insight.color}0a`,
          borderRadius: '0 6px 6px 0', marginBottom: 4, fontSize: 12, color: insight.color, fontStyle: 'italic',
        }}>
          {insight.message}
        </div>
      ))}

      {/* Progress strip */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '6px 14px',
        fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', background: 'var(--bg, #0d1117)', borderRadius: 4, marginTop: 4,
      }}>
        <span style={{ color: 'var(--text2)' }}>{fmtCost(chapter.cumulativeCost)}</span>
        <span style={{ color: 'var(--text3)' }}>|</span>
        <div style={{ flex: 1, maxWidth: 120, height: 6, background: 'var(--bg3)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ width: `${Math.min(ctxPct, 100)}%`, height: '100%', background: barColor, borderRadius: 3 }} />
        </div>
        <span>{Math.min(ctxPct, 100).toFixed(0)}% of {fmtTokens(ctxLimit)}</span>
        {chapter.contextDelta !== 0 && (
          <>
            <span style={{ color: 'var(--text3)' }}>|</span>
            <span style={{ color: chapter.contextDelta > 0 ? '#d29922' : '#3fb950' }}>
              {chapter.contextDelta > 0 ? '+' : ''}{fmtTokens(chapter.contextDelta)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function EpilogueBlock({ detail }: { detail: SessionTokenDetail }) {
  const { totals } = detail;
  if (!totals) return null;

  return (
    <div style={{ padding: '20px 24px', background: 'var(--bg3, #161b22)', borderRadius: 8, borderLeft: '4px solid #58a6ff', marginTop: 24 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#58a6ff', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>Epilogue</div>
      <p style={{ margin: 0, lineHeight: 1.7, fontSize: 14, color: 'var(--text)' }}>
        Session complete. <strong>{detail.userTurns} exchanges</strong> over <strong>{fmtDuration(detail.durationMs)}</strong>.
        {' '}Total cost: <strong style={{ color: '#f0883e' }}>{fmtCost(totals.costUsd)}</strong>.
      </p>
      {totals.cacheSavingsUsd > 0.01 && (
        <p style={{ margin: '8px 0 0', lineHeight: 1.7, fontSize: 14, color: 'var(--text2)' }}>
          Prompt caching saved <strong style={{ color: '#3fb950' }}>{fmtCost(totals.cacheSavingsUsd)}</strong>
          {' '}({totals.cacheHitRate.toFixed(0)}% hit rate). Without caching: {fmtCost(totals.hypotheticalCostWithoutCache)}.
        </p>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 12, marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
        {[
          { label: 'Total Cost', value: fmtCost(totals.costUsd), color: '#f0883e' },
          { label: 'Cache Savings', value: fmtCost(totals.cacheSavingsUsd), color: '#3fb950' },
          { label: 'Cache Hit Rate', value: `${totals.cacheHitRate.toFixed(0)}%`, color: '#3fb950' },
          { label: 'Output Tokens', value: fmtTokens(totals.outputTokens), color: '#bc8cff' },
          { label: 'Duration', value: fmtDuration(detail.durationMs), color: '#8b949e' },
        ].map(kpi => (
          <div key={kpi.label}>
            <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>{kpi.label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: kpi.color, fontFamily: 'var(--mono)' }}>{kpi.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AnalysisPanel({ findings }: { findings: EfficiencyFinding[] }) {
  if (findings.length === 0) return null;
  const severityColor: Record<string, string> = { good: '#3fb950', info: '#58a6ff', warn: '#d29922', issue: '#f85149', action: '#f0883e' };
  const severityIcon: Record<string, string> = { good: '+', info: '~', warn: '!', issue: '!!', action: '>' };

  const actionFindings = findings.filter(f => f.severity === 'action');
  const otherFindings = findings.filter(f => f.severity !== 'action');

  return (
    <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Actionable fixes section */}
      {actionFindings.length > 0 && (
        <div style={{ padding: '20px 24px', background: 'var(--bg3, #161b22)', borderRadius: 8, borderLeft: '4px solid #f0883e' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#f0883e', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Actionable Fixes</div>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 16 }}>Changes you can make right now to reduce cost</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {actionFindings.map((f, i) => (
              <div key={i} style={{ borderBottom: i < actionFindings.length - 1 ? '1px solid var(--border)' : 'none', paddingBottom: i < actionFindings.length - 1 ? 16 : 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#f0883e', marginBottom: 4 }}>{f.title}</div>
                <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.5, marginBottom: 8 }}>{f.detail}</div>
                {f.fix && (
                  <div style={{
                    padding: '10px 14px', background: 'var(--bg, #0d1117)', borderRadius: 6, border: '1px solid var(--border)',
                    fontSize: 12, color: 'var(--text)', fontFamily: 'var(--mono)', lineHeight: 1.6, whiteSpace: 'pre-wrap',
                  }}>
                    {f.fix}
                  </div>
                )}
                {f.savingsEstimate && (
                  <div style={{ marginTop: 6, fontSize: 11, color: '#3fb950', fontStyle: 'italic' }}>
                    Estimated savings: {f.savingsEstimate}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Other findings */}
      <div style={{ padding: '20px 24px', background: 'var(--bg3, #161b22)', borderRadius: 8, borderLeft: '4px solid #d29922' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#d29922', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>Session Analysis</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {otherFindings.map((f, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: severityColor[f.severity] ?? '#8b949e', flexShrink: 0, width: 16, textAlign: 'center', fontWeight: 700 }}>
                {severityIcon[f.severity] ?? '~'}
              </span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: severityColor[f.severity] ?? '#8b949e' }}>{f.title}</div>
                <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.5 }}>{f.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ContextGauge({ contextSize, contextLimit }: { contextSize: number; contextLimit: number }) {
  const pct = contextLimit > 0 ? Math.min((contextSize / contextLimit) * 100, 100) : 0;
  const gaugeColor = pct < 50 ? '#3fb950' : pct < 80 ? '#d29922' : '#f85149';

  return (
    <div style={{
      position: 'sticky', top: 24, width: 180, flexShrink: 0, padding: 16,
      background: 'var(--bg3, #161b22)', borderRadius: 8, border: '1px solid var(--border, #30363d)',
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text2)', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 1 }}>Context Window</div>
      <div style={{ height: 200, width: 40, margin: '0 auto 12px', background: 'var(--bg, #0d1117)', borderRadius: 6, overflow: 'hidden', position: 'relative' }}>
        <div style={{
          position: 'absolute', bottom: 0, width: '100%', height: `${pct}%`,
          background: `linear-gradient(to top, ${gaugeColor}, ${gaugeColor}88)`, borderRadius: '0 0 6px 6px', transition: 'height 0.3s',
        }} />
      </div>
      <div style={{ textAlign: 'center', fontSize: 20, fontWeight: 700, color: gaugeColor, fontFamily: 'var(--mono)' }}>{pct.toFixed(0)}%</div>
      <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>{fmtTokens(contextSize)} / {fmtTokens(contextLimit)}</div>
    </div>
  );
}

// ─── Root Component ─────────────────────────────────────────────────────────

export function ContextExplorer() {
  const [sessions, setSessions] = useState<NativeSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionTokenDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [overhead, setOverhead] = useState<ContextOverhead | null>(null);
  const [filterProject, setFilterProject] = useState('');
  const storyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.native.sessions(),
      api.analytics.contextOverhead().catch(() => null),
    ]).then(([data, oh]) => {
      setSessions([...data].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()));
      setOverhead(oh);
      setError(null);
    }).catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const loadDetail = useCallback((jsonlPath: string) => {
    setSelectedPath(jsonlPath);
    setDetailLoading(true);
    setDetailError(null);
    setDetail(null);
    api.native.sessionTokens(encodePath(jsonlPath))
      .then(d => { setDetail(d); storyRef.current?.scrollTo(0, 0); })
      .catch(e => setDetailError(e.message))
      .finally(() => setDetailLoading(false));
  }, []);

  const projects = useMemo(() => {
    const seen = new Set<string>();
    return sessions.map(s => ({ cwd: s.cwd, name: projectName(s.cwd) }))
      .filter(p => { if (seen.has(p.cwd)) return false; seen.add(p.cwd); return true; })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [sessions]);

  const filtered = useMemo(() => filterProject ? sessions.filter(s => s.cwd === filterProject) : sessions, [sessions, filterProject]);

  const chapters = useMemo(() => detail?.timeline ? buildChapters(detail.timeline) : [], [detail]);

  const findings = useMemo(() => detail ? analyzeEfficiency(chapters, detail, overhead) : [], [chapters, detail, overhead]);

  const contextLimit = useMemo(() => {
    if (!detail) return 200_000;
    const m = detail.models?.[0]?.model ?? '';
    return (m.includes('opus-4-6') || m.includes('opus-4-5') || m.includes('sonnet-4-6') || m.includes('sonnet-4-5')) ? 1_000_000 : 200_000;
  }, [detail]);

  const lastContextSize = useMemo(() => {
    if (!chapters.length) return 0;
    return chapters[chapters.length - 1]!.finalContextSize;
  }, [chapters]);

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 100px)', overflow: 'hidden' }}>
      {/* Session list */}
      <div style={{ width: 320, flexShrink: 0, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <select value={filterProject} onChange={e => setFilterProject(e.target.value)} style={{
            width: '100%', padding: '6px 8px', fontSize: 12, background: 'var(--bg)', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: 4, fontFamily: 'var(--mono)',
          }}>
            <option value="">All projects ({sessions.length})</option>
            {projects.map(p => <option key={p.cwd} value={p.cwd}>{p.name}</option>)}
          </select>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading && <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>Loading...</div>}
          {error && <div style={{ padding: 24, color: '#f85149' }}>{error}</div>}
          {filtered.map(s => (
            <SessionCard key={s.jsonlPath} session={s} isSelected={selectedPath === s.jsonlPath} onClick={() => loadDetail(s.jsonlPath)} />
          ))}
        </div>
      </div>

      {/* Story */}
      <div ref={storyRef} style={{ flex: 1, overflowY: 'auto', display: 'flex' }}>
        {!selectedPath && <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)', fontSize: 15 }}>Select a session to see its story</div>}
        {selectedPath && detailLoading && <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)' }}>Loading session story...</div>}
        {selectedPath && detailError && <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#f85149', padding: 24 }}>Failed to load: {detailError}</div>}

        {detail && !detailLoading && (
          <>
            <div style={{ flex: 1, padding: 24, maxWidth: 800 }}>
              <PrologueBlock detail={detail} overhead={overhead} />
              {chapters.map(ch => <ChapterBlock key={ch.turnNumber} chapter={ch} totalChapters={chapters.length} />)}
              <EpilogueBlock detail={detail} />
              <AnalysisPanel findings={findings} />
            </div>
            <div style={{ width: 212, flexShrink: 0, padding: '24px 16px 24px 0' }}>
              <ContextGauge contextSize={lastContextSize} contextLimit={contextLimit} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
