import { useEffect, useState, useMemo, useCallback } from 'react';
import { api, type SessionAnalytics, type AuditCountByDay } from '../api.js';

type Range = '7d' | '30d' | '90d' | 'all';

const RANGE_DAYS: Record<Range, number> = { '7d': 7, '30d': 30, '90d': 90, all: 365 };

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

function formatDuration(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

// ─── KPI Card ────────────────────────────────────────────────────────────────

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
      <div className="card-value" style={{ color: `var(--${color})` }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// ─── Horizontal Bar ──────────────────────────────────────────────────────────

function HBar({
  items,
  maxVal,
  color,
}: {
  items: Array<{ label: string; value: number }>;
  maxVal?: number;
  color: string;
}) {
  const max = maxVal ?? Math.max(...items.map((i) => i.value), 1);
  return (
    <div>
      {items.map((item) => (
        <div key={item.label} style={{ marginBottom: 10 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 12,
              marginBottom: 4,
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '72%' }}>
              {item.label}
            </span>
            <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text2)' }}>
              {item.value}
            </span>
          </div>
          <div style={{ height: 4, background: 'var(--bg3)', borderRadius: 2, overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: `${(item.value / max) * 100}%`,
                background: color,
                borderRadius: 2,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Comparison Bars ─────────────────────────────────────────────────────────

function ComparisonBars({ data }: { data: SessionAnalytics }) {
  const metrics = [
    { label: 'Avg User Turns', with: data.withNexusAvg.userTurns, without: data.withoutNexusAvg.userTurns },
    { label: 'Avg Tool Calls', with: data.withNexusAvg.toolCalls, without: data.withoutNexusAvg.toolCalls },
    { label: 'Avg Duration', with: data.withNexusAvg.durationMs, without: data.withoutNexusAvg.durationMs, format: true },
  ];

  const maxVal = Math.max(
    ...metrics.flatMap((m) => [m.with, m.without]),
    1,
  );

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 12, fontSize: 11, color: 'var(--text2)' }}>
        <span>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 1, background: '#58a6ff', marginRight: 4 }} />
          With Nexus
        </span>
        <span>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 1, background: '#8b949e', marginRight: 4 }} />
          Without Nexus
        </span>
      </div>
      {metrics.map((m) => (
        <div key={m.label} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 6 }}>{m.label}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
            <div style={{ height: 6, flex: 1, background: 'var(--bg3)', borderRadius: 3, overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${(m.with / maxVal) * 100}%`,
                  background: '#58a6ff',
                  borderRadius: 3,
                }}
              />
            </div>
            <span style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums', minWidth: 40, textAlign: 'right' }}>
              {m.format ? formatDuration(m.with) : m.with}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ height: 6, flex: 1, background: 'var(--bg3)', borderRadius: 3, overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${(m.without / maxVal) * 100}%`,
                  background: '#8b949e',
                  borderRadius: 3,
                }}
              />
            </div>
            <span style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums', minWidth: 40, textAlign: 'right' }}>
              {m.format ? formatDuration(m.without) : m.without}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Adoption Trend Chart ────────────────────────────────────────────────────

function AdoptionChart({ daily }: { daily: SessionAnalytics['dailyAdoption'] }) {
  if (daily.length === 0) {
    return <div className="empty" style={{ padding: '24px 0' }}>No session data</div>;
  }

  const W = 600;
  const H = 80;
  const days = daily.length;
  const slotW = W / Math.max(days, 1);
  const barW = Math.max(slotW - 2, 2);
  const maxVal = Math.max(...daily.map((d) => d.withNexus + d.withoutNexus), 1);
  const labelEvery = days <= 7 ? 1 : days <= 14 ? 2 : days <= 30 ? 5 : 10;

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 8, fontSize: 11, color: 'var(--text2)' }}>
        <span>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 1, background: '#3fb950', marginRight: 4 }} />
          With Nexus
        </span>
        <span>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 1, background: '#484f58', marginRight: 4 }} />
          Without Nexus
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H + 18}`} style={{ width: '100%', height: H + 18 }}>
        {daily.map((d, i) => {
          const x = i * slotW + 1;
          const totalH = ((d.withNexus + d.withoutNexus) / maxVal) * H;
          const nexusH = (d.withNexus / maxVal) * H;
          const otherH = (d.withoutNexus / maxVal) * H;
          const label = new Date(d.date + 'T00:00:00').toLocaleDateString('en', { month: 'short', day: 'numeric' });
          return (
            <g key={d.date}>
              <title>{label}: {d.withNexus} with, {d.withoutNexus} without</title>
              <rect x={x} y={0} width={barW} height={H} fill="var(--bg3)" rx={1} opacity={0.5} />
              {otherH > 0 && <rect x={x} y={H - otherH} width={barW} height={otherH} fill="#484f58" opacity={0.7} rx={1} />}
              {nexusH > 0 && <rect x={x} y={H - totalH} width={barW} height={nexusH} fill="#3fb950" opacity={0.85} rx={1} />}
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

// ─── Audit Activity Chart ────────────────────────────────────────────────────

const SOURCE_COLORS: Record<string, string> = {
  cli: '#58a6ff',
  mcp: '#bc8cff',
  daemon: '#3fb950',
  test: '#8b949e',
};

function AuditChart({ auditDaily }: { auditDaily: AuditCountByDay[] }) {
  const grouped = useMemo(() => {
    const map = new Map<string, Record<string, number>>();
    for (const entry of auditDaily) {
      const rec = map.get(entry.date) ?? {};
      rec[entry.source] = (rec[entry.source] ?? 0) + entry.count;
      map.set(entry.date, rec);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, sources]) => ({ date, sources }));
  }, [auditDaily]);

  if (grouped.length === 0) {
    return <div className="empty" style={{ padding: '24px 0' }}>No audit data</div>;
  }

  const sources = [...new Set(auditDaily.map((e) => e.source))];
  const W = 600;
  const H = 80;
  const days = grouped.length;
  const slotW = W / Math.max(days, 1);
  const barW = Math.max(slotW - 2, 2);
  const maxVal = Math.max(
    ...grouped.map((g) => Object.values(g.sources).reduce((s, v) => s + v, 0)),
    1,
  );
  const labelEvery = days <= 7 ? 1 : days <= 14 ? 2 : days <= 30 ? 5 : 10;

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 8, fontSize: 11, color: 'var(--text2)' }}>
        {sources.map((s) => (
          <span key={s}>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 1, background: SOURCE_COLORS[s] ?? '#8b949e', marginRight: 4 }} />
            {s}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H + 18}`} style={{ width: '100%', height: H + 18 }}>
        {grouped.map((g, i) => {
          const x = i * slotW + 1;
          const total = Object.values(g.sources).reduce((s, v) => s + v, 0);
          const label = new Date(g.date + 'T00:00:00').toLocaleDateString('en', { month: 'short', day: 'numeric' });
          let cumH = 0;
          return (
            <g key={g.date}>
              <title>{label}: {total} operations</title>
              <rect x={x} y={0} width={barW} height={H} fill="var(--bg3)" rx={1} opacity={0.5} />
              {sources.map((src) => {
                const val = g.sources[src] ?? 0;
                if (val === 0) return null;
                const segH = (val / maxVal) * H;
                cumH += segH;
                return (
                  <rect
                    key={src}
                    x={x}
                    y={H - cumH}
                    width={barW}
                    height={segH}
                    fill={SOURCE_COLORS[src] ?? '#8b949e'}
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

// ─── Top Sessions Table ──────────────────────────────────────────────────────

function TopSessionsTable({ sessions }: { sessions: SessionAnalytics['topNexusSessions'] }) {
  if (sessions.length === 0) {
    return <div className="empty">No sessions with Nexus tools</div>;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Project</th>
            <th style={{ width: 100 }}>Nexus Calls</th>
            <th style={{ width: 90 }}>User Turns</th>
            <th style={{ width: 90 }}>Total Tools</th>
            <th style={{ width: 100 }}>Started</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => {
            const projectName = s.cwd ? s.cwd.split(/[/\\]/).pop() ?? s.cwd : 'unknown';
            return (
              <tr key={s.sessionId}>
                <td
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: 200,
                  }}
                  title={s.cwd}
                >
                  {projectName}
                </td>
                <td>
                  <span className="badge badge-green">{s.nexusToolCalls}</span>
                </td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{s.userTurns}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{s.toolCalls}</td>
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

// ─── Analytics Page ──────────────────────────────────────────────────────────

export function Analytics() {
  const [range, setRange] = useState<Range>('30d');
  const [data, setData] = useState<SessionAnalytics | null>(null);
  const [auditDaily, setAuditDaily] = useState<AuditCountByDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const days = RANGE_DAYS[range];
      const since = Date.now() - days * 86400000;
      const [sessionData, audit] = await Promise.all([
        api.analytics.sessions(days),
        api.analytics.auditDaily(since),
      ]);
      setData(sessionData);
      setAuditDaily(audit);
    } catch (e) {
      console.error('Analytics load error:', e);
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  if (loading || !data) return <div className="loading">Loading…</div>;

  const turnsSaved = data.withoutNexusAvg.userTurns - data.withNexusAvg.userTurns;
  const adoptionColor =
    data.nexusAdoptionRate >= 0.5 ? 'green' : data.nexusAdoptionRate >= 0.2 ? 'yellow' : 'red';

  const toolItems = Object.entries(data.toolUsageCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([label, value]) => ({ label, value }));

  return (
    <div className="stacked">
      {/* ── Filter bar ──────────────────────────────────────────────────────── */}
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
          {refreshing ? '↻ Refreshing…' : '↻ Refresh'}
        </button>
      </div>

      {/* ── KPI strip ───────────────────────────────────────────────────────── */}
      <div className="stats-grid">
        <KpiCard
          label="Adoption Rate"
          value={pct(data.nexusAdoptionRate)}
          color={adoptionColor}
          sub={`${data.sessionsWithNexus} of ${data.totalSessions} sessions`}
        />
        <KpiCard
          label="Nexus Tool Calls"
          value={data.totalNexusToolCalls}
          color="accent"
          sub={`across ${data.sessionsWithNexus} sessions`}
        />
        <KpiCard
          label="Sessions Analyzed"
          value={data.totalSessions}
          color="gray"
          sub={`in ${range === 'all' ? 'all time' : range}`}
        />
        <KpiCard
          label="Avg Turns Saved"
          value={turnsSaved > 0 ? `${turnsSaved}` : turnsSaved === 0 ? '0' : `${turnsSaved}`}
          color={turnsSaved > 0 ? 'green' : turnsSaved === 0 ? 'gray' : 'yellow'}
          sub={turnsSaved > 0 ? 'fewer turns with Nexus' : turnsSaved === 0 ? 'no difference' : 'more turns with Nexus'}
        />
      </div>

      {/* ── Effectiveness comparison + Adoption trend ──────────────────────── */}
      <div className="grid-2">
        <div className="chart-card">
          <div className="chart-title">Session Efficiency — With vs Without Nexus</div>
          {data.sessionsWithNexus > 0 ? (
            <ComparisonBars data={data} />
          ) : (
            <div className="empty" style={{ padding: '24px 0' }}>No sessions with Nexus tools yet</div>
          )}
        </div>
        <div className="chart-card">
          <div className="chart-title">Adoption Trend</div>
          <AdoptionChart daily={data.dailyAdoption} />
        </div>
      </div>

      {/* ── Tool usage + Audit activity ────────────────────────────────────── */}
      <div className="grid-2">
        <div className="chart-card">
          <div className="chart-title">Nexus Tool Breakdown</div>
          {toolItems.length > 0 ? (
            <HBar items={toolItems} color="#3fb950" />
          ) : (
            <div className="empty" style={{ padding: '24px 0' }}>No nexus tool calls</div>
          )}
        </div>
        <div className="chart-card">
          <div className="chart-title">Audit Activity</div>
          <AuditChart auditDaily={auditDaily} />
        </div>
      </div>

      {/* ── Top sessions table ────────────────────────────────────────────── */}
      <section>
        <div className="section-header">
          <span className="section-title">Top Sessions by Nexus Usage</span>
          <span style={{ fontSize: 12, color: 'var(--text2)' }}>
            Top {Math.min(data.topNexusSessions.length, 10)}
          </span>
        </div>
        <div className="card" style={{ padding: 0 }}>
          <TopSessionsTable sessions={data.topNexusSessions} />
        </div>
      </section>
    </div>
  );
}
