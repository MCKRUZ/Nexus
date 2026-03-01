import { useEffect, useState } from 'react';
import { api, type Project, type Pattern } from '../api.js';

interface PatternWithProject extends Pattern {
  projectName: string;
}

export function Patterns() {
  const [patterns, setPatterns] = useState<PatternWithProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');

  useEffect(() => {
    api.projects.list()
      .then(async (projects: Project[]) => {
        const all = await Promise.all(
          projects.map(p =>
            api.projects.patterns(p.id).then(ps =>
              ps.map(pat => ({ ...pat, projectName: p.name })),
            ),
          ),
        );
        return all.flat().sort((a, b) => b.frequency - a.frequency);
      })
      .then(setPatterns)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading">Loading…</div>;
  if (error) return <div className="error-banner">{error}</div>;

  const displayed = filter
    ? patterns.filter(p =>
        p.name.toLowerCase().includes(filter.toLowerCase()) ||
        p.description.toLowerCase().includes(filter.toLowerCase()),
      )
    : patterns;

  return (
    <div className="stacked">
      <input
        className="search-input"
        placeholder="Filter patterns…"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        style={{ maxWidth: 400 }}
      />

      {displayed.length === 0
        ? <div className="empty">{filter ? 'No patterns match filter' : 'No patterns detected yet'}</div>
        : (
          <div className="card table-wrap" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Pattern</th>
                  <th>Description</th>
                  <th>Project</th>
                  <th>Frequency</th>
                  <th>Last Seen</th>
                </tr>
              </thead>
              <tbody>
                {displayed.map(p => (
                  <tr key={p.id}>
                    <td style={{ fontWeight: 600 }}>{p.name}</td>
                    <td style={{ color: 'var(--text2)', maxWidth: 400 }}>
                      {p.description}
                      {p.examplePath && (
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--accent)', marginTop: 4 }}>
                          {p.examplePath}
                        </div>
                      )}
                    </td>
                    <td><span className="badge badge-blue">{p.projectName}</span></td>
                    <td>
                      <FrequencyBar value={p.frequency} max={displayed[0]?.frequency ?? 1} />
                    </td>
                    <td style={{ color: 'var(--text2)', whiteSpace: 'nowrap', fontSize: 12 }}>
                      {new Date(p.lastSeenAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

function FrequencyBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width: 60, height: 6, background: 'var(--bg3)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--purple)', borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: 12, color: 'var(--text2)' }}>{value}×</span>
    </div>
  );
}
