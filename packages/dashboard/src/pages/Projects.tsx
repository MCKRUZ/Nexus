import { useEffect, useState } from 'react';
import { api, type Project, type Decision, type Pattern } from '../api.js';

export function Projects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<Project | null>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.projects.list()
      .then(ps => { setProjects(ps); if (ps[0]) setSelected(ps[0]); })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selected) return;
    Promise.all([
      api.projects.decisions(selected.id),
      api.projects.patterns(selected.id),
    ]).then(([ds, ps]) => { setDecisions(ds); setPatterns(ps); })
      .catch(() => {/* non-fatal */});
  }, [selected]);

  if (loading) return <div className="loading">Loading…</div>;
  if (error) return <div className="error-banner">{error}</div>;
  if (projects.length === 0) return (
    <div className="empty">
      <p>No projects registered.</p>
      <p style={{ marginTop: 8, fontFamily: 'var(--mono)', fontSize: 12 }}>Run: nexus project add &lt;path&gt;</p>
    </div>
  );

  return (
    <div style={{ display: 'flex', gap: 16, height: '100%' }}>
      {/* Project list */}
      <div style={{ width: 260, flexShrink: 0 }}>
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {projects.map(p => (
            <button
              key={p.id}
              onClick={() => setSelected(p)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '12px 16px',
                background: selected?.id === p.id ? 'var(--bg3)' : 'transparent',
                border: 'none', borderBottom: '1px solid var(--border)',
                cursor: 'pointer', color: 'var(--text)',
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</div>
              <div style={{ fontSize: 11, color: 'var(--text2)', fontFamily: 'var(--mono)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.path}
              </div>
              {p.tags.length > 0 && (
                <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {p.tags.map(t => <span key={t} className="badge badge-gray">{t}</span>)}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Detail panel */}
      {selected && (
        <div style={{ flex: 1, minWidth: 0 }} className="stacked">
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{selected.name}</div>
                <div style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--text2)', marginTop: 4 }}>{selected.path}</div>
              </div>
              <div style={{ textAlign: 'right', fontSize: 12, color: 'var(--text2)' }}>
                <div>Registered {new Date(selected.registeredAt).toLocaleDateString()}</div>
                {selected.lastSeenAt && <div>Last seen {new Date(selected.lastSeenAt).toLocaleDateString()}</div>}
              </div>
            </div>
          </div>

          <section>
            <div className="section-header">
              <span className="section-title">Decisions ({decisions.length})</span>
            </div>
            {decisions.length === 0
              ? <div className="empty">No decisions recorded</div>
              : (
                <div className="card table-wrap" style={{ padding: 0 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Kind</th>
                        <th>Summary</th>
                        <th>Recorded</th>
                      </tr>
                    </thead>
                    <tbody>
                      {decisions.map(d => (
                        <tr key={d.id}>
                          <td><span className={`badge ${kindBadge(d.kind)}`}>{d.kind}</span></td>
                          <td>
                            <div>{d.summary}</div>
                            {d.rationale && <div className="rationale">{d.rationale}</div>}
                          </td>
                          <td style={{ color: 'var(--text2)', whiteSpace: 'nowrap' }}>
                            {new Date(d.recordedAt).toLocaleDateString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </section>

          <section>
            <div className="section-header">
              <span className="section-title">Patterns ({patterns.length})</span>
            </div>
            {patterns.length === 0
              ? <div className="empty">No patterns detected</div>
              : (
                <div className="card table-wrap" style={{ padding: 0 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Description</th>
                        <th>Frequency</th>
                      </tr>
                    </thead>
                    <tbody>
                      {patterns.map(p => (
                        <tr key={p.id}>
                          <td style={{ fontWeight: 500 }}>{p.name}</td>
                          <td style={{ color: 'var(--text2)' }}>{p.description}</td>
                          <td><span className="badge badge-blue">{p.frequency}×</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </section>
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
