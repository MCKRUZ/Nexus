import { NavLink, Routes, Route, Navigate } from 'react-router-dom';

const isTauri = '__TAURI_INTERNALS__' in window;
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { Overview } from './pages/Overview.js';
import { Projects } from './pages/Projects.js';
import { DecisionGraph } from './pages/DecisionGraph.js';
import { Patterns } from './pages/Patterns.js';
import { Notes } from './pages/Notes.js';
import { Conflicts } from './pages/Conflicts.js';
import { Preferences } from './pages/Preferences.js';
import { Search } from './pages/Search.js';
import { Analytics } from './pages/Analytics.js';
import { TokenAudit } from './pages/TokenAudit.js';
import { Observability } from './pages/Observability.js';
import { Settings } from './pages/Settings.js';
import { Health } from './pages/Health.js';
import { Sessions } from './pages/Sessions.js';
import { ClaudeConfig } from './pages/ClaudeConfig.js';

const FAST_POLL_MS = 1_000;
const SLOW_POLL_MS = 10_000;
const TIMEOUT_MS = 8_000;

interface ServerStatus {
  online: boolean;
  timedOut: boolean;
  errorMessage: string | null;
  retry: () => void;
}

function useServerStatus(): ServerStatus {
  const [online, setOnline] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Bump to restart the polling effect
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => {
    setTimedOut(false);
    setErrorMessage(null);
    setOnline(false);
    setAttempt(n => n + 1);
  }, []);

  useEffect(() => {
    let mounted = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const healthUrl = isTauri ? 'http://localhost:47340/health' : '/health';

    const stop = () => {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
    };

    const check = () => {
      if (!mounted || stopped) return;
      fetch(healthUrl)
        .then(r => r.ok)
        .catch(() => false)
        .then(ok => {
          if (!mounted || stopped) return;
          setOnline(!!ok);
          if (ok) {
            // Server came up — cancel deadline, slow-poll from here
            if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
            setTimedOut(false);
            setErrorMessage(null);
            pollTimer = setTimeout(check, SLOW_POLL_MS);
          } else {
            // Still waiting — schedule next fast check (deadline will stop us if needed)
            pollTimer = setTimeout(check, FAST_POLL_MS);
          }
        });
    };

    // Start polling
    check();

    // After TIMEOUT_MS, stop polling and show error
    deadlineTimer = setTimeout(() => {
      if (!mounted) return;
      stop();
      setTimedOut(true);
    }, TIMEOUT_MS);

    return () => {
      mounted = false;
      stop();
    };
  }, [attempt]);

  // Separate effect for Tauri stderr events (doesn't restart on retry)
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | null = null;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<string>('nexus://server-error', event => {
        setErrorMessage(event.payload);
      }).then(fn => { unlisten = fn; });
    });
    return () => { if (unlisten) unlisten(); };
  }, []);

  return { online, timedOut, errorMessage, retry };
}

export function App() {
  const { online, timedOut, errorMessage, retry } = useServerStatus();

  if (!online) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: '16px', color: 'var(--text2)' }}>
        <div style={{ fontSize: '32px' }}>◈</div>
        <div style={{ fontSize: '18px', color: 'var(--text)' }}>Nexus</div>

        {timedOut || errorMessage ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', maxWidth: '360px', textAlign: 'center' }}>
            <div style={{ fontSize: '14px', color: 'var(--danger, #e55)' }}>
              Server failed to start
            </div>
            {errorMessage && (
              <div style={{
                fontSize: '12px',
                fontFamily: 'monospace',
                background: 'var(--surface2, #1a1a2e)',
                padding: '8px 12px',
                borderRadius: '6px',
                color: 'var(--text2)',
                width: '100%',
                wordBreak: 'break-word',
              }}>
                {errorMessage}
              </div>
            )}
            <div style={{ fontSize: '12px', lineHeight: '1.6' }}>
              <div>Possible causes:</div>
              <div style={{ color: 'var(--text3, #888)' }}>
                Port 47340 may be in use<br />
                Run <code style={{ background: 'var(--surface2, #1a1a2e)', padding: '1px 5px', borderRadius: '3px' }}>nexus init</code> if not initialized<br />
                Sidecar binary may be missing
              </div>
            </div>
            <button
              onClick={retry}
              style={{
                marginTop: '4px',
                padding: '6px 20px',
                fontSize: '13px',
                border: '1px solid var(--border, #333)',
                borderRadius: '6px',
                background: 'var(--surface, #111)',
                color: 'var(--text)',
                cursor: 'pointer',
              }}
            >
              Retry
            </button>
          </div>
        ) : (
          <div style={{ fontSize: '13px' }}>Starting server…</div>
        )}
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
          <NavLink to="/analytics" className={({ isActive }) => isActive ? 'active' : ''}>
            <span className="icon">◉</span> Analytics
          </NavLink>
          <NavLink to="/tokens" className={({ isActive }) => isActive ? 'active' : ''}>
            <span className="icon">⊛</span> Token Audit
          </NavLink>
          <NavLink to="/observability" className={({ isActive }) => isActive ? 'active' : ''}>
            <span className="icon">⬡</span> Observability
          </NavLink>
          <NavLink to="/sessions" className={({ isActive }) => isActive ? 'active' : ''}>
            <span className="icon">▶</span> Session Audit
          </NavLink>
          <NavLink to="/health" className={({ isActive }) => isActive ? 'active' : ''}>
            <span className="icon">♥</span> Health
          </NavLink>
          <NavLink to="/claude-config" className={({ isActive }) => isActive ? 'active' : ''}>
            <span className="icon">⊞</span> Claude Config
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
          <Route path="/analytics" element={<PageShell title="Nexus Analytics"><Analytics /></PageShell>} />
          <Route path="/tokens" element={<PageShell title="Token Audit"><TokenAudit /></PageShell>} />
          <Route path="/observability" element={<PageShell title="LLM Observability"><Observability /></PageShell>} />
          <Route path="/sessions" element={<PageShell title="Session Audit"><Sessions /></PageShell>} />
          <Route path="/claude-config" element={<PageShell title="Claude Config"><ClaudeConfig /></PageShell>} />
          <Route path="/health" element={<PageShell title="System Health"><Health /></PageShell>} />
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
