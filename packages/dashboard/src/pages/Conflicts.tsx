import { useEffect, useState } from 'react';
import { api, type ConflictCheck } from '../api.js';

const PAGE_SIZE = 20;

export function Conflicts() {
  const [data, setData] = useState<ConflictCheck | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);

  const load = () => {
    setLoading(true);
    setShowAll(false);
    api.conflicts.check()
      .then(setData)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  if (loading) return <div className="loading">Checking for conflicts...</div>;
  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return null;

  const open = data.conflicts.filter(c => !c.resolvedAt);
  const resolved = data.conflicts.filter(c => c.resolvedAt);
  const visiblePotential = showAll
    ? data.potentialConflicts
    : data.potentialConflicts.slice(0, PAGE_SIZE);
  const hasMore = data.potentialConflicts.length > PAGE_SIZE && !showAll;

  return (
    <div className="stacked">
      <p style={{ color: 'var(--text2)', fontSize: 13, margin: '0 0 8px' }}>
        Conflicts are detected between related projects (parent/child or shared tags).
        Unrelated projects are not compared.
      </p>

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
            <span className="section-title">Potential Conflicts</span>
          </div>
          <div className="stacked">
            {visiblePotential.map((pc, i) => (
              <div key={i} className="conflict-card" style={{ borderColor: 'rgba(210,153,34,0.4)' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                  <span className="conflict-title" style={{ color: 'var(--yellow)' }}>{pc.topic}</span>
                  <span className="badge" style={{ fontSize: 11 }}>{pc.projectA}</span>
                  <span style={{ color: 'var(--text3)', fontSize: 11 }}>vs</span>
                  <span className="badge" style={{ fontSize: 11 }}>{pc.projectB}</span>
                </div>
                <div style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.5 }}>
                  <div><strong>{pc.projectA}:</strong> {pc.summaryA}</div>
                  <div><strong>{pc.projectB}:</strong> {pc.summaryB}</div>
                </div>
              </div>
            ))}
          </div>
          {hasMore && (
            <button
              className="btn"
              onClick={() => setShowAll(true)}
              style={{ marginTop: 8, width: '100%' }}
            >
              Show all {data.potentialConflicts.length} potential conflicts
            </button>
          )}
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
