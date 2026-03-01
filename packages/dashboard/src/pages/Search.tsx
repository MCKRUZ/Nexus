import { useState } from 'react';
import { api, type QueryResult, type Project } from '../api.js';
import { useEffect } from 'react';

export function Search() {
  const [q, setQ] = useState('');
  const [projectId, setProjectId] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.projects.list().then(setProjects).catch(() => {/* non-fatal */});
  }, []);

  const search = () => {
    if (!q.trim()) return;
    setLoading(true);
    setError('');
    api.query(q.trim(), projectId || undefined)
      .then(setResult)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') search();
  };

  return (
    <div className="stacked">
      {/* Search bar */}
      <div style={{ display: 'flex', gap: 12 }}>
        <input
          className="search-input"
          placeholder="Search decisions, patterns, preferences… (Enter to search)"
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={handleKey}
          autoFocus
        />
        <select
          value={projectId}
          onChange={e => setProjectId(e.target.value)}
          style={{ background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--text)', padding: '6px 10px', borderRadius: 'var(--radius)', fontSize: 13, flexShrink: 0 }}
        >
          <option value="">All projects</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button className="btn btn-primary" onClick={search} disabled={loading}>
          {loading ? '…' : 'Search'}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {result && (
        <div className="stacked">
          {/* Decisions */}
          <section>
            <div className="section-header">
              <span className="section-title">Decisions ({result.decisions.length})</span>
            </div>
            {result.decisions.length === 0
              ? <div className="empty">No matching decisions</div>
              : (
                <div className="card table-wrap" style={{ padding: 0 }}>
                  <table>
                    <thead>
                      <tr><th>Kind</th><th>Summary</th><th>Rationale</th><th>Recorded</th></tr>
                    </thead>
                    <tbody>
                      {result.decisions.map(d => (
                        <tr key={d.id}>
                          <td><span className={`badge ${kindBadge(d.kind)}`}>{d.kind}</span></td>
                          <td style={{ fontWeight: 500 }}>{d.summary}</td>
                          <td style={{ color: 'var(--text2)', fontSize: 12 }}>{d.rationale ?? '—'}</td>
                          <td style={{ color: 'var(--text2)', fontSize: 12, whiteSpace: 'nowrap' }}>
                            {new Date(d.recordedAt).toLocaleDateString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </section>

          {/* Patterns */}
          <section>
            <div className="section-header">
              <span className="section-title">Patterns ({result.patterns.length})</span>
            </div>
            {result.patterns.length === 0
              ? <div className="empty">No matching patterns</div>
              : (
                <div className="card table-wrap" style={{ padding: 0 }}>
                  <table>
                    <thead>
                      <tr><th>Name</th><th>Description</th><th>Frequency</th></tr>
                    </thead>
                    <tbody>
                      {result.patterns.map(p => (
                        <tr key={p.id}>
                          <td style={{ fontWeight: 500 }}>{p.name}</td>
                          <td style={{ color: 'var(--text2)' }}>{p.description}</td>
                          <td><span className="badge badge-purple">{p.frequency}×</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </section>

          {/* Preferences */}
          <section>
            <div className="section-header">
              <span className="section-title">Preferences ({result.preferences.length})</span>
            </div>
            {result.preferences.length === 0
              ? <div className="empty">No matching preferences</div>
              : (
                <div className="card" style={{ padding: '0 16px' }}>
                  {result.preferences.map(p => (
                    <div key={p.id} style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--accent)', minWidth: 200 }}>{p.key}</span>
                      <span style={{ flex: 1 }}>{p.value}</span>
                      <span className={`badge ${p.scope === 'global' ? 'badge-blue' : 'badge-green'}`}>{p.scope}</span>
                    </div>
                  ))}
                </div>
              )}
          </section>
        </div>
      )}

      {!result && !loading && (
        <div className="empty" style={{ padding: 64 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>⌕</div>
          <div>Search across all decisions, patterns, and preferences</div>
          <div style={{ marginTop: 8, fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text2)' }}>
            Try: "SQLite" · "authentication" · "naming convention"
          </div>
        </div>
      )}
    </div>
  );
}

function kindBadge(kind: string) {
  const map: Record<string, string> = {
    architecture: 'badge-blue', library: 'badge-purple', pattern: 'badge-green',
    naming: 'badge-gray', security: 'badge-red', other: 'badge-gray',
  };
  return map[kind] ?? 'badge-gray';
}
