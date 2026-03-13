import { useEffect, useState, useMemo, useCallback } from 'react';
import { api, type NativeSession, type SessionTokenDetail, type TimelineMessage, type MessageSource } from '../api.js';

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

const SOURCE_LABELS: Record<MessageSource, string> = {
  system_context: 'System',
  hook_injection: 'Hook',
  user_message: 'User',
  tool_result: 'Tool Result',
  assistant_text: 'Text',
  assistant_tool: 'Tool Call',
  assistant_mixed: 'Mixed',
};

const TOKEN_COLORS = {
  input: '#58a6ff',
  cacheRead: '#3fb950',
  cacheWrite: '#d29922',
  output: '#bc8cff',
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

function fmtDateRange(first: string, last: string): string {
  const a = new Date(first);
  const b = new Date(last);
  const diffMs = b.getTime() - a.getTime();
  const diffH = Math.round(diffMs / 3_600_000);

  const fmtShort = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  if (diffH < 1) return fmtShort(a);
  if (diffH < 24) return `${fmtShort(a)} (${diffH}h)`;
  return `${fmtShort(a)} – ${fmtShort(b)} (${diffH}h)`;
}

function projectName(dir: string): string {
  if (!dir) return 'unknown';
  const parts = dir.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? dir;
}

/** Extract a project name from the jsonlPath directory (encoded path) as fallback */
function projectNameFromJsonlPath(jsonlPath: string): string {
  // ~/.claude/projects/C--Users-kruz7-OneDrive-Documents-Code-Repos-MCKRUZ-Nexus/abc.jsonl
  const parts = jsonlPath.replace(/\\/g, '/').split('/');
  const projectsIdx = parts.indexOf('projects');
  if (projectsIdx >= 0 && projectsIdx + 1 < parts.length) {
    const encoded = parts[projectsIdx + 1]!;
    // Decode: C--Users-kruz7-...-ProjectName → take last segment
    const segments = encoded.split('-').filter(Boolean);
    return segments[segments.length - 1] ?? encoded;
  }
  return 'unknown';
}

function getProjectIdentifier(s: NativeSession): string {
  if (s.cwd) return projectName(s.cwd);
  return projectNameFromJsonlPath(s.jsonlPath);
}

function getProjectPath(s: NativeSession): string {
  if (s.cwd) return s.cwd.replace(/\\/g, '/');
  return '';
}

function shortModel(model: string): string {
  return model.replace('claude-', '').replace(/-20\d{6}$/, '');
}

function costColor(usd: number): string {
  if (usd < 0.5) return '#3fb950';
  if (usd < 2) return '#d29922';
  return '#f85149';
}

// ─── Grouping Types ─────────────────────────────────────────────────────────

interface ConversationGroup {
  slug: string;
  displayName: string;
  sessions: NativeSession[];
  firstActivity: string;
  lastActivity: string;
  totalTurns: number;
  totalToolCalls: number;
}

interface ProjectGroup {
  name: string;
  cwd: string;
  conversations: ConversationGroup[];
  totalConversations: number;
}

// ─── KPI Card ───────────────────────────────────────────────────────────────

function KpiCard({ label, value, color, sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <div className="card" style={{ textAlign: 'center', padding: '14px 10px' }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: color ?? 'var(--text)' }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 4 }}>{label}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--text3, #666)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ─── Source Breakdown Bar ───────────────────────────────────────────────────

function SourceBreakdownBar({ breakdown }: { breakdown: SessionTokenDetail['sourceBreakdown'] }) {
  const total = breakdown.reduce((s, b) => s + b.estimatedTokens, 0);
  if (total === 0) return <div style={{ fontSize: 12, color: 'var(--text2)' }}>No source data</div>;

  return (
    <div>
      <div style={{ display: 'flex', height: 28, borderRadius: 6, overflow: 'hidden', marginBottom: 10 }}>
        {breakdown.filter(b => b.estimatedTokens > 0).map((b) => {
          const pct = (b.estimatedTokens / total) * 100;
          if (pct < 1) return null;
          return (
            <div
              key={b.source}
              title={`${SOURCE_LABELS[b.source]}: ${fmtTokens(b.estimatedTokens)} (${b.pctOfInput.toFixed(1)}%)`}
              style={{
                width: `${pct}%`,
                background: SOURCE_COLORS[b.source],
                minWidth: pct > 2 ? undefined : 3,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 10,
                color: '#fff',
                fontWeight: 600,
                overflow: 'hidden',
                whiteSpace: 'nowrap',
              }}
            >
              {pct > 8 ? `${Math.round(pct)}%` : ''}
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', fontSize: 11 }}>
        {breakdown.filter(b => b.estimatedTokens > 0).map((b) => (
          <div key={b.source} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: SOURCE_COLORS[b.source], flexShrink: 0 }} />
            <span style={{ color: 'var(--text2)' }}>{SOURCE_LABELS[b.source]}</span>
            <span style={{ color: 'var(--text)' }}>{fmtTokens(b.estimatedTokens)}</span>
            <span style={{ color: 'var(--text3, #666)' }}>({b.pctOfInput.toFixed(1)}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Token Waterfall Chart ──────────────────────────────────────────────────

function TokenWaterfallChart({ timeline }: { timeline: TimelineMessage[] }) {
  const assistantTurns = useMemo(
    () => timeline.filter((m) => m.role === 'assistant' && m.tokens).slice(0, 200),
    [timeline],
  );

  if (assistantTurns.length === 0) {
    return <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--text2)' }}>No token data</div>;
  }

  const W = 700;
  const H = 140;
  const PAD_BOTTOM = 20;
  const PAD_TOP = 10;
  const chartH = H - PAD_BOTTOM - PAD_TOP;

  const bars = assistantTurns.length;
  const slotW = W / Math.max(bars, 1);
  const barW = Math.max(Math.min(slotW - 2, 16), 2);

  const maxVal = Math.max(
    ...assistantTurns.map((m) => {
      const t = m.tokens!;
      return t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens + t.outputTokens;
    }),
    1,
  );

  // Determine expensive threshold (top 10%)
  const costs = assistantTurns.map((m) => m.tokens!.costUsd).sort((a, b) => b - a);
  const expensiveThreshold = costs[Math.max(Math.floor(costs.length * 0.1) - 1, 0)] ?? Infinity;

  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 8, fontSize: 11, color: 'var(--text2)', flexWrap: 'wrap' }}>
        {Object.entries(TOKEN_COLORS).map(([key, color]) => (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: color }} />
            {key === 'cacheRead' ? 'Cache Read' : key === 'cacheWrite' ? 'Cache Write' : key.charAt(0).toUpperCase() + key.slice(1)}
          </div>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', maxHeight: 200 }}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {assistantTurns.map((m, i) => {
          const t = m.tokens!;
          const total = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens + t.outputTokens;
          const scale = chartH / maxVal;
          const x = i * slotW + (slotW - barW) / 2;
          const isExpensive = t.costUsd >= expensiveThreshold;

          // Stack: input (bottom), cacheRead, cacheWrite, output (top)
          const segments = [
            { h: t.inputTokens * scale, color: TOKEN_COLORS.input },
            { h: t.cacheReadTokens * scale, color: TOKEN_COLORS.cacheRead },
            { h: t.cacheWriteTokens * scale, color: TOKEN_COLORS.cacheWrite },
            { h: t.outputTokens * scale, color: TOKEN_COLORS.output },
          ];

          let y = H - PAD_BOTTOM;

          return (
            <g
              key={i}
              onMouseEnter={() => setHoverIdx(i)}
              style={{ cursor: 'pointer' }}
            >
              {/* Invisible hit area */}
              <rect x={x - 1} y={PAD_TOP} width={barW + 2} height={chartH} fill="transparent" />
              {/* Red indicator for expensive turns */}
              {isExpensive && (
                <rect x={x - 1} y={H - PAD_BOTTOM + 2} width={barW + 2} height={3} rx={1} fill="#f85149" />
              )}
              {segments.map((seg, si) => {
                const segY = y - seg.h;
                y = segY;
                if (seg.h < 0.5) return null;
                return (
                  <rect
                    key={si}
                    x={x}
                    y={segY}
                    width={barW}
                    height={Math.max(seg.h, 0.5)}
                    fill={seg.color}
                    rx={si === segments.length - 1 ? 1 : 0}
                    opacity={hoverIdx === null || hoverIdx === i ? 1 : 0.3}
                  />
                );
              })}
            </g>
          );
        })}
        {/* X-axis labels */}
        {assistantTurns.length <= 50 && assistantTurns.map((_, i) => {
          const labelEvery = assistantTurns.length <= 20 ? 1 : assistantTurns.length <= 40 ? 2 : 5;
          if (i % labelEvery !== 0) return null;
          return (
            <text
              key={i}
              x={i * slotW + slotW / 2}
              y={H - 4}
              textAnchor="middle"
              fontSize={8}
              fill="var(--text3, #666)"
            >
              {i + 1}
            </text>
          );
        })}
      </svg>
      {/* Tooltip */}
      {hoverIdx !== null && assistantTurns[hoverIdx] && (
        <div style={{
          fontSize: 11, padding: '8px 12px', background: 'var(--bg2, #161b22)',
          borderRadius: 6, border: '1px solid var(--border, #333)', marginTop: 4,
          display: 'flex', gap: 16, flexWrap: 'wrap',
        }}>
          <span>Turn {hoverIdx + 1}</span>
          {assistantTurns[hoverIdx]!.model && <span style={{ color: '#bc8cff' }}>{shortModel(assistantTurns[hoverIdx]!.model!)}</span>}
          <span>Input: {fmtTokens(assistantTurns[hoverIdx]!.tokens!.inputTokens)}</span>
          <span>Cache Read: {fmtTokens(assistantTurns[hoverIdx]!.tokens!.cacheReadTokens)}</span>
          <span>Output: {fmtTokens(assistantTurns[hoverIdx]!.tokens!.outputTokens)}</span>
          <span style={{ color: costColor(assistantTurns[hoverIdx]!.tokens!.costUsd) }}>
            {fmtCost(assistantTurns[hoverIdx]!.tokens!.costUsd)}
          </span>
          <span>Cache: {assistantTurns[hoverIdx]!.tokens!.cacheHitPct.toFixed(0)}%</span>
          {assistantTurns[hoverIdx]!.toolNames && (
            <span style={{ color: '#f0883e' }}>{assistantTurns[hoverIdx]!.toolNames!.join(', ')}</span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Message Timeline ───────────────────────────────────────────────────────

const ALL_SOURCES: MessageSource[] = [
  'system_context', 'hook_injection', 'user_message', 'tool_result',
  'assistant_text', 'assistant_tool', 'assistant_mixed',
];

function MessageTimeline({ timeline, expensiveThreshold }: { timeline: TimelineMessage[]; expensiveThreshold: number }) {
  const [expanded, setExpanded] = useState(false);
  const [hiddenSources, setHiddenSources] = useState<Set<MessageSource>>(new Set());

  const toggleSource = (source: MessageSource) => {
    setHiddenSources((prev) => {
      const next = new Set(prev);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  };

  // Which sources actually appear in this timeline
  const presentSources = useMemo(() => {
    const s = new Set<MessageSource>();
    for (const m of timeline) s.add(m.source);
    return ALL_SOURCES.filter((src) => s.has(src));
  }, [timeline]);

  const filtered = useMemo(
    () => timeline.filter((m) => !hiddenSources.has(m.source)),
    [timeline, hiddenSources],
  );
  const visible = expanded ? filtered : filtered.slice(0, 60);
  const hasMore = filtered.length > 60 && !expanded;

  return (
    <div>
      {/* Source filter checkboxes */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '4px 12px', padding: '8px 12px',
        borderBottom: '1px solid var(--border, #222)', fontSize: 11, alignItems: 'center',
      }}>
        <span style={{ color: 'var(--text2)', marginRight: 4 }}>Show:</span>
        {presentSources.map((src) => {
          const active = !hiddenSources.has(src);
          return (
            <label
              key={src}
              style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', userSelect: 'none' }}
            >
              <input
                type="checkbox"
                checked={active}
                onChange={() => toggleSource(src)}
                style={{ accentColor: SOURCE_COLORS[src], width: 13, height: 13, cursor: 'pointer' }}
              />
              <span style={{ color: active ? SOURCE_COLORS[src] : 'var(--text3, #666)' }}>
                {SOURCE_LABELS[src]}
              </span>
            </label>
          );
        })}
        <span style={{ color: 'var(--text3, #666)', marginLeft: 'auto' }}>
          {filtered.length}/{timeline.length}
        </span>
      </div>
      {visible.map((msg) => {
        const isUser = msg.role === 'user';
        const isExpensive = !isUser && msg.tokens && msg.tokens.costUsd >= expensiveThreshold;
        const borderColor = isExpensive ? '#f85149' : SOURCE_COLORS[msg.source];

        return (
          <div
            key={msg.index}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              padding: '8px 12px',
              marginBottom: 2,
              borderLeft: `3px solid ${borderColor}`,
              background: isUser ? 'transparent' : 'var(--bg2, #161b22)',
              borderRadius: '0 4px 4px 0',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, flexWrap: 'wrap' }}>
              {/* Source badge */}
              <span style={{
                fontSize: 10, padding: '1px 6px', borderRadius: 3,
                background: SOURCE_COLORS[msg.source] + '22',
                color: SOURCE_COLORS[msg.source],
                fontWeight: 600,
              }}>
                {SOURCE_LABELS[msg.source]}
              </span>

              {/* Model badge for assistant */}
              {!isUser && msg.model && (
                <span style={{
                  fontSize: 10, padding: '1px 6px', borderRadius: 3,
                  background: '#bc8cff22', color: '#bc8cff',
                }}>
                  {shortModel(msg.model)}
                </span>
              )}

              {/* Tool names */}
              {msg.toolNames && msg.toolNames.length > 0 && (
                <span style={{ fontSize: 10, color: '#f0883e' }}>
                  {msg.toolNames.slice(0, 5).join(', ')}{msg.toolNames.length > 5 ? ` +${msg.toolNames.length - 5}` : ''}
                </span>
              )}

              {/* Timestamp */}
              {msg.timestamp && (
                <span style={{ fontSize: 10, color: 'var(--text3, #666)', marginLeft: 'auto' }}>
                  {timeAgo(msg.timestamp)}
                </span>
              )}
            </div>

            {/* Summary */}
            <div style={{
              fontSize: 11, color: 'var(--text2)', lineHeight: 1.4,
              overflow: 'hidden', textOverflow: 'ellipsis',
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const,
            }}>
              {msg.summary || '(empty)'}
            </div>

            {/* Token details for assistant */}
            {!isUser && msg.tokens && (
              <div style={{ display: 'flex', gap: 12, fontSize: 10, color: 'var(--text2)', flexWrap: 'wrap' }}>
                <span>In: <b style={{ color: TOKEN_COLORS.input }}>{fmtTokens(msg.tokens.inputTokens)}</b></span>
                <span>Cache: <b style={{ color: TOKEN_COLORS.cacheRead }}>{fmtTokens(msg.tokens.cacheReadTokens)}</b></span>
                <span>Write: <b style={{ color: TOKEN_COLORS.cacheWrite }}>{fmtTokens(msg.tokens.cacheWriteTokens)}</b></span>
                <span>Out: <b style={{ color: TOKEN_COLORS.output }}>{fmtTokens(msg.tokens.outputTokens)}</b></span>
                <span style={{ color: costColor(msg.tokens.costUsd) }}>{fmtCost(msg.tokens.costUsd)}</span>
                {msg.tokens.inputDelta !== 0 && (
                  <span style={{ color: msg.tokens.inputDelta > 0 ? '#d29922' : '#3fb950' }}>
                    {msg.tokens.inputDelta > 0 ? '+' : ''}{fmtTokens(msg.tokens.inputDelta)} delta
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
      {hasMore && (
        <div
          onClick={() => setExpanded(true)}
          style={{
            textAlign: 'center', padding: 10, cursor: 'pointer',
            fontSize: 12, color: '#58a6ff',
          }}
        >
          Show all {timeline.length} messages
        </div>
      )}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function Sessions() {
  const [sessions, setSessions] = useState<NativeSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionTokenDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const [collapsedConversations, setCollapsedConversations] = useState<Set<string>>(new Set());

  // Load sessions
  useEffect(() => {
    setLoading(true);
    api.native.sessions()
      .then((data) => {
        setSessions(data);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  // Load detail on selection — use URL-safe base64 (no / or + that break routing)
  const loadDetail = useCallback((jsonlPath: string) => {
    const bytes = new TextEncoder().encode(jsonlPath);
    const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
    const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    setSelectedPath(jsonlPath);
    setDetailLoading(true);
    setDetail(null);
    setDetailError(null);
    api.native.sessionTokens(encoded)
      .then(setDetail)
      .catch((err) => {
        setDetail(null);
        setDetailError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setDetailLoading(false));
  }, []);

  // 3-level grouping: Project → Conversation (slug) → Session
  const grouped = useMemo((): ProjectGroup[] => {
    // Step 1: Group by project
    const projectMap = new Map<string, { cwd: string; sessions: NativeSession[] }>();
    for (const s of sessions) {
      const name = getProjectIdentifier(s);
      const existing = projectMap.get(name);
      if (existing) {
        existing.sessions.push(s);
      } else {
        projectMap.set(name, { cwd: s.cwd, sessions: [s] });
      }
    }

    // Step 2: Within each project, group by slug → conversations
    let projects: ProjectGroup[] = [...projectMap.entries()].map(([name, data]) => {
      const convMap = new Map<string, NativeSession[]>();
      for (const s of data.sessions) {
        const key = s.slug || s.sessionId; // no slug → own group
        const arr = convMap.get(key);
        if (arr) {
          arr.push(s);
        } else {
          convMap.set(key, [s]);
        }
      }

      const conversations: ConversationGroup[] = [...convMap.entries()].map(([slug, convSessions]) => {
        // Sort sessions within conversation by startedAt descending
        const sorted = [...convSessions].sort(
          (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
        );

        const timestamps = sorted.map((s) => new Date(s.startedAt).getTime());
        const lastTimestamps = sorted.map((s) => new Date(s.lastActivityAt).getTime());
        const allTimestamps = [...timestamps, ...lastTimestamps];

        return {
          slug,
          displayName: convSessions[0]!.slug ? slug : 'unnamed',
          sessions: sorted,
          firstActivity: new Date(Math.min(...allTimestamps)).toISOString(),
          lastActivity: new Date(Math.max(...allTimestamps)).toISOString(),
          totalTurns: sorted.reduce((sum, s) => sum + s.userTurns, 0),
          totalToolCalls: sorted.reduce((sum, s) => sum + s.toolCalls, 0),
        };
      });

      // Sort conversations by most recent activity
      conversations.sort(
        (a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime(),
      );

      return {
        name,
        cwd: data.cwd,
        conversations,
        totalConversations: conversations.length,
      };
    });

    // Sort projects by most recent conversation
    projects.sort((a, b) => {
      const aTime = a.conversations[0] ? new Date(a.conversations[0].lastActivity).getTime() : 0;
      const bTime = b.conversations[0] ? new Date(b.conversations[0].lastActivity).getTime() : 0;
      return bTime - aTime;
    });

    // Apply filter
    if (filter.trim()) {
      const q = filter.trim().toLowerCase();
      projects = projects
        .map((p) => {
          // Check if project matches
          const projectMatches = p.name.toLowerCase().includes(q) || p.cwd.toLowerCase().includes(q);
          if (projectMatches) return p;

          // Filter conversations by slug match
          const matchingConvs = p.conversations.filter((c) => c.slug.toLowerCase().includes(q));
          if (matchingConvs.length === 0) return null;

          return { ...p, conversations: matchingConvs, totalConversations: matchingConvs.length };
        })
        .filter((p): p is ProjectGroup => p !== null);
    }

    return projects;
  }, [sessions, filter]);

  // Total sessions count
  const totalSessions = useMemo(() => sessions.length, [sessions]);

  // Expensive threshold for detail
  const expensiveThreshold = useMemo(() => {
    if (!detail) return Infinity;
    const costs = detail.timeline
      .filter((m) => m.role === 'assistant' && m.tokens)
      .map((m) => m.tokens!.costUsd)
      .sort((a, b) => b - a);
    return costs[Math.max(Math.floor(costs.length * 0.1) - 1, 0)] ?? Infinity;
  }, [detail]);

  const toggleProject = useCallback((name: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const toggleConversation = useCallback((key: string) => {
    setCollapsedConversations((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  if (error) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: 32 }}>
        <div style={{ fontSize: 14, color: 'var(--text2)', marginBottom: 8 }}>Failed to load sessions</div>
        <div style={{ fontSize: 12, color: 'var(--text3, #666)' }}>{error}</div>
      </div>
    );
  }

  if (loading && sessions.length === 0) {
    return <div className="card" style={{ color: 'var(--text2)' }}>Loading sessions...</div>;
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 16, minHeight: 'calc(100vh - 120px)' }}>
      {/* ─── Left Sidebar: 3-Level Session List ──────────────────────────── */}
      <div className="card" style={{ padding: 0, overflow: 'auto', maxHeight: 'calc(100vh - 120px)' }}>
        <div style={{
          padding: '10px 16px', borderBottom: '1px solid var(--border, #222)',
          position: 'sticky', top: 0,
          background: 'var(--surface, #111)', zIndex: 3,
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
            Sessions ({totalSessions})
          </div>
          <input
            type="text"
            placeholder="Filter by project, path, or slug..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{
              width: '100%', padding: '5px 8px', fontSize: 12,
              background: 'var(--bg, #0d1117)', border: '1px solid var(--border, #333)',
              borderRadius: 4, color: 'var(--text)', outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>
        {grouped.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text2)', fontSize: 13 }}>
            {filter ? 'No matching sessions' : 'No sessions found'}
          </div>
        ) : (
          grouped.map((project) => {
            const isProjectCollapsed = collapsedProjects.has(project.name);
            return (
              <div key={project.name}>
                {/* ─── Level 1: Project Header ─────────────────────────── */}
                <div
                  onClick={() => toggleProject(project.name)}
                  style={{
                    padding: '10px 16px',
                    background: 'var(--bg2, #161b22)',
                    borderBottom: '1px solid var(--border, #222)',
                    cursor: 'pointer',
                    position: 'sticky', top: 72, zIndex: 2,
                    userSelect: 'none',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 10, color: 'var(--text3, #666)', width: 12, textAlign: 'center' }}>
                      {isProjectCollapsed ? '\u25B6' : '\u25BC'}
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                      {project.name}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text3, #666)', marginLeft: 'auto' }}>
                      {project.totalConversations} conv{project.totalConversations !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <div style={{
                    fontSize: 10, color: 'var(--text3, #666)', marginTop: 3, marginLeft: 20,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    fontFamily: 'var(--mono)',
                  }}>
                    {project.cwd.replace(/\\/g, '/')}
                  </div>
                </div>

                {/* ─── Level 2: Conversations ──────────────────────────── */}
                {!isProjectCollapsed && project.conversations.map((conv) => {
                  const convKey = `${project.name}:${conv.slug}`;
                  const isConvCollapsed = collapsedConversations.has(convKey);

                  return (
                    <div key={conv.slug}>
                      {/* Conversation Header */}
                      <div
                        onClick={() => toggleConversation(convKey)}
                        style={{
                          padding: '7px 16px 7px 36px',
                          borderBottom: '1px solid var(--border, #222)',
                          cursor: 'pointer',
                          userSelect: 'none',
                          background: 'var(--bg, #0d1117)',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 9, color: 'var(--text3, #666)', width: 10, textAlign: 'center' }}>
                            {isConvCollapsed ? '\u25B6' : '\u25BC'}
                          </span>
                          <span style={{
                            fontSize: 12, fontWeight: 500, color: '#58a6ff',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            maxWidth: 160,
                          }}>
                            {conv.displayName}
                          </span>
                          <span style={{ fontSize: 10, color: 'var(--text3, #666)', marginLeft: 'auto', flexShrink: 0 }}>
                            {conv.sessions.length} sess · {conv.totalTurns}t · {conv.totalToolCalls}tc
                          </span>
                        </div>
                        <div style={{
                          fontSize: 10, color: 'var(--text3, #666)', marginTop: 2, marginLeft: 18,
                        }}>
                          {fmtDateRange(conv.firstActivity, conv.lastActivity)}
                        </div>
                      </div>

                      {/* ─── Level 3: Sessions ────────────────────────── */}
                      {!isConvCollapsed && conv.sessions.map((s, idx) => {
                        const isSelected = selectedPath === s.jsonlPath;
                        return (
                          <div
                            key={s.jsonlPath}
                            onClick={() => loadDetail(s.jsonlPath)}
                            style={{
                              padding: '6px 16px 6px 56px',
                              cursor: 'pointer',
                              borderBottom: '1px solid var(--border, #222)',
                              background: isSelected ? 'var(--bg2, #161b22)' : 'transparent',
                              borderLeft: isSelected ? '3px solid #58a6ff' : '3px solid transparent',
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                              <span style={{ color: 'var(--text3, #666)', fontSize: 10, width: 20, textAlign: 'right', flexShrink: 0 }}>
                                #{idx + 1}
                              </span>
                              <span style={{ color: 'var(--text)' }}>{timeAgo(s.startedAt)}</span>
                              <span style={{ color: 'var(--text3, #666)', fontSize: 10, marginLeft: 'auto', flexShrink: 0 }}>
                                {s.userTurns}t / {s.toolCalls}tc
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>

      {/* ─── Right Panel: Token Audit Detail ─────────────────────────────── */}
      {detailLoading ? (
        <div className="card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text2)', fontSize: 13 }}>
          Loading token data...
        </div>
      ) : detailError ? (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--text2)', fontSize: 13 }}>
          <div style={{ color: '#f85149' }}>Failed to load token data</div>
          <div style={{ fontSize: 11, color: 'var(--text3, #666)', fontFamily: 'var(--mono)', maxWidth: 400, wordBreak: 'break-all' }}>{detailError}</div>
          {selectedPath && (
            <div style={{ fontSize: 10, color: 'var(--text3, #666)', fontFamily: 'var(--mono)', marginTop: 4 }}>
              Path: {selectedPath}
            </div>
          )}
        </div>
      ) : detail ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, overflow: 'auto', maxHeight: 'calc(100vh - 120px)' }}>
          {/* A. KPI Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10 }}>
            <KpiCard label="Total Cost" value={fmtCost(detail.totals.costUsd)} color={costColor(detail.totals.costUsd)} />
            <KpiCard label="Input Tokens" value={fmtTokens(detail.totals.inputTokens)} color="#58a6ff" />
            <KpiCard label="Output Tokens" value={fmtTokens(detail.totals.outputTokens)} color="#bc8cff" />
            <KpiCard label="Cache Savings" value={fmtCost(detail.totals.cacheSavingsUsd)} color="#3fb950" />
            <KpiCard
              label="Cache Hit Rate"
              value={`${detail.totals.cacheHitRate.toFixed(0)}%`}
              color={detail.totals.cacheHitRate > 50 ? '#3fb950' : '#d29922'}
            />
            <KpiCard label="Duration" value={fmtDuration(detail.durationMs)} sub={`${detail.userTurns} turns, ${detail.toolCalls} tools`} />
          </div>

          {/* B. Token Source Breakdown */}
          <div className="card">
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Token Source Breakdown</div>
            <SourceBreakdownBar breakdown={detail.sourceBreakdown} />
          </div>

          {/* C. Token Waterfall */}
          <div className="card">
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
              Token Waterfall
              <span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 400, marginLeft: 8 }}>
                per assistant turn
              </span>
            </div>
            <TokenWaterfallChart timeline={detail.timeline} />
          </div>

          {/* D. Message Timeline */}
          <div className="card" style={{ padding: 0 }}>
            <div style={{
              padding: '12px 16px', borderBottom: '1px solid var(--border, #222)',
              fontSize: 13, fontWeight: 600,
            }}>
              Message Timeline ({detail.timeline.length})
            </div>
            <div style={{ maxHeight: 500, overflow: 'auto' }}>
              <MessageTimeline timeline={detail.timeline} expensiveThreshold={expensiveThreshold} />
            </div>
          </div>

          {/* E. Cache Efficiency + F. Model Breakdown side by side */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {/* Cache Efficiency */}
            <div className="card">
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Cache Efficiency</div>
              <div style={{ fontSize: 36, fontWeight: 700, color: detail.totals.cacheHitRate > 50 ? '#3fb950' : '#d29922' }}>
                {detail.totals.cacheHitRate.toFixed(1)}%
              </div>
              <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 12 }}>cache hit rate</div>
              {/* Cost comparison bars */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                  <span style={{ width: 80, color: 'var(--text2)' }}>Actual</span>
                  <div style={{ flex: 1, height: 16, borderRadius: 3, overflow: 'hidden', background: 'var(--bg, #0d1117)' }}>
                    <div style={{
                      width: detail.totals.hypotheticalCostWithoutCache > 0
                        ? `${(detail.totals.costUsd / detail.totals.hypotheticalCostWithoutCache) * 100}%`
                        : '100%',
                      height: '100%', background: '#3fb950', borderRadius: 3,
                    }} />
                  </div>
                  <span style={{ width: 55, textAlign: 'right' }}>{fmtCost(detail.totals.costUsd)}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                  <span style={{ width: 80, color: 'var(--text2)' }}>No Cache</span>
                  <div style={{ flex: 1, height: 16, borderRadius: 3, overflow: 'hidden', background: 'var(--bg, #0d1117)' }}>
                    <div style={{ width: '100%', height: '100%', background: '#f85149', borderRadius: 3 }} />
                  </div>
                  <span style={{ width: 55, textAlign: 'right' }}>{fmtCost(detail.totals.hypotheticalCostWithoutCache)}</span>
                </div>
                <div style={{ fontSize: 12, color: '#3fb950', fontWeight: 600, marginTop: 4 }}>
                  {fmtCost(detail.totals.cacheSavingsUsd)} saved
                </div>
              </div>
            </div>

            {/* Model Breakdown */}
            <div className="card">
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Model Breakdown</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border, #333)', textAlign: 'left' }}>
                    <th style={{ padding: '6px 0', color: 'var(--text2)', fontWeight: 500 }}>Model</th>
                    <th style={{ padding: '6px 0', color: 'var(--text2)', fontWeight: 500, textAlign: 'right' }}>Requests</th>
                    <th style={{ padding: '6px 0', color: 'var(--text2)', fontWeight: 500, textAlign: 'right' }}>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.models.map((m) => (
                    <tr key={m.model} style={{ borderBottom: '1px solid var(--border, #222)' }}>
                      <td style={{ padding: '6px 0' }}>
                        <span style={{
                          fontSize: 11, padding: '1px 6px', borderRadius: 3,
                          background: '#bc8cff22', color: '#bc8cff',
                        }}>
                          {shortModel(m.model)}
                        </span>
                      </td>
                      <td style={{ padding: '6px 0', textAlign: 'right', color: 'var(--text2)' }}>{m.requests}</td>
                      <td style={{ padding: '6px 0', textAlign: 'right', color: costColor(m.costUsd) }}>{fmtCost(m.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        <div className="card" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text2)', fontSize: 13,
        }}>
          {sessions.length === 0
            ? 'No sessions found'
            : 'Select a session to view token audit'}
        </div>
      )}
    </div>
  );
}
