import { useEffect, useState } from 'react';
import { api, type Stats, type Project, type Decision, type Conflict } from '../api.js';

export function Overview() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [recentDecisions, setRecentDecisions] = useState<Decision[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.stats(),
      api.projects.list(),
      api.conflicts.check(),
    ])
      .then(([s, ps, cc]) => {
        setStats(s);
        setProjects(ps);
        setConflicts(cc.conflicts.filter(c => !c.resolvedAt));
      })
      .catch(e => setError(String(e)));
  }, []);

  useEffect(() => {
    if (projects.length === 0) return;
    // Fetch decisions for first 3 projects and merge
    Promise.all(projects.slice(0, 3).map(p => api.projects.decisions(p.id)))
      .then(arrays => {
        const all = arrays.flat().sort((a, b) => b.recordedAt - a.recordedAt).slice(0, 8);
        setRecentDecisions(all);
      })
      .catch(() => {/* non-fatal */});
  }, [projects]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!stats) return <div className="loading">Loading…</div>;

  return (
    <div className="stacked">
      <div className="stats-grid">
        <StatCard label="Projects" value={stats.projects} color="accent" />
        <StatCard label="Decisions" value={stats.decisions} color="green" />
        <StatCard label="Patterns" value={stats.patterns} color="purple" />
        <StatCard label="Open Conflicts" value={conflicts.length} color={conflicts.length > 0 ? 'red' : 'gray'} />
      </div>

      {conflicts.length > 0 && (
        <section>
          <div className="section-header">
            <span className="section-title">⚡ Active Conflicts</span>
          </div>
          <div className="card">
            {conflicts.map(c => (
              <div key={c.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <div style={{ fontWeight: 600, color: 'var(--red)', fontSize: 13 }}>{c.description}</div>
                <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 2 }}>
                  {new Date(c.detectedAt).toLocaleDateString()}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="grid-2">
        <section>
          <div className="section-header">
            <span className="section-title">Projects</span>
          </div>
          <div className="card">
            {projects.length === 0 && <div className="empty">No projects registered yet</div>}
            {projects.slice(0, 6).map(p => (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{p.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text2)', fontFamily: 'var(--mono)', marginTop: 2 }}>{p.path}</div>
                </div>
                {p.tags.length > 0 && (
                  <div style={{ display: 'flex', gap: 4 }}>
                    {p.tags.slice(0, 2).map(t => <span key={t} className="badge badge-gray">{t}</span>)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        <section>
          <div className="section-header">
            <span className="section-title">Recent Decisions</span>
          </div>
          <div className="card">
            {recentDecisions.length === 0 && <div className="empty">No decisions recorded yet</div>}
            {recentDecisions.map(d => (
              <div key={d.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <span className={`badge ${kindBadge(d.kind)}`}>{d.kind}</span>
                  <span style={{ fontSize: 13 }}>{d.summary}</span>
                </div>
                {d.rationale && <div className="rationale">{d.rationale}</div>}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="card">
      <div className="card-title">{label}</div>
      <div className="card-value" style={{ color: `var(--${color})` }}>{value}</div>
    </div>
  );
}

function kindBadge(kind: string) {
  const map: Record<string, string> = {
    architecture: 'badge-blue',
    library: 'badge-purple',
    pattern: 'badge-green',
    naming: 'badge-gray',
    security: 'badge-red',
    other: 'badge-gray',
  };
  return map[kind] ?? 'badge-gray';
}
