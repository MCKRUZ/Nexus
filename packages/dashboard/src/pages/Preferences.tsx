import { useEffect, useState } from 'react';
import { api, type Preference, type Project } from '../api.js';

export function Preferences() {
  const [prefs, setPrefs] = useState<Preference[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [scopeFilter, setScopeFilter] = useState<'all' | 'global' | 'project'>('all');

  // Add pref form state
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newScope, setNewScope] = useState<'global' | 'project'>('global');
  const [newProjectId, setNewProjectId] = useState('');
  const [saving, setSaving] = useState(false);

  const load = () => {
    Promise.all([api.preferences.list(), api.projects.list()])
      .then(([ps, projs]) => { setPrefs(ps); setProjects(projs); })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleSave = async () => {
    if (!newKey.trim() || !newValue.trim()) return;
    setSaving(true);
    try {
      await api.preferences.set({
        key: newKey.trim(),
        value: newValue.trim(),
        scope: newScope,
        ...(newScope === 'project' && newProjectId ? { projectId: newProjectId } : {}),
      });
      setNewKey(''); setNewValue(''); setNewProjectId('');
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="loading">Loading…</div>;
  if (error) return <div className="error-banner">{error}</div>;

  const displayed = scopeFilter === 'all' ? prefs : prefs.filter(p => p.scope === scopeFilter);

  const projectName = (id?: string) => projects.find(p => p.id === id)?.name ?? id ?? '—';

  return (
    <div className="stacked">
      {/* Intro */}
      <div className="card" style={{ padding: '12px 16px' }}>
        <p style={{ margin: 0, color: 'var(--text2)', fontSize: 13, lineHeight: 1.5 }}>
          Persistent key-value settings that Claude reads at runtime via <code style={{ background: 'var(--bg3)', padding: '1px 5px', borderRadius: 4, fontSize: 12 }}>nexus_preferences</code>.
          {' '}<strong style={{ color: 'var(--text)' }}>Global</strong> preferences apply everywhere;
          {' '}<strong style={{ color: 'var(--text)' }}>project-scoped</strong> ones override per-project.
          {' '}Examples: <code style={{ background: 'var(--bg3)', padding: '1px 5px', borderRadius: 4, fontSize: 12 }}>default_model</code>,
          {' '}<code style={{ background: 'var(--bg3)', padding: '1px 5px', borderRadius: 4, fontSize: 12 }}>code_style</code>,
          {' '}<code style={{ background: 'var(--bg3)', padding: '1px 5px', borderRadius: 4, fontSize: 12 }}>test_framework</code>
        </p>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8 }}>
        {(['all', 'global', 'project'] as const).map(s => (
          <button
            key={s}
            className={`btn${scopeFilter === s ? ' btn-primary' : ''}`}
            onClick={() => setScopeFilter(s)}
            style={{ textTransform: 'capitalize' }}
          >
            {s}
          </button>
        ))}
      </div>

      {/* List */}
      {displayed.length === 0
        ? <div className="empty">No preferences set</div>
        : (
          <div className="card" style={{ padding: '0 16px' }}>
            {displayed.map(p => (
              <div key={p.id} className="pref-row">
                <span className="pref-key">{p.key}</span>
                <span className="pref-value">{p.value}</span>
                <span className={`badge ${p.scope === 'global' ? 'badge-blue' : 'badge-green'}`}>{p.scope}</span>
                {p.scope === 'project' && p.projectId && (
                  <span className="pref-scope">{projectName(p.projectId)}</span>
                )}
              </div>
            ))}
          </div>
        )}

      {/* Add new */}
      <section>
        <div className="section-header">
          <span className="section-title">Set Preference</span>
        </div>
        <div className="card">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <input
              className="search-input"
              placeholder="Key (e.g. default_model)"
              value={newKey}
              onChange={e => setNewKey(e.target.value)}
            />
            <input
              className="search-input"
              placeholder="Value"
              value={newValue}
              onChange={e => setNewValue(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 12, alignItems: 'center' }}>
            <select
              value={newScope}
              onChange={e => setNewScope(e.target.value as 'global' | 'project')}
              style={{ background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--text)', padding: '6px 10px', borderRadius: 'var(--radius)', fontSize: 13 }}
            >
              <option value="global">Global</option>
              <option value="project">Project-specific</option>
            </select>
            {newScope === 'project' && (
              <select
                value={newProjectId}
                onChange={e => setNewProjectId(e.target.value)}
                style={{ background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--text)', padding: '6px 10px', borderRadius: 'var(--radius)', fontSize: 13 }}
              >
                <option value="">Select project…</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={saving || !newKey.trim() || !newValue.trim()}
              style={{ marginLeft: 'auto' }}
            >
              {saving ? 'Saving…' : 'Set'}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
