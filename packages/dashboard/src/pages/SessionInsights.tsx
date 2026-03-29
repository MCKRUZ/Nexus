import { useEffect, useState, useMemo, useCallback } from 'react';
import { api, type NativeSession, type NativeStats, type Project, type Note } from '../api.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function projectName(cwd: string, projects: Project[]): string {
  if (!cwd) return 'unknown';
  const match = projects.find(
    (p) => p.path.replace(/\\/g, '/').toLowerCase() === cwd.replace(/\\/g, '/').toLowerCase(),
  );
  if (match) return match.name;
  const parts = cwd.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? cwd;
}

function formatDuration(ms: number): string {
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

function toDateKey(ts: string): string {
  return new Date(ts).toISOString().slice(0, 10);
}

type SessionHealth = 'green' | 'yellow' | 'red';

function getHealth(s: NativeSession): SessionHealth {
  const durationMs = new Date(s.lastActivityAt).getTime() - new Date(s.startedAt).getTime();
  const durationH = durationMs / 3_600_000;
  if (durationH > 4 || s.toolCalls > 500) return 'red';
  if (durationH > 2 || s.toolCalls > 200) return 'yellow';
  return 'green';
}

const HEALTH_COLORS: Record<SessionHealth, string> = {
  green: '#3fb950',
  yellow: '#d29922',
  red: '#f85149',
};

type SortKey = 'project' | 'turns' | 'tools' | 'started' | 'duration';
type SortDir = 'asc' | 'desc';

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
    <div className="card" style={{ textAlign: 'center', padding: '14px 10px' }}>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 4 }}>{label}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--text3, #666)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ─── Horizontal Bar Chart ────────────────────────────────────────────────────

function HBar({
  items,
  color,
}: {
  items: Array<{ label: string; value: number }>;
  color: string;
}) {
  const max = Math.max(...items.map((i) => i.value), 1);
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
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: '72%',
              }}
            >
              {item.label}
            </span>
            <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text2)' }}>
              {item.value}
            </span>
          </div>
          <div
            style={{
              height: 4,
              background: 'var(--bg3)',
              borderRadius: 2,
              overflow: 'hidden',
            }}
          >
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

// ─── Donut Chart ─────────────────────────────────────────────────────────────

const DONUT_COLORS = ['#58a6ff', '#3fb950', '#bc8cff', '#d29922', '#f0883e', '#f85149', '#8b949e', '#56d4dd'];

function DonutChart({ items }: { items: Array<{ label: string; value: number }> }) {
  const total = items.reduce((s, i) => s + i.value, 0);
  if (total === 0) return <div className="empty">No data</div>;

  const size = 160;
  const cx = size / 2;
  const cy = size / 2;
  const r = 55;
  const strokeW = 24;

  let cumAngle = -90; // start at top
  const arcs = items.map((item, idx) => {
    const pct = item.value / total;
    const angle = pct * 360;
    const startAngle = cumAngle;
    cumAngle += angle;
    const endAngle = cumAngle;

    const startRad = (startAngle * Math.PI) / 180;
    const endRad = (endAngle * Math.PI) / 180;
    const x1 = cx + r * Math.cos(startRad);
    const y1 = cy + r * Math.sin(startRad);
    const x2 = cx + r * Math.cos(endRad);
    const y2 = cy + r * Math.sin(endRad);
    const largeArc = angle > 180 ? 1 : 0;

    return {
      d: `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`,
      color: DONUT_COLORS[idx % DONUT_COLORS.length]!,
      label: item.label,
      pct: Math.round(pct * 100),
    };
  });

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {arcs.map((arc) => (
          <path
            key={arc.label}
            d={arc.d}
            fill="none"
            stroke={arc.color}
            strokeWidth={strokeW}
            strokeLinecap="butt"
          >
            <title>
              {arc.label}: {arc.pct}%
            </title>
          </path>
        ))}
        <text
          x={cx}
          y={cy}
          textAnchor="middle"
          dominantBaseline="central"
          fill="var(--text)"
          fontSize={18}
          fontWeight={700}
        >
          {total}
        </text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11 }}>
        {arcs.map((arc) => (
          <div key={arc.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                background: arc.color,
                flexShrink: 0,
              }}
            />
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 120,
              }}
            >
              {arc.label}
            </span>
            <span style={{ color: 'var(--text2)' }}>{arc.pct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Activity Timeline Chart ─────────────────────────────────────────────────

function ActivityChart({ daily }: { daily: Array<{ date: string; count: number }> }) {
  if (daily.length === 0) {
    return <div className="empty" style={{ padding: '24px 0' }}>No session data</div>;
  }

  const W = 600;
  const H = 80;
  const days = daily.length;
  const slotW = W / Math.max(days, 1);
  const barW = Math.max(slotW - 2, 2);
  const maxVal = Math.max(...daily.map((d) => d.count), 1);
  const labelEvery = days <= 7 ? 1 : days <= 14 ? 2 : days <= 30 ? 5 : 10;

  return (
    <svg viewBox={`0 0 ${W} ${H + 18}`} style={{ width: '100%', height: H + 18 }}>
      {daily.map((d, i) => {
        const x = i * slotW + 1;
        const barH = (d.count / maxVal) * H;
        const label = new Date(d.date + 'T00:00:00').toLocaleDateString('en', {
          month: 'short',
          day: 'numeric',
        });
        return (
          <g key={d.date}>
            <title>
              {label}: {d.count} sessions
            </title>
            <rect x={x} y={0} width={barW} height={H} fill="var(--bg3)" rx={1} opacity={0.5} />
            <rect
              x={x}
              y={H - barH}
              width={barW}
              height={barH}
              fill="#58a6ff"
              opacity={0.85}
              rx={1}
            />
            {i % labelEvery === 0 && (
              <text
                x={x + barW / 2}
                y={H + 15}
                textAnchor="middle"
                fill="var(--text2)"
                fontSize={9}
                fontFamily="var(--font)"
              >
                {label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ─── Session Table ───────────────────────────────────────────────────────────

function SessionTable({
  sessions,
  projects,
}: {
  sessions: NativeSession[];
  projects: Project[];
}) {
  const [sortKey, setSortKey] = useState<SortKey>('started');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 25;

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
    setPage(0);
  };

  const sorted = useMemo(() => {
    const arr = [...sessions];
    const dir = sortDir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      switch (sortKey) {
        case 'project':
          return projectName(a.cwd, projects).localeCompare(projectName(b.cwd, projects)) * dir;
        case 'turns':
          return (a.userTurns - b.userTurns) * dir;
        case 'tools':
          return (a.toolCalls - b.toolCalls) * dir;
        case 'started':
          return (new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()) * dir;
        case 'duration': {
          const durA =
            new Date(a.lastActivityAt).getTime() - new Date(a.startedAt).getTime();
          const durB =
            new Date(b.lastActivityAt).getTime() - new Date(b.startedAt).getTime();
          return (durA - durB) * dir;
        }
        default:
          return 0;
      }
    });
    return arr;
  }, [sessions, projects, sortKey, sortDir]);

  const pageCount = Math.max(Math.ceil(sorted.length / PAGE_SIZE), 1);
  const visible = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const sortIcon = (key: SortKey) => {
    if (sortKey !== key) return '';
    return sortDir === 'asc' ? ' \u25B2' : ' \u25BC';
  };

  const thStyle: React.CSSProperties = {
    cursor: 'pointer',
    userSelect: 'none',
    whiteSpace: 'nowrap',
  };

  return (
    <div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={thStyle} onClick={() => toggleSort('project')}>
                Project{sortIcon('project')}
              </th>
              <th style={{ width: 100 }}>Branch</th>
              <th style={{ ...thStyle, width: 80 }} onClick={() => toggleSort('turns')}>
                Turns{sortIcon('turns')}
              </th>
              <th style={{ ...thStyle, width: 80 }} onClick={() => toggleSort('tools')}>
                Tools{sortIcon('tools')}
              </th>
              <th style={{ ...thStyle, width: 110 }} onClick={() => toggleSort('started')}>
                Started{sortIcon('started')}
              </th>
              <th style={{ ...thStyle, width: 90 }} onClick={() => toggleSort('duration')}>
                Duration{sortIcon('duration')}
              </th>
              <th style={{ width: 40 }}>Health</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((s) => {
              const health = getHealth(s);
              const durMs =
                new Date(s.lastActivityAt).getTime() - new Date(s.startedAt).getTime();
              return (
                <tr key={s.sessionId}>
                  <td
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: 180,
                    }}
                    title={s.cwd}
                  >
                    {projectName(s.cwd, projects)}
                  </td>
                  <td
                    style={{
                      fontSize: 11,
                      color: 'var(--text2)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: 100,
                    }}
                  >
                    {s.gitBranch ?? '-'}
                  </td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{s.userTurns}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{s.toolCalls}</td>
                  <td
                    style={{
                      whiteSpace: 'nowrap',
                      color: 'var(--text2)',
                      fontSize: 12,
                    }}
                  >
                    {timeAgo(s.startedAt)}
                  </td>
                  <td style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>
                    {formatDuration(durMs)}
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <span
                      style={{
                        display: 'inline-block',
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: HEALTH_COLORS[health],
                      }}
                      title={health}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pageCount > 1 && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            gap: 8,
            padding: '8px 0',
            fontSize: 12,
            color: 'var(--text2)',
          }}
        >
          <button
            className="btn"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
            style={{ padding: '2px 10px', fontSize: 12 }}
          >
            Prev
          </button>
          <span>
            {page + 1} / {pageCount}
          </span>
          <button
            className="btn"
            disabled={page >= pageCount - 1}
            onClick={() => setPage((p) => p + 1)}
            style={{ padding: '2px 10px', fontSize: 12 }}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Saved Insight Card ──────────────────────────────────────────────────────

function InsightCard({ note }: { note: Note }) {
  const [expanded, setExpanded] = useState(false);
  const previewLength = 600;
  const isLong = note.content.length > previewLength;
  const displayContent = expanded ? note.content : note.content.slice(0, previewLength);

  return (
    <div
      className="card"
      style={{ padding: '16px 20px', borderLeft: '3px solid #bc8cff' }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 14 }}>{note.title}</div>
        <div style={{ fontSize: 11, color: 'var(--text2)' }}>
          {new Date(note.updatedAt).toLocaleDateString()}
        </div>
      </div>
      {note.tags.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
          {note.tags.map((tag) => (
            <span
              key={tag}
              style={{
                fontSize: 10,
                padding: '1px 8px',
                borderRadius: 10,
                background: 'var(--bg3)',
                color: 'var(--text2)',
              }}
            >
              {tag}
            </span>
          ))}
        </div>
      )}
      <div
        style={{
          fontSize: 12,
          lineHeight: 1.6,
          color: 'var(--text2)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {displayContent}
        {isLong && !expanded && '...'}
      </div>
      {isLong && (
        <div
          onClick={() => setExpanded((e) => !e)}
          style={{
            marginTop: 8,
            fontSize: 12,
            color: '#58a6ff',
            cursor: 'pointer',
          }}
        >
          {expanded ? 'Show less' : 'Show full report'}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function SessionInsights() {
  const [sessions, setSessions] = useState<NativeSession[]>([]);
  const [stats, setStats] = useState<NativeStats | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [insightNotes, setInsightNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    setRefreshing(true);
    Promise.allSettled([
      api.native.sessions(),
      api.native.stats(),
      api.projects.list(),
      api.notes.search('Session Insights'),
    ]).then(([sRes, stRes, pRes, nRes]) => {
      if (sRes.status === 'fulfilled') setSessions(sRes.value);
      if (stRes.status === 'fulfilled') setStats(stRes.value);
      if (pRes.status === 'fulfilled') setProjects(pRes.value);
      if (nRes.status === 'fulfilled') setInsightNotes(nRes.value);
      setRefreshing(false);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // ── Derived data ──────────────────────────────────────────────────────────

  const totalSessions = stats?.totalSessions ?? sessions.length;
  const totalTurns = stats?.totalUserTurns ?? sessions.reduce((s, x) => s + x.userTurns, 0);
  const totalTools = stats?.totalToolCalls ?? sessions.reduce((s, x) => s + x.toolCalls, 0);
  const avgTurns = totalSessions > 0 ? Math.round(totalTurns / totalSessions) : 0;

  const projectSessionCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of sessions) {
      const name = projectName(s.cwd, projects);
      map.set(name, (map.get(name) ?? 0) + 1);
    }
    return [...map.entries()]
      .sort(([, a], [, b]) => b - a)
      .map(([label, value]) => ({ label, value }));
  }, [sessions, projects]);

  const topProject = projectSessionCounts[0]?.label ?? '-';

  const dailyActivity = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of sessions) {
      const key = toDateKey(s.startedAt);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));
  }, [sessions]);

  const sortedNotes = useMemo(
    () => [...insightNotes].sort((a, b) => b.updatedAt - a.updatedAt),
    [insightNotes],
  );

  if (loading) return <div className="loading">Loading...</div>;

  return (
    <div className="stacked">
      {/* ── Refresh bar ────────────────────────────────────────────────────── */}
      <div className="filter-bar" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={load} disabled={refreshing}>
          {refreshing ? '\u21BB Refreshing...' : '\u21BB Refresh'}
        </button>
      </div>

      {/* ── KPI strip ──────────────────────────────────────────────────────── */}
      <div className="stats-grid">
        <KpiCard label="Total Sessions" value={totalSessions} color="#58a6ff" />
        <KpiCard label="Total User Turns" value={totalTurns} color="#3fb950" />
        <KpiCard label="Total Tool Calls" value={totalTools} color="#bc8cff" />
        <KpiCard
          label="Top Project"
          value={topProject}
          color="#d29922"
          sub={projectSessionCounts[0] ? `${projectSessionCounts[0].value} sessions` : undefined}
        />
        <KpiCard label="Avg Turns / Session" value={avgTurns} color="var(--text)" />
      </div>

      {/* ── Project Focus ──────────────────────────────────────────────────── */}
      <div className="grid-2">
        <div className="chart-card">
          <div className="chart-title">Sessions by Project</div>
          {projectSessionCounts.length > 0 ? (
            <HBar items={projectSessionCounts.slice(0, 12)} color="#58a6ff" />
          ) : (
            <div className="empty" style={{ padding: '24px 0' }}>No sessions</div>
          )}
        </div>
        <div className="chart-card">
          <div className="chart-title">Project Distribution</div>
          {projectSessionCounts.length > 0 ? (
            <DonutChart items={projectSessionCounts.slice(0, 8)} />
          ) : (
            <div className="empty" style={{ padding: '24px 0' }}>No sessions</div>
          )}
        </div>
      </div>

      {/* ── Activity Timeline ──────────────────────────────────────────────── */}
      <div className="chart-card">
        <div className="chart-title">Activity Timeline</div>
        <ActivityChart daily={dailyActivity} />
      </div>

      {/* ── Session Table ──────────────────────────────────────────────────── */}
      <section>
        <div className="section-header">
          <span className="section-title">All Sessions</span>
          <span style={{ fontSize: 12, color: 'var(--text2)' }}>
            {sessions.length} total
          </span>
        </div>
        <div className="card" style={{ padding: 0 }}>
          {sessions.length > 0 ? (
            <SessionTable sessions={sessions} projects={projects} />
          ) : (
            <div className="empty" style={{ padding: 24 }}>No sessions found</div>
          )}
        </div>
      </section>

      {/* ── Saved Insights ─────────────────────────────────────────────────── */}
      <section>
        <div className="section-header">
          <span className="section-title">Saved Insight Reports</span>
          <span style={{ fontSize: 12, color: 'var(--text2)' }}>
            {sortedNotes.length} report{sortedNotes.length !== 1 ? 's' : ''}
          </span>
        </div>
        {sortedNotes.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {sortedNotes.map((note) => (
              <InsightCard key={note.id} note={note} />
            ))}
          </div>
        ) : (
          <div className="card" style={{ textAlign: 'center', padding: 24 }}>
            <div style={{ color: 'var(--text2)', fontSize: 13, marginBottom: 8 }}>
              No insight reports saved yet
            </div>
            <div style={{ color: 'var(--text3, #666)', fontSize: 12 }}>
              Run <code style={{ background: 'var(--bg3)', padding: '1px 6px', borderRadius: 3 }}>/session-insights</code> in Claude Code to generate one
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
