import { useEffect, useState, useMemo } from 'react';
import { api, type Project, type Decision, type Pattern, type Note } from '../api.js';

const DECISION_KINDS = ['architecture', 'library', 'pattern', 'naming', 'security', 'other'] as const;

const RECENCY_OPTIONS = [
  { label: 'All time', days: null },
  { label: 'Last 7d', days: 7 },
  { label: 'Last 30d', days: 30 },
  { label: 'Older', days: -1 }, // special: older than 30 days
] as const;

type RecencyOption = typeof RECENCY_OPTIONS[number];

export function Projects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [counts, setCounts] = useState<Record<string, { decisions: number; patterns: number; notes: number }>>({});
  const [selected, setSelected] = useState<Project | null>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [notesExpanded, setNotesExpanded] = useState(true);
  const [noteQuickTitle, setNoteQuickTitle] = useState('');
  const [noteQuickContent, setNoteQuickContent] = useState('');
  const [noteQuickOpen, setNoteQuickOpen] = useState(false);
  const [noteQuickSaving, setNoteQuickSaving] = useState(false);
  const [expandedNoteId, setExpandedNoteId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Project list filters
  const [projectSearch, setProjectSearch] = useState('');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [recency, setRecency] = useState<RecencyOption>(RECENCY_OPTIONS[0]);
  const [onlyWithDecisions, setOnlyWithDecisions] = useState(false);
  const [onlyWithPatterns, setOnlyWithPatterns] = useState(false);

  // Detail filters
  const [decisionSearch, setDecisionSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [patternSearch, setPatternSearch] = useState('');

  useEffect(() => {
    Promise.all([api.projects.list(), api.projects.counts()])
      .then(([ps, cs]) => {
        setProjects(ps);
        const map: Record<string, { decisions: number; patterns: number; notes: number }> = {};
        for (const c of cs) map[c.id] = { decisions: c.decisions, patterns: c.patterns, notes: c.notes ?? 0 };
        setCounts(map);
        if (ps[0]) setSelected(ps[0]);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const selectedId = selected?.id ?? null;

  useEffect(() => {
    if (!selectedId) return;
    setDecisionSearch('');
    setKindFilter(null);
    setPatternSearch('');
    setNoteQuickOpen(false);
    setExpandedNoteId(null);
    setDecisions([]);
    setPatterns([]);
    setNotes([]);
    setDetailLoading(true);

    const id = selectedId;
    Promise.allSettled([
      api.projects.decisions(id),
      api.projects.patterns(id),
      api.projects.notes(id),
    ]).then(([decisionsRes, patternsRes, notesRes]) => {
      if (decisionsRes.status === 'fulfilled') setDecisions(decisionsRes.value);
      if (patternsRes.status === 'fulfilled') setPatterns(patternsRes.value);
      if (notesRes.status === 'fulfilled') setNotes(notesRes.value);
      if (decisionsRes.status === 'rejected') console.error('decisions fetch failed:', decisionsRes.reason);
      if (patternsRes.status === 'rejected') console.error('patterns fetch failed:', patternsRes.reason);
      if (notesRes.status === 'rejected') console.error('notes fetch failed:', notesRes.reason);
    }).finally(() => setDetailLoading(false));
  }, [selectedId]);

  // Collect all unique tags across all projects
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const p of projects) for (const t of p.tags) set.add(t);
    return [...set].sort();
  }, [projects]);

  const now = Date.now();

  const filteredProjects = useMemo(() => {
    return projects.filter(p => {
      // Text search
      if (projectSearch.trim()) {
        const q = projectSearch.toLowerCase();
        if (!p.name.toLowerCase().includes(q) && !p.path.toLowerCase().includes(q)) return false;
      }
      // Tag filter
      if (tagFilter && !p.tags.includes(tagFilter)) return false;
      // Recency filter
      if (recency.days !== null) {
        const last = p.lastSeenAt ?? p.registeredAt;
        if (recency.days === -1) {
          if (now - last < 30 * 86400_000) return false; // older than 30d
        } else {
          if (now - last > recency.days * 86400_000) return false;
        }
      }
      // Has decisions / patterns
      const c = counts[p.id];
      if (onlyWithDecisions && (!c || c.decisions === 0)) return false;
      if (onlyWithPatterns && (!c || c.patterns === 0)) return false;
      return true;
    });
  }, [projects, projectSearch, tagFilter, recency, onlyWithDecisions, onlyWithPatterns, counts, now]);

  const filteredDecisions = useMemo(() => {
    return decisions.filter(d => {
      if (kindFilter && d.kind !== kindFilter) return false;
      if (decisionSearch.trim()) {
        const q = decisionSearch.toLowerCase();
        if (!d.summary.toLowerCase().includes(q) && !(d.rationale ?? '').toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [decisions, kindFilter, decisionSearch]);

  const filteredPatterns = useMemo(() => {
    if (!patternSearch.trim()) return patterns;
    const q = patternSearch.toLowerCase();
    return patterns.filter(p => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
  }, [patterns, patternSearch]);

  const activeKinds = useMemo(() => new Set(decisions.map(d => d.kind)), [decisions]);

  const anyProjectFilter = projectSearch.trim() || tagFilter || recency.days !== null || onlyWithDecisions || onlyWithPatterns;

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
      {/* Project list + filters */}
      <div style={{ width: 270, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* Text search */}
        <input
          className="filter-input"
          placeholder="Search by name or path…"
          value={projectSearch}
          onChange={e => setProjectSearch(e.target.value)}
        />

        {/* Tag pills */}
        {allTags.length > 0 && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {allTags.map(t => (
              <button
                key={t}
                onClick={() => setTagFilter(tagFilter === t ? null : t)}
                className="badge badge-gray"
                style={{
                  cursor: 'pointer', border: 'none',
                  opacity: tagFilter && tagFilter !== t ? 0.35 : 1,
                  outline: tagFilter === t ? '2px solid var(--accent)' : 'none',
                  outlineOffset: 1,
                }}
              >
                {t}
              </button>
            ))}
          </div>
        )}

        {/* Recency pills */}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {RECENCY_OPTIONS.map(opt => (
            <button
              key={opt.label}
              onClick={() => setRecency(opt)}
              className="badge badge-gray"
              style={{
                cursor: 'pointer', border: 'none',
                opacity: recency.label !== opt.label ? 0.45 : 1,
                outline: recency.label === opt.label ? '2px solid var(--accent)' : 'none',
                outlineOffset: 1,
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Toggle: has decisions / has patterns */}
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={() => setOnlyWithDecisions(v => !v)}
            className={`badge ${onlyWithDecisions ? 'badge-blue' : 'badge-gray'}`}
            style={{ cursor: 'pointer', border: 'none', opacity: onlyWithDecisions ? 1 : 0.55 }}
          >
            Has decisions
          </button>
          <button
            onClick={() => setOnlyWithPatterns(v => !v)}
            className={`badge ${onlyWithPatterns ? 'badge-green' : 'badge-gray'}`}
            style={{ cursor: 'pointer', border: 'none', opacity: onlyWithPatterns ? 1 : 0.55 }}
          >
            Has patterns
          </button>
        </div>

        {/* Clear filters */}
        {anyProjectFilter && (
          <button
            onClick={() => { setProjectSearch(''); setTagFilter(null); setRecency(RECENCY_OPTIONS[0]); setOnlyWithDecisions(false); setOnlyWithPatterns(false); }}
            style={{ fontSize: 11, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0 }}
          >
            Clear filters
          </button>
        )}

        {/* Project list */}
        <div className="card" style={{ padding: 0, overflow: 'hidden auto', flex: 1 }}>
          {filteredProjects.length === 0
            ? <div style={{ padding: '16px', color: 'var(--text2)', fontSize: 13 }}>No matches</div>
            : filteredProjects.map(p => {
              const c = counts[p.id];
              return (
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
                  {/* Counts row */}
                  {c && (c.decisions > 0 || c.patterns > 0 || c.notes > 0) && (
                    <div style={{ marginTop: 5, display: 'flex', gap: 4 }}>
                      {c.decisions > 0 && <span className="badge badge-blue">{c.decisions} decisions</span>}
                      {c.patterns > 0 && <span className="badge badge-green">{c.patterns} patterns</span>}
                      {c.notes > 0 && <span className="badge badge-purple">{c.notes} notes</span>}
                    </div>
                  )}
                  {p.tags.length > 0 && (
                    <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {p.tags.map(t => <span key={t} className="badge badge-gray">{t}</span>)}
                    </div>
                  )}
                </button>
              );
            })
          }
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
                {detailLoading && <div style={{ color: 'var(--accent)', marginTop: 4 }}>Loading…</div>}
              </div>
            </div>
          </div>

          <section>
            <div className="section-header" style={{ flexWrap: 'wrap', gap: 8 }}>
              <span className="section-title">
                Decisions ({filteredDecisions.length}{filteredDecisions.length !== decisions.length ? ` of ${decisions.length}` : ''})
              </span>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginLeft: 'auto' }}>
                {decisions.length > 0 && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {DECISION_KINDS.filter(k => activeKinds.has(k)).map(k => (
                      <button
                        key={k}
                        onClick={() => setKindFilter(kindFilter === k ? null : k)}
                        className={`badge ${kindBadge(k)}`}
                        style={{
                          cursor: 'pointer', border: 'none',
                          opacity: kindFilter && kindFilter !== k ? 0.35 : 1,
                          outline: kindFilter === k ? '2px solid var(--accent)' : 'none',
                          outlineOffset: 1,
                        }}
                      >
                        {k}
                      </button>
                    ))}
                  </div>
                )}
                {decisions.length > 0 && (
                  <input
                    className="filter-input"
                    style={{ width: 180 }}
                    placeholder="Search decisions…"
                    value={decisionSearch}
                    onChange={e => setDecisionSearch(e.target.value)}
                  />
                )}
              </div>
            </div>
            {decisions.length === 0
              ? <div className="empty">No decisions recorded</div>
              : filteredDecisions.length === 0
                ? <div className="empty">No decisions match the current filter</div>
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
                        {filteredDecisions.map(d => (
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
              <span className="section-title">
                Patterns ({filteredPatterns.length}{filteredPatterns.length !== patterns.length ? ` of ${patterns.length}` : ''})
              </span>
              {patterns.length > 0 && (
                <input
                  className="filter-input"
                  style={{ width: 180, marginLeft: 'auto' }}
                  placeholder="Search patterns…"
                  value={patternSearch}
                  onChange={e => setPatternSearch(e.target.value)}
                />
              )}
            </div>
            {patterns.length === 0
              ? <div className="empty">No patterns detected</div>
              : filteredPatterns.length === 0
                ? <div className="empty">No patterns match the current filter</div>
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
                        {filteredPatterns.map(p => (
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

          <section>
            <div className="section-header">
              <button
                onClick={() => setNotesExpanded((v) => !v)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <span style={{ fontSize: 12, color: 'var(--text2)' }}>{notesExpanded ? '▾' : '▸'}</span>
                <span className="section-title">Notes ({notes.length})</span>
              </button>
              <button
                onClick={() => setNoteQuickOpen((v) => !v)}
                style={{
                  marginLeft: 'auto',
                  background: 'var(--accent)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 5,
                  padding: '3px 10px',
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                + Add note
              </button>
            </div>

            {noteQuickOpen && (
              <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <input
                  className="filter-input"
                  placeholder="Note title…"
                  value={noteQuickTitle}
                  onChange={(e) => setNoteQuickTitle(e.target.value)}
                />
                <textarea
                  value={noteQuickContent}
                  onChange={(e) => setNoteQuickContent(e.target.value)}
                  placeholder="Note content…"
                  style={{
                    background: 'var(--bg2)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    color: 'var(--text)',
                    padding: '6px 10px',
                    fontSize: 13,
                    fontFamily: 'var(--mono)',
                    minHeight: 100,
                    resize: 'vertical',
                  }}
                />
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    disabled={noteQuickSaving}
                    onClick={async () => {
                      if (!selected || !noteQuickTitle.trim() || !noteQuickContent.trim()) return;
                      setNoteQuickSaving(true);
                      try {
                        const saved = await api.notes.upsert({
                          projectId: selected.id,
                          title: noteQuickTitle.trim(),
                          content: noteQuickContent,
                        });
                        setNotes((prev) => {
                          const idx = prev.findIndex((n) => n.id === saved.id);
                          return idx >= 0
                            ? prev.map((n) => (n.id === saved.id ? saved : n))
                            : [saved, ...prev];
                        });
                        setNoteQuickTitle('');
                        setNoteQuickContent('');
                        setNoteQuickOpen(false);
                      } catch { /* non-fatal */ }
                      finally { setNoteQuickSaving(false); }
                    }}
                    style={{
                      background: 'var(--accent)',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 5,
                      padding: '5px 12px',
                      cursor: noteQuickSaving ? 'not-allowed' : 'pointer',
                      fontSize: 12,
                      opacity: noteQuickSaving ? 0.7 : 1,
                    }}
                  >
                    {noteQuickSaving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    onClick={() => setNoteQuickOpen(false)}
                    style={{
                      background: 'var(--bg3)',
                      color: 'var(--text)',
                      border: '1px solid var(--border)',
                      borderRadius: 5,
                      padding: '5px 12px',
                      cursor: 'pointer',
                      fontSize: 12,
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {notesExpanded && (
              notes.length === 0
                ? <div className="empty">No notes for this project</div>
                : <div className="stacked" style={{ gap: 6 }}>
                    {notes.map((n) => (
                      <div
                        key={n.id}
                        className="card"
                        style={{ cursor: 'pointer', padding: '10px 14px' }}
                        onClick={() => setExpandedNoteId(expandedNoteId === n.id ? null : n.id)}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontWeight: 600, fontSize: 13 }}>{n.title}</span>
                          <span style={{ fontSize: 11, color: 'var(--text2)' }}>
                            {expandedNoteId === n.id ? '▲' : '▼'}
                          </span>
                        </div>
                        {n.tags.length > 0 && (
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                            {n.tags.map((t) => (
                              <span key={t} className="badge badge-gray">{t}</span>
                            ))}
                          </div>
                        )}
                        {expandedNoteId !== n.id && (
                          <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {n.content.slice(0, 120)}
                          </div>
                        )}
                        {expandedNoteId === n.id && (
                          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--mono)', fontSize: 12, marginTop: 8, color: 'var(--text)', lineHeight: 1.5 }}>
                            {n.content}
                          </pre>
                        )}
                        <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 4 }}>
                          Updated {new Date(n.updatedAt).toLocaleDateString()}
                        </div>
                      </div>
                    ))}
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
