import { useEffect, useState } from 'react';

// Detect whether we are running inside a Tauri window
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  // Dynamic import so this module is tree-shaken in browser-only builds.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = await import('@tauri-apps/api/core' as any) as { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<T> };
  return m.invoke(cmd, args);
}

export function Settings() {
  const [autostart, setAutostart] = useState(false);
  const [browserAccess, setBrowserAccess] = useState(false);
  const [serverPort] = useState(47340);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri) {
      setLoading(false);
      return;
    }
    Promise.all([
      tauriInvoke<boolean>('is_autostart_enabled').catch(() => false),
      tauriInvoke<boolean>('get_server_bind_all').catch(() => false),
    ]).then(([a, b]) => {
      setAutostart(a);
      setBrowserAccess(b);
      setLoading(false);
    });
  }, []);

  async function handleAutostartToggle(enabled: boolean) {
    if (!isTauri) return;
    setSaving('autostart');
    try {
      await tauriInvoke('toggle_autostart', { enabled });
      setAutostart(enabled);
    } finally {
      setSaving(null);
    }
  }

  async function handleBrowserAccessToggle(bindAll: boolean) {
    if (!isTauri) return;
    setSaving('browser');
    try {
      await tauriInvoke('set_server_mode', { bindAll });
      setBrowserAccess(bindAll);
    } finally {
      setSaving(null);
    }
  }

  if (loading) {
    return <div className="settings-loading">Loading settings…</div>;
  }

  return (
    <div className="settings-page">
      {!isTauri && (
        <div className="settings-banner">
          These settings require the Nexus desktop app. Toggles are read-only in browser mode.
        </div>
      )}

      <section className="settings-section">
        <h2 className="settings-section-title">STARTUP</h2>
        <div className="settings-row">
          <div className="settings-label">
            <span>Launch at login</span>
            <span className="settings-hint">Start Nexus automatically when you log in</span>
          </div>
          <Toggle
            enabled={autostart}
            disabled={!isTauri || saving === 'autostart'}
            onToggle={handleAutostartToggle}
          />
        </div>
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title">SERVER</h2>
        <div className="settings-row">
          <div className="settings-label">
            <span>Enable browser access</span>
            <span className="settings-hint">
              Allow accessing the dashboard from other devices on your network
              (binds to 0.0.0.0 instead of 127.0.0.1)
            </span>
          </div>
          <Toggle
            enabled={browserAccess}
            disabled={!isTauri || saving === 'browser'}
            onToggle={handleBrowserAccessToggle}
          />
        </div>
        <div className="settings-row settings-row--info">
          <span className="settings-label">Dashboard port</span>
          <code className="settings-value">{serverPort}</code>
        </div>
        <div className="settings-row settings-row--info">
          <span className="settings-label">Local URL</span>
          <code className="settings-value">http://localhost:{serverPort}</code>
        </div>
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title">APPEARANCE</h2>
        <div className="settings-row">
          <div className="settings-label">
            <span>Theme</span>
            <span className="settings-hint">Controls the color scheme</span>
          </div>
          <select className="settings-select" disabled>
            <option value="dark">Dark</option>
            <option value="system">System</option>
          </select>
        </div>
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title">ABOUT</h2>
        <div className="settings-row settings-row--info">
          <span className="settings-label">Version</span>
          <code className="settings-value">0.1.0</code>
        </div>
        <div className="settings-row settings-row--info">
          <span className="settings-label">Data directory</span>
          <code className="settings-value">~/.nexus/</code>
        </div>
      </section>
    </div>
  );
}

function Toggle({
  enabled,
  disabled,
  onToggle,
}: {
  enabled: boolean;
  disabled: boolean;
  onToggle: (val: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={enabled}
      disabled={disabled}
      className={`toggle${enabled ? ' toggle--on' : ''}${disabled ? ' toggle--disabled' : ''}`}
      onClick={() => !disabled && onToggle(!enabled)}
    >
      <span className="toggle-thumb" />
    </button>
  );
}
