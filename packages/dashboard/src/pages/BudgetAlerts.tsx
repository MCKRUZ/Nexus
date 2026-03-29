import { useEffect, useState, useCallback } from 'react';
import { api, type BudgetConfig, type BudgetCheckResult, type BudgetEvent, type Project } from '../api.js';

function KpiCard({ label, value, color, sub }: { label: string; value: string | number; color: string; sub?: string }) {
  return (
    <div className="card">
      <div className="card-title">{label}</div>
      <div className="card-value" style={{ color: `var(--${color})` }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = { clear: 'var(--success)', warning: 'var(--warning)', critical: 'var(--danger)' };
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 4,
      fontSize: 11,
      fontWeight: 600,
      background: colors[status] ?? 'var(--text2)',
      color: '#fff',
      textTransform: 'uppercase',
    }}>
      {status}
    </span>
  );
}

function BudgetGauge({ current, warn, crit, status }: {
  current: number; warn: number; crit: number; status: string;
}) {
  const max = Math.max(crit * 1.2, current * 1.1);
  const pct = (current / max) * 100;
  const warnPct = (warn / max) * 100;
  const critPct = (crit / max) * 100;
  const fillColor = status === 'critical' ? 'var(--danger)' : status === 'warning' ? 'var(--warning)' : 'var(--success)';

  return (
    <div style={{ position: 'relative', height: 24, background: 'var(--bg2)', borderRadius: 4, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', height: '100%', width: `${Math.min(pct, 100)}%`, background: fillColor, borderRadius: 4, transition: 'width 0.3s' }} />
      <div style={{ position: 'absolute', left: `${warnPct}%`, height: '100%', width: 2, background: 'var(--warning)', opacity: 0.7 }} />
      <div style={{ position: 'absolute', left: `${critPct}%`, height: '100%', width: 2, background: 'var(--danger)', opacity: 0.7 }} />
      <div style={{ position: 'absolute', width: '100%', textAlign: 'center', lineHeight: '24px', fontSize: 11, fontWeight: 600, color: pct > 50 ? '#fff' : 'var(--text1)' }}>
        ${current.toFixed(2)} / ${crit.toFixed(2)}
      </div>
    </div>
  );
}

export function BudgetAlerts() {
  const [configs, setConfigs] = useState<BudgetConfig[]>([]);
  const [status, setStatus] = useState<BudgetCheckResult[]>([]);
  const [history, setHistory] = useState<BudgetEvent[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);

  // Form state
  const [formName, setFormName] = useState('');
  const [formPeriod, setFormPeriod] = useState<'daily' | 'weekly' | 'monthly'>('monthly');
  const [formProjectId, setFormProjectId] = useState('');
  const [formWarnAt, setFormWarnAt] = useState('');
  const [formCritAt, setFormCritAt] = useState('');

  const load = useCallback(async () => {
    try {
      const [c, s, h, p] = await Promise.all([
        api.budget.list(),
        api.budget.status(),
        api.budget.history(),
        api.projects.list(),
      ]);
      setConfigs(c);
      setStatus(s);
      setHistory(h);
      setProjects(p);
    } catch (e) {
      console.error('Budget load error:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!formName || !formWarnAt || !formCritAt) return;
    try {
      await api.budget.upsert({
        name: formName,
        period: formPeriod,
        warnAt: parseFloat(formWarnAt),
        critAt: parseFloat(formCritAt),
        ...(formProjectId ? { projectId: formProjectId } : {}),
      });
      setFormName('');
      setFormWarnAt('');
      setFormCritAt('');
      setFormProjectId('');
      setShowForm(false);
      load();
    } catch (e) {
      console.error('Create budget error:', e);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.budget.delete(id);
      load();
    } catch (e) {
      console.error('Delete budget error:', e);
    }
  };

  const handleSilence = async (id: string) => {
    try {
      await api.budget.silence(id, 24 * 3600000); // 24h
      load();
    } catch (e) {
      console.error('Silence budget error:', e);
    }
  };

  const handleUnsilence = async (id: string) => {
    try {
      await api.budget.unsilence(id);
      load();
    } catch (e) {
      console.error('Unsilence budget error:', e);
    }
  };

  if (loading) return <div style={{ padding: 24, color: 'var(--text2)' }}>Loading...</div>;

  const activeAlerts = status.filter((s) => s.status !== 'clear');
  const highestPct = status.length > 0 ? Math.max(...status.map((s) => s.percentUsed)) : 0;
  const todaySpend = status.reduce((sum, s) => s.period === 'daily' ? sum + s.currentSpend : sum, 0);

  return (
    <div>
      {/* KPI cards */}
      <div className="stats-grid">
        <KpiCard label="Budgets Configured" value={configs.length} color="accent" />
        <KpiCard label="Active Alerts" value={activeAlerts.length} color={activeAlerts.length > 0 ? 'danger' : 'success'} sub={activeAlerts.length > 0 ? activeAlerts.map((a) => a.configName).join(', ') : 'All clear'} />
        <KpiCard label="Highest Usage" value={`${Math.round(highestPct)}%`} color={highestPct >= 95 ? 'danger' : highestPct >= 80 ? 'warning' : 'success'} />
        <KpiCard label="Alert Events" value={history.length} color="text1" sub="state transitions" />
      </div>

      {/* Create button */}
      <div style={{ marginTop: 24, marginBottom: 16 }}>
        <button className="btn" onClick={() => setShowForm(!showForm)} style={{ fontSize: 13 }}>
          {showForm ? 'Cancel' : '+ New Budget'}
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <div className="card" style={{ marginBottom: 24, padding: 16 }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 14 }}>New Budget Alert</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ fontSize: 11, color: 'var(--text2)' }}>Name</label>
              <input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="Monthly cap" style={{ width: '100%', marginTop: 4 }} />
            </div>
            <div>
              <label style={{ fontSize: 11, color: 'var(--text2)' }}>Period</label>
              <select value={formPeriod} onChange={(e) => setFormPeriod(e.target.value as 'daily' | 'weekly' | 'monthly')} style={{ width: '100%', marginTop: 4 }}>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: 11, color: 'var(--text2)' }}>Scope</label>
              <select value={formProjectId} onChange={(e) => setFormProjectId(e.target.value)} style={{ width: '100%', marginTop: 4 }}>
                <option value="">Global (all projects)</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 11, color: 'var(--text2)' }}>Warning at ($)</label>
              <input type="number" step="0.01" value={formWarnAt} onChange={(e) => setFormWarnAt(e.target.value)} placeholder="50.00" style={{ width: '100%', marginTop: 4 }} />
            </div>
            <div>
              <label style={{ fontSize: 11, color: 'var(--text2)' }}>Critical at ($)</label>
              <input type="number" step="0.01" value={formCritAt} onChange={(e) => setFormCritAt(e.target.value)} placeholder="100.00" style={{ width: '100%', marginTop: 4 }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <button className="btn" onClick={handleCreate} style={{ fontSize: 13, width: '100%' }}>Create</button>
            </div>
          </div>
        </div>
      )}

      {/* Budget status cards */}
      {status.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 14, marginBottom: 12 }}>Budget Status</h3>
          <div style={{ display: 'grid', gap: 12 }}>
            {status.map((s) => {
              const config = configs.find((c) => c.id === s.configId);
              const silenced = s.silenced;
              return (
                <div key={s.configId} className="card" style={{ padding: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div>
                      <span style={{ fontWeight: 600 }}>{s.configName}</span>
                      <span style={{ fontSize: 11, color: 'var(--text2)', marginLeft: 8 }}>
                        {s.projectName ?? 'Global'} / {s.period}
                      </span>
                      {silenced && <span style={{ fontSize: 11, color: 'var(--warning)', marginLeft: 8 }}>[SILENCED]</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <StatusBadge status={s.status} />
                      {!silenced && s.status !== 'clear' && (
                        <button onClick={() => handleSilence(s.configId)} title="Silence for 24h" style={{ fontSize: 11, cursor: 'pointer', background: 'none', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 6px', color: 'var(--text2)' }}>
                          Silence 24h
                        </button>
                      )}
                      {silenced && (
                        <button onClick={() => handleUnsilence(s.configId)} title="Unsilence" style={{ fontSize: 11, cursor: 'pointer', background: 'none', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 6px', color: 'var(--text2)' }}>
                          Unsilence
                        </button>
                      )}
                      <button onClick={() => handleDelete(s.configId)} title="Delete" style={{ fontSize: 11, cursor: 'pointer', background: 'none', border: '1px solid var(--danger)', borderRadius: 4, padding: '2px 6px', color: 'var(--danger)' }}>
                        Delete
                      </button>
                    </div>
                  </div>
                  <BudgetGauge current={s.currentSpend} warn={s.warnAt} crit={s.critAt} status={s.status} />
                  <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 4 }}>
                    {Math.round(s.percentUsed)}% of critical threshold
                    {config && ` | Hysteresis: warn clears at $${config.warnClear.toFixed(2)}, crit clears at $${config.critClear.toFixed(2)}`}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Alert history */}
      {history.length > 0 && (
        <div>
          <h3 style={{ fontSize: 14, marginBottom: 12 }}>Alert History</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'left', padding: '6px 8px', color: 'var(--text2)', fontWeight: 500 }}>Time</th>
                <th style={{ textAlign: 'left', padding: '6px 8px', color: 'var(--text2)', fontWeight: 500 }}>Transition</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', color: 'var(--text2)', fontWeight: 500 }}>Spend</th>
                <th style={{ textAlign: 'right', padding: '6px 8px', color: 'var(--text2)', fontWeight: 500 }}>Threshold</th>
              </tr>
            </thead>
            <tbody>
              {history.map((e) => (
                <tr key={e.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '6px 8px' }}>{new Date(e.at).toLocaleString()}</td>
                  <td style={{ padding: '6px 8px' }}>
                    <StatusBadge status={e.previousStatus} />
                    <span style={{ margin: '0 4px' }}>&rarr;</span>
                    <StatusBadge status={e.newStatus} />
                  </td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>${e.spend.toFixed(2)}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }}>${e.threshold.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {configs.length === 0 && !showForm && (
        <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text2)' }}>
          No budget alerts configured. Click "+ New Budget" to set spending limits.
        </div>
      )}
    </div>
  );
}
