import { useEffect, useState } from 'react';
import { api, type ConflictCheck } from '../api.js';

export function Conflicts() {
  const [data, setData] = useState<ConflictCheck | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = () => {
    setLoading(true);
    api.conflicts.check()
      .then(setData)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  if (loading) return <div className="loading">Checking for conflicts…</div>;
  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return null;

  const open = data.conflicts.filter(c => !c.resolvedAt);
  const resolved = data.conflicts.filter(c => c.resolvedAt);

  return (
    <div className="stacked">
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 12 }}>
          <span className="badge badge-red">{open.length} open</span>
          <span className="badge badge-green">{resolved.length} resolved</span>
          {data.potentialConflicts.length > 0 && (
            <span className="badge badge-yellow">{data.potentialConflicts.length} potential</span>
          )}
        </div>
        <button className="btn" onClick={load} style={{ marginLeft: 'auto' }}>
          ↻ Refresh
        </button>
      </div>

      {data.potentialConflicts.length > 0 && (
        <section>
          <div className="section-header">
            <span className="section-title">⚠ Potential Conflicts</span>
          </div>
          <div className="stacked">
            {data.potentialConflicts.map((pc, i) => (
              <div key={i} className="conflict-card" style={{ borderColor: 'rgba(210,153,34,0.4)' }}>
                <div className="conflict-title" style={{ color: 'var(--yellow)' }}>{pc.topic}</div>
                <div style={{ fontSize: 13, color: 'var(--text2)', marginTop: 6 }}>{pc.description}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {open.length > 0 && (
        <section>
          <div className="section-header">
            <span className="section-title">Open Conflicts</span>
          </div>
          <div>
            {open.map(c => (
              <div key={c.id} className="conflict-card" style={{ borderColor: 'rgba(248,81,73,0.4)' }}>
                <div className="conflict-title">{c.description}</div>
                <div className="conflict-meta">
                  Detected {new Date(c.detectedAt).toLocaleDateString()}
                  {c.projectIds.length > 0 && ` · ${c.projectIds.length} projects`}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {resolved.length > 0 && (
        <section>
          <div className="section-header">
            <span className="section-title">Resolved</span>
          </div>
          <div>
            {resolved.map(c => (
              <div key={c.id} className="conflict-card resolved">
                <div className="conflict-title">{c.description}</div>
                <div className="conflict-meta">
                  Detected {new Date(c.detectedAt).toLocaleDateString()}
                </div>
                {c.resolution && (
                  <div className="conflict-resolution">✓ {c.resolution}</div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {!data.hasConflicts && data.potentialConflicts.length === 0 && (
        <div className="empty" style={{ padding: 64 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>✓</div>
          <div style={{ color: 'var(--green)' }}>No conflicts detected across projects</div>
        </div>
      )}
    </div>
  );
}
