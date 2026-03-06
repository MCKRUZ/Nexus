import { useEffect, useState, useMemo } from 'react';
import { api, type Note, type Project, type SyncResult } from '../api.js';

interface NoteForm {
  title: string;
  content: string;
  tags: string; // comma-separated
}

const EMPTY_FORM: NoteForm = { title: '', content: '', tags: '' };

export function Notes() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [counts, setCounts] = useState<Record<string, { decisions: number; patterns: number; notes: number }>>({});
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [loading, setLoading] = useState(true);
  const [notesLoading, setNotesLoading] = useState(false);
  const [error, setError] = useState('');

  // Project sidebar filters
  const [projectSearch, setProjectSearch] = useState('');
  const [onlyWithNotes, setOnlyWithNotes] = useState(false);

  // Note list filter
  const [noteFilter, setNoteFilter] = useState('');

  // Sync state
  const [syncing, setSyncing] = useState(false);
  const [syncResults, setSyncResults] = useState<SyncResult[] | null>(null);

  // Editor state
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<NoteForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Load projects + counts
  useEffect(() => {
    Promise.allSettled([api.projects.list(), api.projects.counts()])
      .then(([psRes, csRes]) => {
        if (psRes.status === 'rejected') { setError(String(psRes.reason)); return; }
        const ps = psRes.value;
        const map: Record<string, { decisions: number; patterns: number; notes: number }> = {};
        if (csRes.status === 'fulfilled') {
          for (const c of csRes.value) map[c.id] = { decisions: c.decisions, patterns: c.patterns, notes: c.notes ?? 0 };
        }
        setCounts(map);

        // Sort: projects with notes first, then by name
        const sorted = [...ps].sort((a, b) => {
          const aNotes = map[a.id]?.notes ?? 0;
          const bNotes = map[b.id]?.notes ?? 0;
          if (bNotes !== aNotes) return bNotes - aNotes;
          return a.name.localeCompare(b.name);
        });
        setProjects(sorted);
      })
      .finally(() => setLoading(false));
  }, []);

  // Derived state — all computed synchronously, no timing issues
  const filteredProjects = useMemo(() => {
    return projects.filter(p => {
      if (projectSearch.trim()) {
        const q = projectSearch.toLowerCase();
        if (!p.name.toLowerCase().includes(q) && !p.path.toLowerCase().includes(q)) return false;
      }
      if (onlyWithNotes && (counts[p.id]?.notes ?? 0) === 0) return false;
      return true;
    });
  }, [projects, projectSearch, onlyWithNotes, counts]);

  // Effective project: explicit selection if still visible in filtered list, else first visible
  const effectiveProjectId = useMemo(() => {
    if (filteredProjects.length === 0) return null;
    if (selectedProjectId && filteredProjects.some(p => p.id === selectedProjectId)) {
      return selectedProjectId;
    }
    return filteredProjects[0]?.id ?? null;
  }, [selectedProjectId, filteredProjects]);

  const filteredNotes = useMemo(() => {
    if (!noteFilter.trim()) return notes;
    const q = noteFilter.toLowerCase();
    return notes.filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        n.content.toLowerCase().includes(q) ||
        n.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [notes, noteFilter]);

  // Load notes whenever the effective project changes
  useEffect(() => {
    if (!effectiveProjectId) return;
    setNotesLoading(true);
    setSelectedNote(null);
    setNoteFilter('');
    setEditing(false);
    api.notes
      .listForProject(effectiveProjectId)
      .then(setNotes)
      .catch(() => {/* non-fatal */})
      .finally(() => setNotesLoading(false));
  }, [effectiveProjectId]);

  function openNew() {
    setSelectedNote(null);
    setForm(EMPTY_FORM);
    setSaveError('');
    setEditing(true);
  }

  function openEdit(note: Note) {
    setSelectedNote(note);
    setForm({ title: note.title, content: note.content, tags: note.tags.join(', ') });
    setSaveError('');
    setEditing(true);
  }

  async function handleSave() {
    if (!effectiveProjectId || !form.title.trim() || !form.content.trim()) {
      setSaveError('Title and content are required.');
      return;
    }
    setSaving(true);
    setSaveError('');
    try {
      const tags = form.tags.split(',').map((t) => t.trim()).filter(Boolean);
      const saved = await api.notes.upsert({
        projectId: effectiveProjectId!,
        title: form.title.trim(),
        content: form.content,
        tags,
      });
      setNotes((prev) => {
        const idx = prev.findIndex((n) => n.id === saved.id);
        return idx >= 0 ? prev.map((n) => (n.id === saved.id ? saved : n)) : [saved, ...prev];
      });
      // Update count
      const existing = notes.some(n => n.id === saved.id);
      setCounts(prev => {
        const pid = effectiveProjectId!;
        const cur = prev[pid] ?? { decisions: 0, patterns: 0, notes: 0 };
        return { ...prev, [pid]: { ...cur, notes: cur.notes + (existing ? 0 : 1) } };
      });
      setSelectedNote(saved);
      setEditing(false);
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(noteId: string) {
    try {
      await api.notes.delete(noteId);
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      setCounts(prev => {
        const pid = effectiveProjectId!;
        const cur = prev[pid] ?? { decisions: 0, patterns: 0, notes: 0 };
        return { ...prev, [pid]: { ...cur, notes: Math.max(0, cur.notes - 1) } };
      });
      if (selectedNote?.id === noteId) setSelectedNote(null);
      setDeleteConfirm(null);
    } catch {
      // non-fatal
    }
  }

  async function handleSyncAll() {
    setSyncing(true);
    setSyncResults(null);
    try {
      const result = await api.syncAll();
      setSyncResults(result.results);
    } catch {
      // non-fatal
    } finally {
      setSyncing(false);
    }
  }

  if (loading) return <div className="loading">Loading…</div>;
  if (error) return <div className="error-banner">{error}</div>;

  const selectedProject = projects.find(p => p.id === effectiveProjectId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      {/* Sync bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          onClick={handleSyncAll}
          disabled={syncing}
          style={{
            background: syncing ? 'var(--bg3)' : 'var(--green, #48bb78)',
            color: syncing ? 'var(--text2)' : '#fff',
            border: 'none', borderRadius: 6, padding: '6px 14px',
            cursor: syncing ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: 13,
          }}
        >
          {syncing ? 'Syncing…' : 'Sync all to CLAUDE.md'}
        </button>
        {syncResults && (
          <span style={{ fontSize: 13, color: 'var(--text2)' }}>
            {syncResults.filter((r) => r.updated).length} of {syncResults.length} projects updated
            {syncResults.some((r) => r.error) && (
              <span style={{ color: 'var(--red, #f56565)', marginLeft: 8 }}>
                ({syncResults.filter((r) => r.error).length} errors)
              </span>
            )}
          </span>
        )}
      </div>
      {syncResults?.some((r) => r.error) && (
        <div className="card" style={{ padding: '8px 14px' }}>
          {syncResults.filter((r) => r.error).map((r) => (
            <div key={r.projectId} style={{ fontSize: 12, color: 'var(--red, #f56565)' }}>
              {r.projectName}: {r.error}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0 }}>
        {/* ── Project sidebar ── */}
        <div style={{ width: 270, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            className="filter-input"
            placeholder="Search projects…"
            value={projectSearch}
            onChange={(e) => setProjectSearch(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => setOnlyWithNotes(v => !v)}
              className={`badge ${onlyWithNotes ? 'badge-blue' : 'badge-gray'}`}
              style={{ cursor: 'pointer', border: 'none', opacity: onlyWithNotes ? 1 : 0.55 }}
            >
              Has notes
            </button>
          </div>

          <div className="card" style={{ padding: 0, overflow: 'hidden auto', flex: 1 }}>
            {filteredProjects.length === 0
              ? <div style={{ padding: '16px', color: 'var(--text2)', fontSize: 13 }}>No matches</div>
              : filteredProjects.map(p => {
                const noteCount = counts[p.id]?.notes ?? 0;
                const isSelected = p.id === effectiveProjectId;
                return (
                  <button
                    key={p.id}
                    onClick={() => setSelectedProjectId(p.id)}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '12px 16px',
                      background: isSelected ? 'var(--bg3)' : 'transparent',
                      border: 'none', borderBottom: '1px solid var(--border)',
                      cursor: 'pointer', color: 'var(--text)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</span>
                      {noteCount > 0 && (
                        <span className="badge badge-gray" style={{ fontSize: 11 }}>
                          {noteCount}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.path}
                    </div>
                  </button>
                );
              })
            }
          </div>
        </div>

        {/* ── Note list + detail ── */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', gap: 16, minHeight: 0 }}>
          {/* Note list */}
          <div style={{ width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="filter-input"
                style={{ flex: 1 }}
                placeholder="Filter notes…"
                value={noteFilter}
                onChange={(e) => setNoteFilter(e.target.value)}
              />
              <button
                onClick={openNew}
                style={{
                  background: 'var(--accent)', color: '#fff', border: 'none',
                  borderRadius: 6, padding: '6px 12px', cursor: 'pointer',
                  fontWeight: 700, fontSize: 15, lineHeight: 1,
                }}
                title="Add note"
              >
                +
              </button>
            </div>

            <div className="card" style={{ padding: 0, overflow: 'hidden auto', flex: 1 }}>
              {notesLoading ? (
                <div style={{ padding: '16px', color: 'var(--text2)', fontSize: 13 }}>Loading…</div>
              ) : filteredNotes.length === 0 ? (
                <div style={{ padding: '16px', color: 'var(--text2)', fontSize: 13 }}>
                  {noteFilter ? 'No matches' : selectedProject ? `No notes for ${selectedProject.name}` : 'Select a project'}
                </div>
              ) : (
                filteredNotes.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => { setSelectedNote(n); setEditing(false); }}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '12px 16px',
                      background: selectedNote?.id === n.id ? 'var(--bg3)' : 'transparent',
                      border: 'none', borderBottom: '1px solid var(--border)',
                      cursor: 'pointer', color: 'var(--text)',
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{n.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {n.content.slice(0, 80)}
                    </div>
                    {n.tags.length > 0 && (
                      <div style={{ marginTop: 5, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {n.tags.map((t) => (
                          <span key={t} className="badge badge-gray">{t}</span>
                        ))}
                      </div>
                    )}
                    <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text2)' }}>
                      {new Date(n.updatedAt).toLocaleDateString()}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Note detail / editor */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {editing ? (
              <div className="card stacked">
                <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>
                  {selectedNote ? 'Edit note' : 'New note'}
                </div>

                <label style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 2 }}>Title</label>
                <input
                  className="filter-input"
                  style={{ width: '100%' }}
                  placeholder="Note title…"
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                />

                <label style={{ fontSize: 12, color: 'var(--text2)', marginTop: 8, marginBottom: 2 }}>Content</label>
                <textarea
                  value={form.content}
                  onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
                  placeholder="Write your note in plain text or markdown…"
                  style={{
                    width: '100%', minHeight: 320,
                    background: 'var(--bg2)', border: '1px solid var(--border)',
                    borderRadius: 6, color: 'var(--text)', padding: '8px 12px',
                    fontSize: 13, fontFamily: 'var(--mono)', resize: 'vertical',
                  }}
                />

                <label style={{ fontSize: 12, color: 'var(--text2)', marginTop: 8, marginBottom: 2 }}>
                  Tags (comma-separated)
                </label>
                <input
                  className="filter-input"
                  style={{ width: '100%' }}
                  placeholder="ai, context, architecture"
                  value={form.tags}
                  onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
                />

                {saveError && <div className="error-banner" style={{ marginTop: 8 }}>{saveError}</div>}

                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    style={{
                      background: 'var(--accent)', color: '#fff', border: 'none',
                      borderRadius: 6, padding: '7px 16px',
                      cursor: saving ? 'not-allowed' : 'pointer',
                      fontWeight: 600, opacity: saving ? 0.7 : 1, fontSize: 13,
                    }}
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    onClick={() => setEditing(false)}
                    style={{
                      background: 'var(--bg3)', color: 'var(--text)',
                      border: '1px solid var(--border)', borderRadius: 6,
                      padding: '7px 16px', cursor: 'pointer', fontSize: 13,
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : selectedNote ? (
              <div className="card stacked">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.3 }}>{selectedNote.title}</div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button
                      onClick={() => openEdit(selectedNote)}
                      style={{
                        background: 'var(--bg3)', color: 'var(--text)',
                        border: '1px solid var(--border)', borderRadius: 6,
                        padding: '5px 12px', cursor: 'pointer', fontSize: 12,
                      }}
                    >
                      Edit
                    </button>
                    {deleteConfirm === selectedNote.id ? (
                      <>
                        <button
                          onClick={() => handleDelete(selectedNote.id)}
                          style={{ background: 'var(--red)', color: '#fff', border: 'none', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 12 }}
                        >
                          Confirm delete
                        </button>
                        <button
                          onClick={() => setDeleteConfirm(null)}
                          style={{ background: 'var(--bg3)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 12 }}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setDeleteConfirm(selectedNote.id)}
                        style={{ background: 'var(--bg3)', color: 'var(--red, #f56565)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontSize: 12 }}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>

                {selectedNote.tags.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                    {selectedNote.tags.map((t) => (
                      <span key={t} className="badge badge-gray">{t}</span>
                    ))}
                  </div>
                )}

                <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 4 }}>
                  Updated {new Date(selectedNote.updatedAt).toLocaleString()}
                </div>

                <pre
                  style={{
                    marginTop: 16, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    fontFamily: 'var(--mono)', fontSize: 13, lineHeight: 1.6,
                    color: 'var(--text)', background: 'var(--bg2)',
                    border: '1px solid var(--border)', borderRadius: 6, padding: '12px 16px',
                  }}
                >
                  {selectedNote.content}
                </pre>
              </div>
            ) : (
              <div className="empty">
                <p>Select a note, or click <strong>+</strong> to create one.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
