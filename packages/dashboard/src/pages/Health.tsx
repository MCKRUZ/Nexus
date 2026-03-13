import { useEffect, useState } from 'react';
import {
  api,
  type DoctorReport,
  type DoctorFixResult,
  type PipelineStats,
  type ProjectHealth,
} from '../api.js';

function StatusDot({ status }: { status: 'pass' | 'warn' | 'fail' }) {
  const colors = { pass: '#3fb950', warn: '#d29922', fail: '#f85149' };
  return (
    <span
      style={{
        display: 'inline-block',
        width: 10,
        height: 10,
        borderRadius: '50%',
        background: colors[status],
        marginRight: 8,
      }}
    />
  );
}

function scoreColor(score: number): string {
  if (score >= 80) return '#3fb950';
  if (score >= 50) return '#d29922';
  return '#f85149';
}

export function Health() {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [pipeline, setPipeline] = useState<PipelineStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fixing, setFixing] = useState(false);
  const [fixResult, setFixResult] = useState<DoctorFixResult | null>(null);

  const loadData = () => {
    Promise.all([api.health.doctor(), api.health.pipeline(7)])
      .then(([doc, pipe]) => {
        setReport(doc);
        setPipeline(pipe);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleFix = async () => {
    setFixing(true);
    setFixResult(null);
    try {
      const result = await api.health.fix();
      setFixResult(result);
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFixing(false);
    }
  };

  if (error) {
    return <div className="card" style={{ color: 'var(--danger, #e55)' }}>Failed to load health data: {error}</div>;
  }

  if (!report || !pipeline) {
    return <div className="card" style={{ color: 'var(--text2)' }}>Loading diagnostics...</div>;
  }

  const totalProjects = report.projects.length;
  const avgCoverage = totalProjects > 0
    ? Math.round(report.projects.reduce((s, p) => s + p.coverageScore, 0) / totalProjects)
    : 0;
  const totalRuns = pipeline.hookRuns + pipeline.hookSkips;
  const successRate = totalRuns > 0
    ? Math.round((pipeline.extractionSuccesses / totalRuns) * 100)
    : 0;
  const totalKnowledge = report.projects.reduce(
    (s, p) => s + p.noteCount + p.decisionCount + p.patternCount,
    0,
  );

  const gaps = report.projects.filter(
    (p) => p.gaps.length > 0,
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <KpiCard label="Projects Tracked" value={String(totalProjects)} />
        <KpiCard
          label="Pipeline Success Rate"
          value={`${successRate}%`}
          sub={`${pipeline.extractionSuccesses}/${totalRuns} runs (7d)`}
        />
        <KpiCard
          label="Avg Coverage"
          value={`${avgCoverage}/100`}
          color={scoreColor(avgCoverage)}
        />
        <KpiCard label="Knowledge Items" value={String(totalKnowledge)} />
      </div>

      {/* Fix Issues */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          onClick={handleFix}
          disabled={fixing}
          style={{
            padding: '8px 16px',
            borderRadius: 6,
            border: 'none',
            background: fixing ? 'var(--surface2, #1a1a2e)' : '#3fb950',
            color: '#fff',
            fontWeight: 600,
            cursor: fixing ? 'not-allowed' : 'pointer',
            fontSize: 13,
          }}
        >
          {fixing ? 'Fixing...' : 'Fix Issues'}
        </button>
        <span style={{ fontSize: 12, color: 'var(--text2)' }}>
          Links project families + syncs stale CLAUDE.md files
        </span>
      </div>

      {fixResult && (
        <div className="card">
          <h3 style={{ margin: '0 0 12px' }}>Fix Results</h3>
          {fixResult.linkedFamilies.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <strong style={{ fontSize: 13 }}>Linked Families</strong>
              {fixResult.linkedFamilies.map((f) => (
                <div key={f.rootName} style={{ marginLeft: 12, marginTop: 4, fontSize: 13 }}>
                  <span style={{ color: '#3fb950' }}>{f.rootName}</span>
                  {f.children.map((c) => (
                    <div key={c} style={{ marginLeft: 16, color: 'var(--text2)' }}>
                      {'\u2514\u2500'} {c}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          {fixResult.syncedProjects.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <strong style={{ fontSize: 13 }}>Synced ({fixResult.syncedProjects.length})</strong>
              <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 4 }}>
                {fixResult.syncedProjects.join(', ')}
              </div>
            </div>
          )}
          {fixResult.skippedProjects.length > 0 && (
            <div>
              <strong style={{ fontSize: 13, color: '#d29922' }}>Skipped ({fixResult.skippedProjects.length})</strong>
              <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 4 }}>
                {fixResult.skippedProjects.join(', ')}
              </div>
            </div>
          )}
          {fixResult.linkedFamilies.length === 0 && fixResult.syncedProjects.length === 0 && (
            <div style={{ color: 'var(--text2)', fontSize: 13 }}>Nothing to fix — all projects are healthy.</div>
          )}
        </div>
      )}

      {/* Pipeline Stats */}
      <div className="card">
        <h3 style={{ margin: '0 0 12px' }}>Pipeline Activity (7d)</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
          <StatItem label="Hook Runs" value={pipeline.hookRuns} />
          <StatItem label="Hook Skips" value={pipeline.hookSkips} />
          <StatItem label="Extractions OK" value={pipeline.extractionSuccesses} color="#3fb950" />
          <StatItem label="Extractions Failed" value={pipeline.extractionFailures} color="#f85149" />
          <StatItem label="Syncs OK" value={pipeline.syncSuccesses} color="#3fb950" />
          <StatItem label="Syncs Failed" value={pipeline.syncFailures} color="#f85149" />
          <StatItem label="Avg Items/Run" value={pipeline.avgExtractedItems} />
          <StatItem label="Last Run" value={pipeline.lastRun ? timeAgo(pipeline.lastRun) : 'Never'} />
        </div>
      </div>

      {/* System Checks */}
      <div className="card">
        <h3 style={{ margin: '0 0 12px' }}>
          System Checks
          <span style={{
            marginLeft: 8,
            fontSize: 12,
            padding: '2px 8px',
            borderRadius: 4,
            background: report.overall === 'healthy' ? '#3fb950' : report.overall === 'degraded' ? '#d29922' : '#f85149',
            color: '#fff',
          }}>
            {report.overall.toUpperCase()}
          </span>
        </h3>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            {report.checks.map((check) => (
              <tr key={check.name} style={{ borderBottom: '1px solid var(--border, #222)' }}>
                <td style={{ padding: '6px 8px', width: 30 }}>
                  <StatusDot status={check.status} />
                </td>
                <td style={{ padding: '6px 8px' }}>{check.name}</td>
                <td style={{ padding: '6px 8px', color: 'var(--text2)', fontSize: 13 }}>
                  {check.message}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Per-Project Coverage */}
      {report.projects.length > 0 && (
        <div className="card">
          <h3 style={{ margin: '0 0 12px' }}>Project Coverage</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border, #333)', textAlign: 'left' }}>
                <th style={{ padding: '6px 8px' }}>Project</th>
                <th style={{ padding: '6px 8px', textAlign: 'center' }}>Score</th>
                <th style={{ padding: '6px 8px', textAlign: 'center' }}>Notes</th>
                <th style={{ padding: '6px 8px', textAlign: 'center' }}>Decisions</th>
                <th style={{ padding: '6px 8px', textAlign: 'center' }}>Patterns</th>
                <th style={{ padding: '6px 8px' }}>Last Sync</th>
                <th style={{ padding: '6px 8px' }}>Gaps</th>
              </tr>
            </thead>
            <tbody>
              {report.projects
                .sort((a, b) => a.coverageScore - b.coverageScore)
                .map((p) => (
                  <tr key={p.projectId} style={{ borderBottom: '1px solid var(--border, #222)' }}>
                    <td style={{ padding: '6px 8px' }}>{p.projectName}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                      <span style={{
                        fontWeight: 600,
                        color: scoreColor(p.coverageScore),
                      }}>
                        {p.coverageScore}
                      </span>
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'center' }}>{p.noteCount}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'center' }}>{p.decisionCount}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'center' }}>{p.patternCount}</td>
                    <td style={{ padding: '6px 8px', color: 'var(--text2)' }}>
                      {p.lastSyncAge !== null
                        ? p.lastSyncAge < 24
                          ? `${Math.round(p.lastSyncAge)}h ago`
                          : `${Math.round(p.lastSyncAge / 24)}d ago`
                        : 'Never'}
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      {p.gaps.map((g) => (
                        <span
                          key={g}
                          style={{
                            display: 'inline-block',
                            fontSize: 11,
                            padding: '1px 6px',
                            borderRadius: 3,
                            background: 'var(--surface2, #1a1a2e)',
                            color: '#d29922',
                            marginRight: 4,
                            marginBottom: 2,
                          }}
                        >
                          {g}
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Knowledge Gaps */}
      {gaps.length > 0 && (
        <div className="card">
          <h3 style={{ margin: '0 0 12px' }}>Knowledge Gaps</h3>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {gaps.map((p) => (
              <li key={p.projectId} style={{ marginBottom: 4 }}>
                <strong>{p.projectName}</strong>
                <span style={{ color: 'var(--text2)', marginLeft: 8 }}>
                  {p.gaps.join(', ')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function KpiCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="card" style={{ textAlign: 'center', padding: '16px 12px' }}>
      <div style={{ fontSize: 28, fontWeight: 700, color: color ?? 'var(--text)' }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 4 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text3, #666)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function StatItem({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 20, fontWeight: 600, color: color ?? 'var(--text)' }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text2)' }}>{label}</div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3600000);
  const m = Math.floor(diff / 60000);
  if (h > 24) return `${Math.round(h / 24)}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return 'just now';
}
