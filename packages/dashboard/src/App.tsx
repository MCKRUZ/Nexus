import { NavLink, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Overview } from './pages/Overview.js';
import { Projects } from './pages/Projects.js';
import { DecisionGraph } from './pages/DecisionGraph.js';
import { Patterns } from './pages/Patterns.js';
import { Conflicts } from './pages/Conflicts.js';
import { Preferences } from './pages/Preferences.js';
import { Search } from './pages/Search.js';

function useServerStatus() {
  const [online, setOnline] = useState(false);

  useEffect(() => {
    let mounted = true;
    const check = () =>
      fetch('/health')
        .then(r => r.ok)
        .catch(() => false)
        .then(ok => { if (mounted) setOnline(ok); });

    check();
    const timer = setInterval(check, 10_000);
    return () => { mounted = false; clearInterval(timer); };
  }, []);

  return online;
}

export function App() {
  const online = useServerStatus();

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
          <NavLink to="/conflicts" className={({ isActive }) => isActive ? 'active' : ''}>
            <span className="icon">⚡</span> Conflicts
          </NavLink>
          <NavLink to="/preferences" className={({ isActive }) => isActive ? 'active' : ''}>
            <span className="icon">⚙</span> Preferences
          </NavLink>
          <NavLink to="/search" className={({ isActive }) => isActive ? 'active' : ''}>
            <span className="icon">⌕</span> Search
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
          <Route path="/conflicts" element={<PageShell title="Conflicts"><Conflicts /></PageShell>} />
          <Route path="/preferences" element={<PageShell title="Preferences"><Preferences /></PageShell>} />
          <Route path="/search" element={<PageShell title="Search"><Search /></PageShell>} />
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
