import { useEffect, useState, useMemo, useCallback } from 'react';
import { api, type TokenAnalytics, type ProjectEfficiency, type ContextOverhead, type OptimizationSuggestion } from '../api.js';

type Range = '7d' | '30d' | '90d' | 'all';

const RANGE_DAYS: Record<Range, number> = { '7d': 7, '30d': 30, '90d': 90, all: 365 };

// ─── Formatters ─────────────────────────────────────────────────────────────

function fmtCost(usd: number): string {
  if (usd < 0.01) return '<$0.01';
  if (usd < 10) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(1)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtNum(n: number): string {
  return n.toLocaleString();
}

function relativeTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const d = Math.floor(diff / 86400000);
  const h = Math.floor(diff / 3600000);
  const m = Math.floor(diff / 60000);
  if (d > 30) return new Date(ts).toLocaleDateString();
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return 'just now';
}

function costColor(usd: number): string {
  if (usd < 0.5) return '#3fb950';
  if (usd < 2) return '#d29922';
  return '#f85149';
}

function shortModel(model: string): string {
  return model
    .replace('claude-', '')
    .replace(/-20\d{6}$/, '');
}

// ─── KPI Card ───────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  color,
  sub,
}: {
  label: string;
  value: string | number;
  color: string;
  sub?: string;
}) {
  return (
    <div className="card">
      <div className="card-title">{label}</div>
      <div className="card-value" style={{ color }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// ─── Stacked Bar Chart (Daily) ──────────────────────────────────────────────

const TOKEN_COLORS = {
  input: '#58a6ff',
  output: '#bc8cff',
  cacheWrite: '#d29922',
  cacheRead: '#3fb950',
};

function DailyTokenChart({ daily }: { daily: TokenAnalytics['byDay'] }) {
  if (daily.length === 0) {
    return <div className="empty" style={{ padding: '24px 0' }}>No token data</div>;
  }

  const W = 600;
  const H = 100;
  const days = daily.length;
  const slotW = W / Math.max(days, 1);
  const barW = Math.max(slotW - 2, 2);
  const maxVal = Math.max(
    ...daily.map((d) => d.inputTokens + d.outputTokens + d.cacheWriteTokens + d.cacheReadTokens),
    1,
  );
  const labelEvery = days <= 7 ? 1 : days <= 14 ? 2 : days <= 30 ? 5 : 10;

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 8, fontSize: 11, color: 'var(--text2)', flexWrap: 'wrap' }}>
        {Object.entries(TOKEN_COLORS).map(([key, color]) => (
          <span key={key}>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 1, background: color, marginRight: 4 }} />
            {key === 'cacheWrite' ? 'Cache Write' : key === 'cacheRead' ? 'Cache Read' : key.charAt(0).toUpperCase() + key.slice(1)}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H + 18}`} style={{ width: '100%', height: H + 18 }}>
        {daily.map((d, i) => {
          const x = i * slotW + 1;
          const total = d.inputTokens + d.outputTokens + d.cacheWriteTokens + d.cacheReadTokens;
          const label = new Date(d.date + 'T00:00:00').toLocaleDateString('en', { month: 'short', day: 'numeric' });

          const segments = [
            { key: 'input', val: d.inputTokens, color: TOKEN_COLORS.input },
            { key: 'output', val: d.outputTokens, color: TOKEN_COLORS.output },
            { key: 'cacheWrite', val: d.cacheWriteTokens, color: TOKEN_COLORS.cacheWrite },
            { key: 'cacheRead', val: d.cacheReadTokens, color: TOKEN_COLORS.cacheRead },
          ];

          let cumH = 0;
          return (
            <g key={d.date}>
              <title>{label}: {fmtTokens(total)} tokens, {fmtCost(d.estimatedCostUsd)}</title>
              <rect x={x} y={0} width={barW} height={H} fill="var(--bg3)" rx={1} opacity={0.5} />
              {segments.map((seg) => {
                if (seg.val === 0) return null;
                const segH = (seg.val / maxVal) * H;
                cumH += segH;
                return (
                  <rect
                    key={seg.key}
                    x={x}
                    y={H - cumH}
                    width={barW}
                    height={segH}
                    fill={seg.color}
                    opacity={0.85}
                    rx={1}
                  />
                );
              })}
              {i % labelEvery === 0 && (
                <text x={x + barW / 2} y={H + 15} textAnchor="middle" fill="var(--text2)" fontSize={9} fontFamily="var(--font)">
                  {label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ─── Model Cost Bars ────────────────────────────────────────────────────────

const MODEL_COLORS = ['#58a6ff', '#bc8cff', '#3fb950', '#d29922', '#f85149', '#8b949e'];

function ModelCostBars({ models }: { models: TokenAnalytics['byModel'] }) {
  if (models.length === 0) {
    return <div className="empty" style={{ padding: '24px 0' }}>No model data</div>;
  }

  const max = Math.max(...models.map((m) => m.estimatedCostUsd), 0.01);

  return (
    <div>
      {models.map((m, i) => (
        <div key={m.model} style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '65%' }}>
              {shortModel(m.model)}
            </span>
            <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text2)' }}>
              {fmtCost(m.estimatedCostUsd)} ({fmtNum(m.requestCount)} req)
            </span>
          </div>
          <div style={{ height: 6, background: 'var(--bg3)', borderRadius: 3, overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: `${(m.estimatedCostUsd / max) * 100}%`,
                background: MODEL_COLORS[i % MODEL_COLORS.length],
                borderRadius: 3,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Token Breakdown Donut ──────────────────────────────────────────────────

function TokenDonut({ data }: { data: TokenAnalytics }) {
  const segments = [
    { label: 'Input', value: data.totalInputTokens, color: TOKEN_COLORS.input },
    { label: 'Output', value: data.totalOutputTokens, color: TOKEN_COLORS.output },
    { label: 'Cache Write', value: data.totalCacheWriteTokens, color: TOKEN_COLORS.cacheWrite },
    { label: 'Cache Read', value: data.totalCacheReadTokens, color: TOKEN_COLORS.cacheRead },
  ].filter((s) => s.value > 0);

  const total = segments.reduce((s, v) => s + v.value, 0);
  if (total === 0) {
    return <div className="empty" style={{ padding: '24px 0' }}>No token data</div>;
  }

  const cx = 70;
  const cy = 70;
  const r = 55;
  const ir = 35;

  let cumAngle = -Math.PI / 2;
  const arcs = segments.map((seg) => {
    const angle = (seg.value / total) * 2 * Math.PI;
    const startAngle = cumAngle;
    cumAngle += angle;
    const endAngle = cumAngle;

    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const ix1 = cx + ir * Math.cos(endAngle);
    const iy1 = cy + ir * Math.sin(endAngle);
    const ix2 = cx + ir * Math.cos(startAngle);
    const iy2 = cy + ir * Math.sin(startAngle);

    const largeArc = angle > Math.PI ? 1 : 0;

    const d = [
      `M ${x1} ${y1}`,
      `A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`,
      `L ${ix1} ${iy1}`,
      `A ${ir} ${ir} 0 ${largeArc} 0 ${ix2} ${iy2}`,
      'Z',
    ].join(' ');

    return { ...seg, d, pct: ((seg.value / total) * 100).toFixed(1) };
  });

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
      <svg viewBox="0 0 140 140" style={{ width: 140, height: 140, flexShrink: 0 }}>
        {arcs.map((arc) => (
          <path key={arc.label} d={arc.d} fill={arc.color} opacity={0.85}>
            <title>{arc.label}: {fmtTokens(arc.value)} ({arc.pct}%)</title>
          </path>
        ))}
        <text x={cx} y={cy - 4} textAnchor="middle" fill="var(--text)" fontSize={14} fontFamily="var(--font)">
          {fmtTokens(total)}
        </text>
        <text x={cx} y={cy + 12} textAnchor="middle" fill="var(--text2)" fontSize={9} fontFamily="var(--font)">
          total
        </text>
      </svg>
      <div style={{ fontSize: 12 }}>
        {arcs.map((arc) => (
          <div key={arc.label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 1, background: arc.color, flexShrink: 0 }} />
            <span style={{ color: 'var(--text2)' }}>{arc.label}</span>
            <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{arc.pct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Project Cost Bars ──────────────────────────────────────────────────────

function ProjectCostBars({ projects }: { projects: TokenAnalytics['byProject'] }) {
  const top = projects.slice(0, 10);
  if (top.length === 0) {
    return <div className="empty" style={{ padding: '24px 0' }}>No project data</div>;
  }

  const max = Math.max(...top.map((p) => p.estimatedCostUsd), 0.01);

  return (
    <div>
      {top.map((p) => (
        <div key={p.cwd} style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
            <span
              style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '65%' }}
              title={p.cwd}
            >
              {p.project}
            </span>
            <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text2)' }}>
              {fmtCost(p.estimatedCostUsd)}
            </span>
          </div>
          <div style={{ height: 4, background: 'var(--bg3)', borderRadius: 2, overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: `${(p.estimatedCostUsd / max) * 100}%`,
                background: '#bc8cff',
                borderRadius: 2,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Top Sessions Table ─────────────────────────────────────────────────────

type SortKey = 'cost' | 'input' | 'output' | 'cacheRead' | 'requests';

function TopSessionsTable({ sessions }: { sessions: TokenAnalytics['topSessions'] }) {
  const [sortBy, setSortBy] = useState<SortKey>('cost');

  const sorted = useMemo(() => {
    const copy = [...sessions];
    switch (sortBy) {
      case 'cost': return copy.sort((a, b) => b.totalEstimatedCostUsd - a.totalEstimatedCostUsd);
      case 'input': return copy.sort((a, b) => b.totalInputTokens - a.totalInputTokens);
      case 'output': return copy.sort((a, b) => b.totalOutputTokens - a.totalOutputTokens);
      case 'cacheRead': return copy.sort((a, b) => b.totalCacheReadTokens - a.totalCacheReadTokens);
      case 'requests': return copy.sort((a, b) => b.requestCount - a.requestCount);
    }
  }, [sessions, sortBy]);

  if (sessions.length === 0) {
    return <div className="empty">No sessions with token data</div>;
  }

  const thStyle = (key: SortKey): React.CSSProperties => ({
    cursor: 'pointer',
    userSelect: 'none',
    color: sortBy === key ? 'var(--accent)' : undefined,
  });

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Project</th>
            <th>Model</th>
            <th style={thStyle('input')} onClick={() => setSortBy('input')}>Input{sortBy === 'input' ? ' v' : ''}</th>
            <th style={thStyle('output')} onClick={() => setSortBy('output')}>Output{sortBy === 'output' ? ' v' : ''}</th>
            <th style={thStyle('cacheRead')} onClick={() => setSortBy('cacheRead')}>Cache Read{sortBy === 'cacheRead' ? ' v' : ''}</th>
            <th style={thStyle('cost')} onClick={() => setSortBy('cost')}>Est. Cost{sortBy === 'cost' ? ' v' : ''}</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((s, i) => {
            const projectName = s.cwd ? s.cwd.split(/[/\\]/).pop() ?? s.cwd : 'unknown';
            const primaryModel = s.models.length > 0
              ? shortModel([...s.models].sort((a, b) => b.requestCount - a.requestCount)[0]!.model)
              : '-';
            return (
              <tr key={`${s.sessionId}-${i}`}>
                <td
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}
                  title={s.cwd}
                >
                  {projectName}
                </td>
                <td style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{primaryModel}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtTokens(s.totalInputTokens)}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtTokens(s.totalOutputTokens)}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtTokens(s.totalCacheReadTokens)}</td>
                <td>
                  <span
                    className="badge"
                    style={{
                      background: costColor(s.totalEstimatedCostUsd) + '22',
                      color: costColor(s.totalEstimatedCostUsd),
                    }}
                  >
                    {fmtCost(s.totalEstimatedCostUsd)}
                  </span>
                </td>
                <td style={{ whiteSpace: 'nowrap', color: 'var(--text2)', fontSize: 12 }}>
                  {relativeTime(s.startedAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Efficiency Gauge ───────────────────────────────────────────────────────

function EfficiencyGauge({ label, value, format, color, sub }: {
  label: string;
  value: number;
  format: (n: number) => string;
  color: string;
  sub?: string;
}) {
  return (
    <div style={{ textAlign: 'center', flex: '1 1 0', minWidth: 100 }}>
      <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color, fontVariantNumeric: 'tabular-nums' }}>
        {format(value)}
      </div>
      {sub && <div style={{ fontSize: 10, color: 'var(--text2)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ─── Project Efficiency Table ───────────────────────────────────────────────

type EffSortKey = 'sessions' | 'cost' | 'costPerTurn' | 'cacheHit' | 'turnsPerSession' | 'toolsPerSession';

function ProjectEfficiencyTable({ projects }: { projects: ProjectEfficiency[] }) {
  const [sortBy, setSortBy] = useState<EffSortKey>('sessions');

  const sorted = useMemo(() => {
    const copy = [...projects];
    switch (sortBy) {
      case 'sessions': return copy.sort((a, b) => b.sessions - a.sessions);
      case 'cost': return copy.sort((a, b) => b.totalCost - a.totalCost);
      case 'costPerTurn': return copy.sort((a, b) => b.avgCostPerTurn - a.avgCostPerTurn);
      case 'cacheHit': return copy.sort((a, b) => b.cacheHitRate - a.cacheHitRate);
      case 'turnsPerSession': return copy.sort((a, b) => b.avgTurnsPerSession - a.avgTurnsPerSession);
      case 'toolsPerSession': return copy.sort((a, b) => b.avgToolCallsPerSession - a.avgToolCallsPerSession);
    }
  }, [projects, sortBy]);

  if (projects.length === 0) {
    return <div className="empty">No project data</div>;
  }

  const thStyle = (key: EffSortKey): React.CSSProperties => ({
    cursor: 'pointer',
    userSelect: 'none',
    color: sortBy === key ? 'var(--accent)' : undefined,
    whiteSpace: 'nowrap',
  });

  const arrow = (key: EffSortKey) => sortBy === key ? ' v' : '';

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Project</th>
            <th style={thStyle('sessions')} onClick={() => setSortBy('sessions')}>Sessions{arrow('sessions')}</th>
            <th style={thStyle('cost')} onClick={() => setSortBy('cost')}>Total Cost{arrow('cost')}</th>
            <th style={thStyle('costPerTurn')} onClick={() => setSortBy('costPerTurn')}>$/Turn{arrow('costPerTurn')}</th>
            <th style={thStyle('cacheHit')} onClick={() => setSortBy('cacheHit')}>Cache Hit{arrow('cacheHit')}</th>
            <th style={thStyle('turnsPerSession')} onClick={() => setSortBy('turnsPerSession')}>Turns/Sess{arrow('turnsPerSession')}</th>
            <th style={thStyle('toolsPerSession')} onClick={() => setSortBy('toolsPerSession')}>Tools/Sess{arrow('toolsPerSession')}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, 20).map((p) => (
            <tr key={p.cwd}>
              <td
                style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}
                title={p.cwd}
              >
                {p.project}
              </td>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{p.sessions}</td>
              <td>
                <span
                  className="badge"
                  style={{
                    background: costColor(p.totalCost) + '22',
                    color: costColor(p.totalCost),
                  }}
                >
                  {fmtCost(p.totalCost)}
                </span>
              </td>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtCost(p.avgCostPerTurn)}</td>
              <td>
                <span style={{ color: p.cacheHitRate >= 50 ? '#3fb950' : p.cacheHitRate >= 20 ? '#d29922' : 'var(--text2)' }}>
                  {p.cacheHitRate.toFixed(1)}%
                </span>
              </td>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{p.avgTurnsPerSession.toFixed(1)}</td>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{p.avgToolCallsPerSession.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Efficiency Section ─────────────────────────────────────────────────────

function EfficiencySection({ data }: { data: TokenAnalytics }) {
  const eff = data.efficiency;

  return (
    <>
      {/* Global efficiency gauges */}
      <div className="chart-card">
        <div className="chart-title">Claude Code Efficiency</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '12px 0' }}>
          <EfficiencyGauge
            label="Avg Cost / Turn"
            value={eff.avgCostPerTurn}
            format={fmtCost}
            color="var(--accent)"
            sub={`${fmtNum(eff.totalUserTurns)} total turns`}
          />
          <EfficiencyGauge
            label="Avg Tokens / Turn"
            value={eff.avgTokensPerTurn}
            format={fmtTokens}
            color="var(--text)"
          />
          <EfficiencyGauge
            label="Output / Input"
            value={eff.avgOutputPerInput}
            format={(n) => `${(n * 100).toFixed(1)}%`}
            color={eff.avgOutputPerInput < 0.05 ? '#3fb950' : eff.avgOutputPerInput < 0.15 ? '#d29922' : '#f85149'}
            sub="lower = more context-heavy"
          />
          <EfficiencyGauge
            label="Cache Hit Rate"
            value={eff.cacheHitRate}
            format={(n) => `${n.toFixed(1)}%`}
            color={eff.cacheHitRate >= 50 ? '#3fb950' : eff.cacheHitRate >= 20 ? '#d29922' : '#f85149'}
            sub="of input tokens"
          />
          <EfficiencyGauge
            label="Avg Turns / Session"
            value={eff.avgTurnsPerSession}
            format={(n) => n.toFixed(1)}
            color="var(--text)"
            sub={`${fmtNum(eff.totalSessions)} sessions`}
          />
          <EfficiencyGauge
            label="Avg Tools / Session"
            value={eff.avgToolCallsPerSession}
            format={(n) => n.toFixed(1)}
            color="#bc8cff"
            sub={`${fmtNum(eff.totalToolCalls)} total`}
          />
          <EfficiencyGauge
            label="Avg Cost / Session"
            value={eff.avgCostPerSession}
            format={fmtCost}
            color="var(--accent)"
          />
        </div>
      </div>

      {/* Per-project efficiency table */}
      <section>
        <div className="section-header">
          <span className="section-title">Efficiency by Project</span>
          <span style={{ fontSize: 12, color: 'var(--text2)' }}>
            {eff.byProject.length} project{eff.byProject.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="card" style={{ padding: 0 }}>
          <ProjectEfficiencyTable projects={eff.byProject} />
        </div>
      </section>
    </>
  );
}

// ─── Context Overhead Section ────────────────────────────────────────────────

const CAT_COLORS: Record<string, string> = {
  'Global Rules': '#58a6ff',
  'CLAUDE.md': '#bc8cff',
  'CLAUDE.md (manual)': '#bc8cff',
  'CLAUDE.md (nexus auto-gen)': '#f0883e',
  'MEMORY.md': '#3fb950',
  'Project Rules': '#d29922',
  'Hook Prompt': '#f85149',
  'Skills': '#8b949e',
};

const SEVERITY_COLORS: Record<string, string> = {
  high: '#f85149',
  medium: '#d29922',
  low: '#8b949e',
};

function OverheadBar({ label, tokens, maxTokens, color, sub }: {
  label: string; tokens: number; maxTokens: number; color: string; sub?: string;
}) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '65%' }}>
          {label}
        </span>
        <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text2)', fontSize: 11 }}>
          ~{fmtTokens(tokens)}{sub ? ` ${sub}` : ''}
        </span>
      </div>
      <div style={{ height: 5, background: 'var(--bg3)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{
          height: '100%',
          width: `${Math.max((tokens / maxTokens) * 100, 1)}%`,
          background: color,
          borderRadius: 2,
          opacity: 0.85,
        }} />
      </div>
    </div>
  );
}

function SuggestionCard({ suggestion }: { suggestion: OptimizationSuggestion }) {
  const sevColor = SEVERITY_COLORS[suggestion.severity] ?? '#8b949e';
  return (
    <div style={{
      padding: '10px 12px',
      background: 'var(--bg2)',
      borderRadius: 6,
      borderLeft: `3px solid ${sevColor}`,
      marginBottom: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span className="badge" style={{ background: sevColor + '22', color: sevColor, fontSize: 10, textTransform: 'uppercase' }}>
          {suggestion.severity}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text2)' }}>{suggestion.category}</span>
      </div>
      <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 4 }}>{suggestion.title}</div>
      <div style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.4 }}>{suggestion.description}</div>
      <div style={{ display: 'flex', gap: 16, marginTop: 6, fontSize: 11 }}>
        <span style={{ color: 'var(--text2)' }}>Current: <strong style={{ color: 'var(--text)' }}>~{fmtTokens(suggestion.currentTokens)}</strong></span>
        <span style={{ color: '#3fb950' }}>Potential savings: <strong>~{fmtTokens(suggestion.potentialSavings)}</strong></span>
      </div>
    </div>
  );
}

function ContextOverheadSection({ overhead }: { overhead: ContextOverhead }) {
  const [expandedProject, setExpandedProject] = useState<string | null>(null);
  const [showAllSkills, setShowAllSkills] = useState(false);

  const globalBaseline = overhead.globalRulesTotal + overhead.skillsEstTokens + overhead.hookPromptsTotal;
  const maxProject = Math.max(...overhead.projects.map((p) => p.totalSessionLoad), 1);

  return (
    <>
      {/* Row 1: Global breakdown + Hooks & Skills */}
      <div className="grid-2">
        <div className="chart-card">
          <div className="chart-title">Global Context Baseline</div>
          <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 12 }}>
            Loaded into every conversation, every message
          </div>

          {/* Global rules detail */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 6, color: '#58a6ff' }}>Rules Files ({overhead.globalRules.length})</div>
            {overhead.globalRules.map((r) => (
              <div key={r.file} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '3px 0' }}>
                <span title={r.summary ?? ''}>
                  <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 1, background: '#58a6ff', marginRight: 6, opacity: 0.7 }} />
                  {r.file}
                </span>
                <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text2)' }}>
                  {r.words}w / ~{fmtTokens(r.estimatedTokens)}
                </span>
              </div>
            ))}
            <div style={{ fontSize: 11, fontWeight: 500, textAlign: 'right', marginTop: 4, color: '#58a6ff' }}>
              Subtotal: ~{fmtTokens(overhead.globalRulesTotal)}
            </div>
          </div>

          {/* Hooks */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 6, color: '#f85149' }}>
              Hooks ({overhead.hooks.length}: {overhead.hookCommandsCount} cmd, {overhead.hooks.length - overhead.hookCommandsCount} prompt)
            </div>
            {overhead.hooks.map((h, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '2px 0' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>
                  <span style={{
                    display: 'inline-block', width: 6, height: 6, borderRadius: 1, marginRight: 6,
                    background: h.type === 'prompt' ? '#f85149' : '#8b949e', opacity: 0.7,
                  }} />
                  {h.event} ({h.type})
                </span>
                <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text2)' }}>
                  {h.type === 'prompt' ? `${h.words}w / ~${fmtTokens(h.estimatedTokens)}` : 'no injection'}
                </span>
              </div>
            ))}
            <div style={{ fontSize: 11, fontWeight: 500, textAlign: 'right', marginTop: 4, color: '#f85149' }}>
              Prompt injection: ~{fmtTokens(overhead.hookPromptsTotal)}
            </div>
          </div>

          {/* Skills summary */}
          <div>
            <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 6, color: '#8b949e' }}>
              Skills ({overhead.skillsCount} registered)
            </div>
            <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 4 }}>
              Names listed in system prompt (~{fmtTokens(overhead.skillsEstTokens)}). Content lazy-loaded on invocation.
            </div>
            {(showAllSkills ? overhead.skills : overhead.skills.slice(0, 5)).map((s) => (
              <div key={s.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '2px 0' }}>
                <span>
                  <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 1, background: '#8b949e', marginRight: 6, opacity: 0.7 }} />
                  {s.name}
                </span>
                <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text2)' }}>
                  {s.hasSkillMd ? `${s.words}w / ~${fmtTokens(s.estimatedTokens)}` : 'no SKILL.md'}
                </span>
              </div>
            ))}
            {overhead.skills.length > 5 && (
              <button
                onClick={() => setShowAllSkills(!showAllSkills)}
                style={{ fontSize: 11, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0' }}
              >
                {showAllSkills ? 'Show less' : `Show all ${overhead.skills.length} skills...`}
              </button>
            )}
          </div>

          <div style={{ marginTop: 12, padding: '8px 10px', background: 'var(--bg3)', borderRadius: 6, fontSize: 12 }}>
            <strong style={{ color: 'var(--accent)' }}>Global baseline: ~{fmtTokens(globalBaseline)}</strong>
            <span style={{ color: 'var(--text2)' }}> before any project context</span>
          </div>
        </div>

        {/* Per-project session load */}
        <div className="chart-card">
          <div className="chart-title">Per-Project Session Load</div>
          <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 12 }}>
            Total tokens loaded when working in each project (global + project-specific)
          </div>
          {overhead.projects.slice(0, 20).map((proj) => {
            const isExpanded = expandedProject === proj.cwd;
            return (
              <div key={proj.cwd}>
                <div
                  style={{ cursor: 'pointer' }}
                  onClick={() => setExpandedProject(isExpanded ? null : proj.cwd)}
                >
                  <OverheadBar
                    label={`${isExpanded ? '▾' : '▸'} ${proj.project}`}
                    tokens={proj.totalSessionLoad}
                    maxTokens={maxProject}
                    color={proj.totalSessionLoad > 10000 ? '#f85149' : proj.totalSessionLoad > 5000 ? '#d29922' : '#3fb950'}
                    sub={proj.nexusSectionPct > 0 ? `(${proj.nexusSectionPct}% auto-gen)` : undefined}
                  />
                </div>
                {isExpanded && (
                  <div style={{ marginLeft: 16, marginBottom: 10, paddingLeft: 8, borderLeft: '2px solid var(--bg3)' }}>
                    {proj.items.map((item, idx) => (
                      <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, padding: '3px 0' }}>
                        <span title={item.summary ?? ''}>
                          <span style={{
                            display: 'inline-block', width: 6, height: 6, borderRadius: 1, marginRight: 6,
                            background: CAT_COLORS[item.category] ?? '#8b949e', opacity: 0.8,
                          }} />
                          {item.category === 'CLAUDE.md (nexus auto-gen)' ? 'Nexus auto-gen section' : item.file}
                        </span>
                        <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text2)' }}>
                          {item.words}w / ~{fmtTokens(item.estimatedTokens)}
                        </span>
                      </div>
                    ))}
                    <div style={{ fontSize: 11, marginTop: 4, color: 'var(--text2)' }}>
                      Project: ~{fmtTokens(proj.totalTokens)} + Global: ~{fmtTokens(globalBaseline)} = <strong style={{ color: 'var(--text)' }}>~{fmtTokens(proj.totalSessionLoad)}</strong>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Row 2: Optimization Suggestions */}
      {overhead.suggestions.length > 0 && (
        <div className="chart-card">
          <div className="chart-title">
            Optimization Suggestions
            <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text2)', marginLeft: 8 }}>
              {overhead.suggestions.filter((s) => s.severity === 'high').length} high,{' '}
              {overhead.suggestions.filter((s) => s.severity === 'medium').length} medium,{' '}
              {overhead.suggestions.filter((s) => s.severity === 'low').length} low
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 12 }}>
            Total potential savings: ~{fmtTokens(overhead.suggestions.reduce((s, sg) => s + sg.potentialSavings, 0))} tokens
          </div>
          {overhead.suggestions.map((s, i) => (
            <SuggestionCard key={i} suggestion={s} />
          ))}
        </div>
      )}
    </>
  );
}

// ─── Token Audit Page ───────────────────────────────────────────────────────

export function TokenAudit() {
  const [range, setRange] = useState<Range>('30d');
  const [data, setData] = useState<TokenAnalytics | null>(null);
  const [overhead, setOverhead] = useState<ContextOverhead | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const days = RANGE_DAYS[range];
      const [result, oh] = await Promise.all([
        api.analytics.tokens(days),
        api.analytics.contextOverhead(),
      ]);
      setData(result);
      setOverhead(oh);
    } catch (e) {
      console.error('Token analytics load error:', e);
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  if (loading || !data) return <div className="loading">Loading...</div>;

  const totalTokens = data.totalInputTokens + data.totalOutputTokens + data.totalCacheWriteTokens + data.totalCacheReadTokens;
  const totalInputWithCache = data.totalInputTokens + data.totalCacheReadTokens + data.totalCacheWriteTokens;
  const cacheHitRate = totalInputWithCache > 0
    ? (data.totalCacheReadTokens / totalInputWithCache) * 100
    : 0;

  return (
    <div className="stacked">
      {/* Filter bar */}
      <div className="filter-bar">
        <div className="range-btns">
          {(['7d', '30d', '90d', 'all'] as Range[]).map((r) => (
            <button
              key={r}
              className={`range-btn${range === r ? ' active' : ''}`}
              onClick={() => setRange(r)}
            >
              {r === 'all' ? 'All time' : r}
            </button>
          ))}
        </div>
        <button className="btn" onClick={load} disabled={refreshing} style={{ marginLeft: 'auto' }}>
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {/* KPI strip */}
      <div className="stats-grid">
        <KpiCard
          label="Estimated Cost"
          value={fmtCost(data.totalEstimatedCostUsd)}
          color="var(--accent)"
          sub={`API-equivalent in ${range === 'all' ? 'all time' : range}`}
        />
        <KpiCard
          label="Total Tokens"
          value={fmtTokens(totalTokens)}
          color="var(--text)"
          sub={`${fmtTokens(data.totalInputTokens)} in / ${fmtTokens(data.totalOutputTokens)} out`}
        />
        <KpiCard
          label="Requests"
          value={fmtNum(data.totalRequests)}
          color="var(--text2)"
          sub={`${data.byModel.length} model${data.byModel.length !== 1 ? 's' : ''}`}
        />
        <KpiCard
          label="Cache Savings"
          value={fmtCost(data.cacheSavingsUsd)}
          color="#3fb950"
          sub="saved via prompt caching"
        />
        <KpiCard
          label="Cache Hit Rate"
          value={`${cacheHitRate.toFixed(1)}%`}
          color={cacheHitRate >= 50 ? '#3fb950' : cacheHitRate >= 20 ? '#d29922' : 'var(--text2)'}
          sub="of input from cache"
        />
      </div>

      {/* Row 2: Daily + Model */}
      <div className="grid-2">
        <div className="chart-card">
          <div className="chart-title">Daily Token Usage</div>
          <DailyTokenChart daily={data.byDay} />
        </div>
        <div className="chart-card">
          <div className="chart-title">Cost by Model</div>
          <ModelCostBars models={data.byModel} />
        </div>
      </div>

      {/* Row 3: Breakdown + Projects */}
      <div className="grid-2">
        <div className="chart-card">
          <div className="chart-title">Token Breakdown</div>
          <TokenDonut data={data} />
        </div>
        <div className="chart-card">
          <div className="chart-title">Top Projects by Cost</div>
          <ProjectCostBars projects={data.byProject} />
        </div>
      </div>

      {/* Row 4: Context Overhead */}
      {overhead && <ContextOverheadSection overhead={overhead} />}

      {/* Row 5: Efficiency */}
      <EfficiencySection data={data} />

      {/* Row 6: Sessions table */}
      <section>
        <div className="section-header">
          <span className="section-title">Top Sessions by Cost</span>
          <span style={{ fontSize: 12, color: 'var(--text2)' }}>
            Top {Math.min(data.topSessions.length, 15)}
          </span>
        </div>
        <div className="card" style={{ padding: 0 }}>
          <TopSessionsTable sessions={data.topSessions} />
        </div>
      </section>
    </div>
  );
}
