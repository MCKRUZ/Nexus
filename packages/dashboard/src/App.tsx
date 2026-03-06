import { NavLink, Routes, Route, Navigate } from 'react-router-dom';

const isTauri = '__TAURI_INTERNALS__' in window;
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Overview } from './pages/Overview.js';
import { Projects } from './pages/Projects.js';
import { DecisionGraph } from './pages/DecisionGraph.js';
import { Patterns } from './pages/Patterns.js';
import { Notes } from './pages/Notes.js';
import { Conflicts } from './pages/Conflicts.js';
import { Preferences } from './pages/Preferences.js';
import { Search } from './pages/Search.js';
import { Observability } from './pages/Observability.js';
import { Settings } from './pages/Settings.js';

function useServerStatus() {
  const [online, setOnline] = useState(false);

  useEffect(() => {
    let mounted = true;
    const healthUrl = isTauri ? 'http://localhost:47340/health' : '/health';

    const check = () =>
      fetch(healthUrl)
        .then(r => r.ok)
        .catch(() => false)
        .then(ok => { if (mounted) setOnline(ok); });

    // Poll every second until online, then every 10s
    let timer: ReturnType<typeof setInterval>;
    const startPolling = (interval: number) => {
      timer = setInterval(() => {
        check().then(() => {
          // Once online, switch to slow polling
          if (!online) {
            clearInterval(timer);
            startPolling(10_000);
          }
        });
      }, interval);
    };

    check();
    startPolling(1_000);
    return () => { mounted = false; clearInterval(timer); };
  }, []);

  return online;
}

export function App() {
  const online = useServerStatus();

  if (!online) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: '16px', color: 'var(--text2)' }}>
        <div style={{ fontSize: '32px' }}>◈</div>
        <div style={{ fontSize: '18px', color: 'var(--text)' }}>Nexus</div>
        <div style={{ fontSize: '13px' }}>Starting server…</div>
      </div>
    );
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-logo">
          Nexus
          <span>Cross-Project Intelligence</span>
        </div>
        <nav>
          <NavLink to="/overview" className={({ isActive }) => isActive ? 'active' : ''}>
            <span className="icon">◈</span> Overview
          </NavLink>
          <NavLink to="/projects" className={({ isActive }) => isActive ? 'active' : ''}>
            <span className="icon">⬡</span> Projects
          </NavLink>
          <NavLink to="/decisions" className={({ isActive }) => isActive ? 'active' : ''}>
            <span className="icon">◎</span> Decisions
          </NavLink>
          <NavLink to="/patterns" className={({ isActive }) => isActive ? 'active' : ''}>
            <span className="icon">◇</span> Patterns
          </NavLink>
          <NavLink to="/notes" className={({ isActive }) => isActive ? 'active' : ''}>
            <span className="icon">✎</span> Notes
          </NavLink>
          <NavLink to="/conflicts" className={({ isActive }) => isActive ? 'active' : ''}>
            <span className="icon">⚡</span> Conflicts
          </NavLink>
          <NavLink to="/preferences" className={({ isActive }) => isActive ? 'active' : ''}>
            <span className="icon">⚙</span> Preferences
          </NavLink>
          <NavLink to="/search" className={({ isActive }) => isActive ? 'active' : ''}>
            <span className="icon">⌕</span> Search
          </NavLink>
          <NavLink to="/observability" className={({ isActive }) => isActive ? 'active' : ''}>
            <span className="icon">⬡</span> Observability
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => isActive ? 'active' : ''}>
            <span className="icon">⚙</span> Settings
          </NavLink>
        </nav>
        <div className="sidebar-footer">
          <span className={`status-dot${online ? '' : ' offline'}`} />
          {online ? 'Server online' : 'Server offline'}
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/overview" replace />} />
          <Route path="/overview" element={<PageShell title="Overview"><Overview /></PageShell>} />
          <Route path="/projects" element={<PageShell title="Projects"><Projects /></PageShell>} />
          <Route path="/decisions" element={<PageShell title="Decision Graph"><DecisionGraph /></PageShell>} />
          <Route path="/patterns" element={<PageShell title="Patterns"><Patterns /></PageShell>} />
          <Route path="/notes" element={<PageShell title="Notes"><Notes /></PageShell>} />
          <Route path="/conflicts" element={<PageShell title="Conflicts"><Conflicts /></PageShell>} />
          <Route path="/preferences" element={<PageShell title="Preferences"><Preferences /></PageShell>} />
          <Route path="/search" element={<PageShell title="Search"><Search /></PageShell>} />
          <Route path="/observability" element={<PageShell title="LLM Observability"><Observability /></PageShell>} />
          <Route path="/settings" element={<PageShell title="Settings"><Settings /></PageShell>} />
        </Routes>
      </main>
    </div>
  );
}

function PageShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <div className="topbar"><h1>{title}</h1></div>
      <div className="page">{children}</div>
    </>
  );
}
