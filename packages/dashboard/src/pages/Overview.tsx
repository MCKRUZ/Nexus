import { useEffect, useState, useMemo, useCallback } from 'react';
import { api, type Stats, type Conflict, type ActivityEvent, type LlmCostSummary } from '../api.js';

type Range = '1h' | '5h' | '1d' | '7d' | '30d' | '90d' | 'all';

const KIND_COLORS: Record<string, string> = {
  architecture: '#58a6ff',
  library: '#bc8cff',
  pattern: '#3fb950',
  naming: '#8b949e',
  security: '#f85149',
  other: '#d29922',
};

function kindBadge(kind: string) {
  const map: Record<string, string> = {
    architecture: 'badge-blue', library: 'badge-purple', pattern: 'badge-green',
    naming: 'badge-gray', security: 'badge-red', other: 'badge-gray',
  };
  return map[kind] ?? 'badge-gray';
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const d = Math.floor(diff / 86400000);
  const h = Math.floor(diff / 3600000);
  const m = Math.floor(diff / 60000);
  if (d > 30) return new Date(ts).toLocaleDateString();
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return 'just now';
}

function cutoffForRange(range: Range): number {
  const now = Date.now();
  if (range === '1h') return now - 3600000;
  if (range === '5h') return now - 5 * 3600000;
  if (range === '1d') return now - 86400000;
  if (range === '7d') return now - 7 * 86400000;
  if (range === '30d') return now - 30 * 86400000;
  if (range === '90d') return now - 90 * 86400000;
  return 0;
}

// ─── Activity Bar Chart ────────────────────────────────────────────────────────

function ActivityBarChart({ events, range }: { events: ActivityEvent[]; range: Range }) {
  const days = range === '1h' ? 1 : range === '5h' ? 1 : range === '1d' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : 60;

  const buckets = useMemo(() => {
    const now = new Date();
    return Array.from({ length: days }, (_, i) => {
      const d = new Date(now);
      d.setDate(d.getDate() - (days - 1 - i));
      const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const dayEnd = dayStart + 86400000;
      const label = d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
      return {
        label,
        decisions: events.filter(e => e.type === 'decision' && e.timestamp >= dayStart && e.timestamp < dayEnd).length,
        patterns: events.filter(e => e.type === 'pattern' && e.timestamp >= dayStart && e.timestamp < dayEnd).length,
      };
    });
  }, [events, days]);

  const maxVal = Math.max(...buckets.map(b => b.decisions + b.patterns), 1);
  const W = 800;
  const H = 80;
  const slotW = W / days;
  const barW = Math.max(slotW - 2, 2);
  const labelEvery = days <= 7 ? 1 : days <= 30 ? 5 : 10;

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 8, fontSize: 11, color: 'var(--text2)' }}>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 1, background: '#58a6ff', marginRight: 4 }} />Decisions</span>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 1, background: '#3fb950', marginRight: 4 }} />Patterns</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H + 18}`} style={{ width: '100%', height: H + 18 }}>
        {buckets.map((b, i) => {
          const x = i * slotW + 1;
          const totalH = ((b.decisions + b.patterns) / maxVal) * H;
          const decH = (b.decisions / maxVal) * H;
          const patH = (b.patterns / maxVal) * H;
          return (
            <g key={i}>
              <title>{b.label}: {b.decisions} decisions, {b.patterns} patterns</title>
              <rect x={x} y={0} width={barW} height={H} fill="var(--bg3)" rx={1} opacity={0.5} />
              {patH > 0 && <rect x={x} y={H - patH} width={barW} height={patH} fill="#3fb950" opacity={0.8} rx={1} />}
              {decH > 0 && <rect x={x} y={H - totalH} width={barW} height={decH} fill="#58a6ff" opacity={0.85} rx={1} />}
              {i % labelEvery === 0 && (
                <text x={x + barW / 2} y={H + 15} textAnchor="middle" fill="var(--text2)" fontSize={9} fontFamily="var(--font)">
                  {b.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ─── Donut Chart ───────────────────────────────────────────────────────────────

function DonutChart({ events }: { events: ActivityEvent[] }) {
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const e of events.filter(ev => ev.type === 'decision')) {
      const k = e.kind ?? 'other';
      m[k] = (m[k] ?? 0) + 1;
    }
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [events]);

  const total = counts.reduce((s, [, n]) => s + n, 0);

  if (total === 0) {
    return <div className="empty" style={{ padding: '24px 0' }}>No decisions in range</div>;
  }

  const R = 52, r = 30, cx = 72, cy = 72;
  let cum = 0;
  const slices = counts.map(([kind, count]) => {
    const start = (cum / total) * 2 * Math.PI - Math.PI / 2;
    cum += count;
    const end = (cum / total) * 2 * Math.PI - Math.PI / 2;
    const large = (end - start) > Math.PI ? 1 : 0;
    const d = [
      `M ${(cx + R * Math.cos(start)).toFixed(2)} ${(cy + R * Math.sin(start)).toFixed(2)}`,
      `A ${R} ${R} 0 ${large} 1 ${(cx + R * Math.cos(end)).toFixed(2)} ${(cy + R * Math.sin(end)).toFixed(2)}`,
      `L ${(cx + r * Math.cos(end)).toFixed(2)} ${(cy + r * Math.sin(end)).toFixed(2)}`,
      `A ${r} ${r} 0 ${large} 0 ${(cx + r * Math.cos(start)).toFixed(2)} ${(cy + r * Math.sin(start)).toFixed(2)}`,
      'Z',
    ].join(' ');
    return { kind, count, d, color: KIND_COLORS[kind] ?? '#8b949e' };
  });

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
      <svg viewBox="0 0 144 144" style={{ width: 110, height: 110, flexShrink: 0 }}>
        {slices.map(s => (
          <path key={s.kind} d={s.d} fill={s.color} opacity={0.85}>
            <title>{s.kind}: {s.count}</title>
          </path>
        ))}
        <text x={cx} y={cy + 5} textAnchor="middle" fill="var(--text)" fontSize={15} fontWeight="bold" fontFamily="var(--font)">{total}</text>
        <text x={cx} y={cy + 17} textAnchor="middle" fill="var(--text2)" fontSize={9} fontFamily="var(--font)">decisions</text>
      </svg>
      <div style={{ fontSize: 12, flex: 1 }}>
        {slices.map(s => (
          <div key={s.kind} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, display: 'inline-block', flexShrink: 0 }} />
            <span style={{ color: 'var(--text2)', flex: 1, textTransform: 'capitalize' }}>{s.kind}</span>
            <span style={{ color: 'var(--text)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{s.count}</span>
          </div>
        ))}
        {total > 0 && (
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text2)' }}>
            {events.filter(e => e.type === 'decision' && e.rationale).length} of {total} have rationale
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Top Projects ──────────────────────────────────────────────────────────────

function TopProjects({ events }: { events: ActivityEvent[] }) {
  const ranked = useMemo(() => {
    const m: Record<string, { name: string; decisions: number; patterns: number }> = {};
    for (const e of events) {
      if (!m[e.projectId]) m[e.projectId] = { name: e.projectName, decisions: 0, patterns: 0 };
      const entry = m[e.projectId]!;
      if (e.type === 'decision') entry.decisions++;
      else entry.patterns++;
    }
    return Object.values(m)
      .map(p => ({ ...p, total: p.decisions + p.patterns }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8);
  }, [events]);

  if (ranked.length === 0) {
    return <div className="empty" style={{ padding: '24px 0' }}>No activity in range</div>;
  }

  const max = ranked[0]?.total ?? 1;

  return (
    <div>
      {ranked.map(p => (
        <div key={p.name} style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4, fontSize: 12 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '72%' }}>{p.name}</span>
            <span style={{ color: 'var(--text2)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
              {p.decisions > 0 && <span style={{ color: '#58a6ff', marginRight: 6 }}>{p.decisions}d</span>}
              {p.patterns > 0 && <span style={{ color: '#3fb950' }}>{p.patterns}p</span>}
            </span>
          </div>
          <div style={{ height: 4, background: 'var(--bg3)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(p.total / max) * 100}%`, background: 'var(--accent)', borderRadius: 2 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Activity Feed ─────────────────────────────────────────────────────────────

function ActivityFeed({ events }: { events: ActivityEvent[] }) {
  const rows = events.slice(0, 50);

  if (rows.length === 0) {
    return <div className="empty">No activity in this period</div>;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th style={{ width: 120 }}>Type</th>
            <th style={{ width: 140 }}>Project</th>
            <th>Summary</th>
            <th style={{ width: 90 }}>When</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(e => (
            <tr key={e.id}>
              <td>
                {e.type === 'decision'
                  ? <span className={`badge ${kindBadge(e.kind ?? 'other')}`}>{e.kind}</span>
                  : <span className="badge badge-green">pattern</span>}
              </td>
              <td style={{ color: 'var(--text2)', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 140 }}>
                {e.projectName}
              </td>
              <td>
                <div style={{ fontSize: 13 }}>{e.summary ?? e.name}</div>
                {(e.rationale || e.description) && (
                  <div className="rationale">{e.rationale ?? e.description}</div>
                )}
              </td>
              <td style={{ whiteSpace: 'nowrap', color: 'var(--text2)', fontSize: 12 }}>
                {relativeTime(e.timestamp)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Stat Card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, color, sub }: { label: string; value: number; color: string; sub?: string }) {
  return (
    <div className="card">
      <div className="card-title">{label}</div>
      <div className="card-value" style={{ color: `var(--${color})` }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// ─── Month Cost Card (Nexus LLM costs only) ─────────────────────────────────

function MonthCostCard({ costs }: { costs: LlmCostSummary | null }) {
  if (!costs || costs.totalCalls === 0) {
    return (
      <div className="chart-card" style={{ flex: 1 }}>
        <div className="chart-title">Nexus LLM Spend</div>
        <div className="empty" style={{ padding: '16px 0' }}>No Nexus LLM calls recorded yet</div>
      </div>
    );
  }

  // Compute MTD: sum costs for days in current month
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const dayOfMonth = now.getDate();

  const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;
  const mtdDays = costs.byDay.filter(d => d.date.startsWith(monthPrefix));
  const mtdCost = mtdDays.reduce((s, d) => s + d.estimatedCostUsd, 0);
  const mtdCalls = mtdDays.reduce((s, d) => s + d.calls, 0);

  // Project: average daily spend * remaining days
  const activeDays = mtdDays.length || 1;
  const avgPerDay = mtdCost / activeDays;
  const remainingDays = daysInMonth - dayOfMonth;
  const projected = mtdCost + avgPerDay * remainingDays;

  const fmt = (n: number) => n < 0.01 ? `$${n.toFixed(4)}` : n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;

  return (
    <div className="chart-card" style={{ flex: 1 }}>
      <div className="chart-title">Nexus LLM Spend — {now.toLocaleString('en', { month: 'long', year: 'numeric' })}</div>
      <div style={{ display: 'flex', gap: 24, alignItems: 'baseline', marginTop: 8 }}>
        <div>
          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--green)', fontVariantNumeric: 'tabular-nums' }}>
            {fmt(mtdCost)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2 }}>spent MTD ({mtdCalls} call{mtdCalls !== 1 ? 's' : ''})</div>
        </div>
        <div>
          <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--text2)', fontVariantNumeric: 'tabular-nums' }}>
            {fmt(projected)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2 }}>projected EOM</div>
        </div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 500, color: 'var(--text2)', fontVariantNumeric: 'tabular-nums' }}>
            {fmt(avgPerDay)}/day
          </div>
          <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2 }}>avg daily</div>
        </div>
      </div>
      {costs.byProvider.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 8 }}>
          {costs.byProvider.map(p => `${p.provider}/${p.model}: ${p.calls} calls`).join(' · ')}
        </div>
      )}
    </div>
  );
}

// ─── Conflicts Banner ─────────────────────────────────────────────────────────

function ConflictsBanner({ conflicts }: { conflicts: Conflict[] }) {
  const [expanded, setExpanded] = useState(false);
  const high = conflicts.filter(c => c.severity === 'high' || c.severity === 'critical');
  const medium = conflicts.filter(c => c.severity === 'medium');
  const low = conflicts.filter(c => c.severity === 'low');
  const preview = conflicts.slice(0, 3);

  return (
    <div className="error-banner" style={{ cursor: 'pointer' }} onClick={() => setExpanded(e => !e)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>
          {conflicts.length} open conflict{conflicts.length > 1 ? 's' : ''}
          {high.length > 0 && <span style={{ marginLeft: 8, fontWeight: 700 }}>{high.length} high</span>}
          {medium.length > 0 && <span style={{ marginLeft: 8, opacity: 0.8 }}>{medium.length} medium</span>}
          {low.length > 0 && <span style={{ marginLeft: 8, opacity: 0.6 }}>{low.length} low</span>}
        </span>
        <span style={{ fontSize: 11, opacity: 0.7 }}>{expanded ? 'collapse' : 'expand'}</span>
      </div>
      {!expanded && (
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85, lineHeight: 1.5 }}>
          {preview.map((c, i) => (
            <div key={i} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
              [{c.severity}] {c.description}
            </div>
          ))}
          {conflicts.length > 3 && (
            <div style={{ opacity: 0.6, marginTop: 4 }}>+ {conflicts.length - 3} more — click to expand</div>
          )}
        </div>
      )}
      {expanded && (
        <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6, maxHeight: 300, overflowY: 'auto' }}>
          {conflicts.map((c, i) => (
            <div key={i} style={{ marginBottom: 6, paddingBottom: 6, borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
              <span style={{ fontWeight: 600, marginRight: 8 }}>
                [{c.severity}]
              </span>
              {c.description}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AdvisoriesBanner({ advisories, onDismiss }: { advisories: Conflict[]; onDismiss: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{
      background: 'rgba(56, 139, 253, 0.1)',
      border: '1px solid rgba(56, 139, 253, 0.3)',
      borderRadius: 8,
      padding: '12px 16px',
      cursor: 'pointer',
    }} onClick={() => setExpanded(e => !e)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#58a6ff' }}>
        <span style={{ fontWeight: 600 }}>
          {advisories.length} cross-project advisor{advisories.length > 1 ? 'ies' : 'y'}
        </span>
        <span style={{ fontSize: 11, opacity: 0.7 }}>{expanded ? 'collapse' : 'expand'}</span>
      </div>
      {expanded && (
        <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6, maxHeight: 300, overflowY: 'auto' }}>
          {advisories.map((a) => (
            <div key={a.id} style={{ marginBottom: 6, paddingBottom: 6, borderBottom: '1px solid rgba(56, 139, 253, 0.15)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
              <span style={{ color: 'var(--text)' }}>{a.description}</span>
              <button
                className="btn"
                style={{ fontSize: 10, padding: '2px 8px', flexShrink: 0 }}
                onClick={(e) => { e.stopPropagation(); onDismiss(a.id); }}
              >
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Overview ──────────────────────────────────────────────────────────────────

export function Overview() {
  const [range, setRange] = useState<Range>('30d');
  const [stats, setStats] = useState<Stats | null>(null);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [advisories, setAdvisories] = useState<Conflict[]>([]);
  const [llmCosts, setLlmCosts] = useState<LlmCostSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [s, ev, cc, lc] = await Promise.all([
        api.stats(),
        api.activity(500),
        api.conflicts.check(),
        api.analytics.llmCosts(90).catch(() => null),
      ]);
      setStats(s);
      setActivity(ev);
      setConflicts(cc.conflicts.filter(c => !c.resolvedAt));
      setAdvisories((cc.advisories ?? []).filter(c => !c.resolvedAt));
      setLlmCosts(lc);
      setLastUpdated(new Date());
    } catch (e) {
      console.error('Overview load error:', e);
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh every 30s
  useEffect(() => {
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const handleDismiss = useCallback(async (id: string) => {
    try {
      await api.conflicts.dismiss(id);
      setAdvisories((prev) => prev.filter((a) => a.id !== id));
    } catch (e) {
      console.error('Dismiss error:', e);
    }
  }, []);

  const cutoff = cutoffForRange(range);
  const filtered = useMemo(() => activity.filter(e => e.timestamp >= cutoff), [activity, cutoff]);
  const filteredDecisions = filtered.filter(e => e.type === 'decision');
  const filteredPatterns = filtered.filter(e => e.type === 'pattern');
  const withRationale = filteredDecisions.filter(e => e.rationale).length;

  if (loading) return <div className="loading">Loading…</div>;

  return (
    <div className="stacked">

      {/* ── Filter bar ─────────────────────────────────────────────────────── */}
      <div className="filter-bar">
        <div className="range-btns">
          {(['1h', '5h', '1d', '7d', '30d', '90d', 'all'] as Range[]).map(r => (
            <button
              key={r}
              className={`range-btn${range === r ? ' active' : ''}`}
              onClick={() => setRange(r)}
            >
              {r === 'all' ? 'All time' : r === '1h' ? '1h' : r === '5h' ? '5h' : r === '1d' ? '1d' : r}
            </button>
          ))}
        </div>
        <button className="btn" onClick={load} disabled={refreshing} style={{ marginLeft: 'auto' }}>
          {refreshing ? '↻ Refreshing…' : '↻ Refresh'}
        </button>
        {lastUpdated && (
          <span style={{ fontSize: 11, color: 'var(--text2)' }}>
            Updated {relativeTime(lastUpdated.getTime())}
          </span>
        )}
      </div>

      {/* ── KPI strip ──────────────────────────────────────────────────────── */}
      <div className="stats-grid">
        <StatCard label="Projects" value={stats!.projects} color="accent" sub="registered" />
        <StatCard
          label="Decisions"
          value={filteredDecisions.length}
          color="green"
          sub={`in ${range === 'all' ? 'all time' : range}`}
        />
        <StatCard
          label="Patterns"
          value={filteredPatterns.length}
          color="purple"
          sub={`in ${range === 'all' ? 'all time' : range}`}
        />
        <StatCard
          label="Conflicts"
          value={conflicts.length}
          color={conflicts.length > 0 ? 'red' : 'gray'}
          sub={conflicts.length > 0 ? 'needs attention' : 'all clear'}
        />
        <StatCard
          label="Advisories"
          value={advisories.length}
          color={advisories.length > 0 ? 'accent' : 'gray'}
          sub={advisories.length > 0 ? 'knowledge transfers' : 'none'}
        />
        <StatCard
          label="Documented"
          value={filteredDecisions.length > 0 ? Math.round((withRationale / filteredDecisions.length) * 100) : 0}
          color="yellow"
          sub={`% of decisions have rationale`}
        />
      </div>

      {/* ── Advisories banner (blue) ─────────────────────────────────────── */}
      {advisories.length > 0 && (
        <AdvisoriesBanner advisories={advisories} onDismiss={handleDismiss} />
      )}

      {/* ── Conflicts banner (red) ──────────────────────────────────────── */}
      {conflicts.length > 0 && (
        <ConflictsBanner conflicts={conflicts} />
      )}

      {/* ── Monthly spend ──────────────────────────────────────────────────── */}
      <MonthCostCard costs={llmCosts} />

      {/* ── Activity timeline ──────────────────────────────────────────────── */}
      <div className="chart-card">
        <div className="chart-title">Activity — {range === 'all' ? 'last 60 days' : range}</div>
        <ActivityBarChart events={filtered} range={range} />
      </div>

      {/* ── Middle row: breakdown + top projects ───────────────────────────── */}
      <div className="grid-2">
        <div className="chart-card">
          <div className="chart-title">Decision Breakdown</div>
          <DonutChart events={filtered} />
        </div>
        <div className="chart-card">
          <div className="chart-title">Top Projects by Activity</div>
          <TopProjects events={filtered} />
        </div>
      </div>

      {/* ── Activity feed ──────────────────────────────────────────────────── */}
      <section>
        <div className="section-header">
          <span className="section-title">Activity Feed</span>
          <span style={{ fontSize: 12, color: 'var(--text2)' }}>
            {filtered.length} event{filtered.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="card" style={{ padding: 0 }}>
          <ActivityFeed events={filtered} />
        </div>
      </section>

    </div>
  );
}
