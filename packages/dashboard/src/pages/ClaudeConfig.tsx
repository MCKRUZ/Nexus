import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type {
  ClaudeGlobalConfig,
  ClaudeProjectConfig,
  ClaudeConfigRule,
  ClaudeConfigAgent,
  ClaudeConfigCommand,
  ClaudeConfigSkill,
  Project,
} from '../api.js';

type GlobalTab = 'settings' | 'mcp' | 'rules' | 'skills' | 'agents' | 'commands' | 'hooks' | 'permissions';

export function ClaudeConfig() {
  const [view, setView] = useState<'global' | 'project'>('global');
  const [globalTab, setGlobalTab] = useState<GlobalTab>('settings');
  const [globalConfig, setGlobalConfig] = useState<ClaudeGlobalConfig | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [projectConfig, setProjectConfig] = useState<ClaudeProjectConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  const [expandedContent, setExpandedContent] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([api.claudeConfig.global(), api.projects.list()])
      .then(([gc, pl]) => {
        setGlobalConfig(gc);
        setProjects(pl);
        if (pl.length > 0 && !selectedProjectId) setSelectedProjectId(pl[0]!.id);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (view !== 'project' || !selectedProjectId) return;
    setLoading(true);
    api.claudeConfig
      .project(selectedProjectId)
      .then(setProjectConfig)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [view, selectedProjectId]);

  function toggleExpand(key: string, filePath?: string) {
    if (expandedCard === key) {
      setExpandedCard(null);
      setExpandedContent(null);
      return;
    }
    setExpandedCard(key);
    if (filePath) {
      setExpandedContent('Loading…');
      api.claudeConfig
        .file(filePath)
        .then((r) => setExpandedContent(r.content))
        .catch(() => setExpandedContent('Failed to load file'));
    }
  }

  if (loading && !globalConfig) return <div className="loading">Loading Claude config…</div>;
  if (error) return <div className="error-banner">{error}</div>;

  const globalTabs: { key: GlobalTab; label: string }[] = [
    { key: 'settings', label: 'Settings' },
    { key: 'mcp', label: 'MCP Servers' },
    { key: 'rules', label: 'Rules' },
    { key: 'skills', label: 'Skills' },
    { key: 'agents', label: 'Agents' },
    { key: 'commands', label: 'Commands' },
    { key: 'hooks', label: 'Hooks' },
    { key: 'permissions', label: 'Permissions' },
  ];

  return (
    <div className="stacked">
      {/* View toggle */}
      <div className="view-toggle">
        <button
          className={`btn${view === 'global' ? ' btn-primary' : ''}`}
          onClick={() => setView('global')}
        >
          Global
        </button>
        <button
          className={`btn${view === 'project' ? ' btn-primary' : ''}`}
          onClick={() => setView('project')}
        >
          Per-Project
        </button>
      </div>

      {view === 'global' && globalConfig && (
        <>
          <div className="tab-nav">
            {globalTabs.map((t) => (
              <button
                key={t.key}
                className={`tab-btn${globalTab === t.key ? ' active' : ''}`}
                onClick={() => { setGlobalTab(t.key); setFilter(''); }}
              >
                {t.label}
                {t.key === 'rules' && ` (${globalConfig.rules.length})`}
                {t.key === 'skills' && ` (${globalConfig.skills.length})`}
                {t.key === 'agents' && ` (${globalConfig.agents.length})`}
                {t.key === 'commands' && ` (${globalConfig.commands.length})`}
                {t.key === 'mcp' && ` (${Object.keys(globalConfig.mcpServers).length})`}
              </button>
            ))}
          </div>

          {/* Filter for card-heavy tabs */}
          {['rules', 'skills', 'agents', 'commands'].includes(globalTab) && (
            <div style={{ marginTop: 12 }}>
              <input
                className="filter-input"
                placeholder={`Filter ${globalTab}…`}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                style={{ width: 280 }}
              />
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            {globalTab === 'settings' && <SettingsView settings={globalConfig.settings} />}
            {globalTab === 'mcp' && <McpServersView servers={globalConfig.mcpServers} />}
            {globalTab === 'rules' && (
              <CardList items={filterItems(globalConfig.rules, filter)} type="rule" expanded={expandedCard} onToggle={toggleExpand} expandedContent={expandedContent} basePath="~/.claude/rules/" />
            )}
            {globalTab === 'skills' && (
              <SkillsList items={filterItems(globalConfig.skills, filter) as ClaudeConfigSkill[]} expanded={expandedCard} onToggle={toggleExpand} expandedContent={expandedContent} />
            )}
            {globalTab === 'agents' && (
              <CardList items={filterItems(globalConfig.agents, filter)} type="agent" expanded={expandedCard} onToggle={toggleExpand} expandedContent={expandedContent} basePath="~/.claude/" />
            )}
            {globalTab === 'commands' && (
              <CardList items={filterItems(globalConfig.commands, filter)} type="command" expanded={expandedCard} onToggle={toggleExpand} expandedContent={expandedContent} basePath="~/.claude/commands/" />
            )}
            {globalTab === 'hooks' && <HooksView hooks={globalConfig.hooks} />}
            {globalTab === 'permissions' && <PermissionsView permissions={globalConfig.permissions} />}
          </div>
        </>
      )}

      {view === 'project' && (
        <div className="grid-2" style={{ alignItems: 'start' }}>
          <div>
            <div className="section-header"><span className="section-title">Project</span></div>
            <select
              className="filter-input"
              style={{ width: '100%' }}
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div>
            {loading && <div className="loading">Loading…</div>}
            {!loading && projectConfig && <ProjectConfigView config={projectConfig} expanded={expandedCard} onToggle={toggleExpand} expandedContent={expandedContent} />}
          </div>
        </div>
      )}
    </div>
  );
}

function filterItems<T extends { name: string }>(items: T[], filter: string): T[] {
  if (!filter) return items;
  const lower = filter.toLowerCase();
  return items.filter((i) => i.name.toLowerCase().includes(lower));
}

function SettingsView({ settings }: { settings: Record<string, unknown> }) {
  return (
    <div className="card">
      <div className="card-title">settings.json (env values masked)</div>
      <pre className="json-viewer">{JSON.stringify(settings, null, 2)}</pre>
    </div>
  );
}

interface SubServer { namespace: string; name: string; command: string; args: string[] }

function McpServersView({ servers }: { servers: Record<string, unknown> }) {
  const entries = Object.entries(servers);
  if (!entries.length) return <div className="empty">No MCP servers configured</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {entries.map(([name, cfg]) => {
        const c = cfg as Record<string, unknown>;
        const isHub = !!c['isHub'];
        const subServers = (c['subServers'] ?? []) as SubServer[];
        const desc = String(c['description'] ?? '');
        return (
          <div key={name} className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span className="mono" style={{ fontWeight: 600, fontSize: 14 }}>{name}</span>
              {isHub && <span className="badge badge-purple">hub ({subServers.length} servers)</span>}
            </div>
            {desc && <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 8 }}>{desc}</div>}
            <div style={{ fontSize: 12, color: 'var(--text2)' }}>
              <span className="mono">{String(c['command'] ?? '')}</span>{' '}
              <span className="mono" style={{ fontSize: 11 }}>{Array.isArray(c['args']) ? (c['args'] as string[]).join(' ') : ''}</span>
            </div>
            {isHub && subServers.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div className="config-category" style={{ marginBottom: 8 }}>Downstream Servers</div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Namespace</th>
                        <th>Command</th>
                        <th>Args</th>
                      </tr>
                    </thead>
                    <tbody>
                      {subServers.map((s) => (
                        <tr key={s.namespace}>
                          <td><span className="mono" style={{ fontWeight: 500 }}>{s.namespace}_*</span></td>
                          <td className="mono">{s.command}</td>
                          <td className="mono" style={{ fontSize: 11 }}>{s.args.join(' ')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CardList({
  items,
  type,
  expanded,
  onToggle,
  expandedContent,
  basePath,
}: {
  items: (ClaudeConfigRule | ClaudeConfigAgent | ClaudeConfigCommand)[];
  type: string;
  expanded: string | null;
  onToggle: (key: string, path?: string) => void;
  expandedContent: string | null;
  basePath: string;
}) {
  if (!items.length) return <div className="empty">No {type}s found</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((item) => {
        const key = `${type}-${item.name}`;
        const isExpanded = expanded === key;
        return (
          <div key={key} className="config-file-card" onClick={() => onToggle(key, `${basePath}${item.file}`)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="mono" style={{ fontWeight: 600 }}>{item.name}</span>
              <span style={{ fontSize: 11, color: 'var(--text2)' }}>{isExpanded ? 'collapse' : 'expand'}</span>
            </div>
            {item.body && !isExpanded && (
              <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 4, whiteSpace: 'pre-wrap', maxHeight: 60, overflow: 'hidden' }}>
                {item.body}
              </div>
            )}
            {isExpanded && (
              <pre className="json-viewer" style={{ marginTop: 8, maxHeight: 500 }}>
                {expandedContent ?? 'Loading…'}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SkillsList({
  items,
  expanded,
  onToggle,
  expandedContent,
}: {
  items: ClaudeConfigSkill[];
  expanded: string | null;
  onToggle: (key: string, path?: string) => void;
  expandedContent: string | null;
}) {
  if (!items.length) return <div className="empty">No skills found</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((item) => {
        const key = `skill-${item.name}`;
        const isExpanded = expanded === key;
        return (
          <div key={key} className="config-file-card" onClick={() => onToggle(key, `~/.claude/${item.file}`)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <span className="mono" style={{ fontWeight: 600 }}>{item.name}</span>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {item.isSymlink && <span className="badge badge-blue" title="Linked from another location">linked</span>}
                <span style={{ fontSize: 11, color: 'var(--text2)' }}>{isExpanded ? 'collapse' : 'expand'}</span>
              </div>
            </div>
            {item.body && !isExpanded && (
              <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 4, whiteSpace: 'pre-wrap', maxHeight: 60, overflow: 'hidden' }}>
                {item.body}
              </div>
            )}
            {isExpanded && (
              <pre className="json-viewer" style={{ marginTop: 8, maxHeight: 500 }}>
                {expandedContent ?? 'Loading…'}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

function HooksView({ hooks }: { hooks: Record<string, unknown> }) {
  const entries = Object.entries(hooks);
  if (!entries.length) return <div className="empty">No hooks configured</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {entries.map(([event, cfg]) => (
        <div key={event} className="card">
          <div className="card-title">{event}</div>
          <pre className="json-viewer" style={{ maxHeight: 300 }}>{JSON.stringify(cfg, null, 2)}</pre>
        </div>
      ))}
    </div>
  );
}

function PermissionsView({ permissions }: { permissions: { allow: unknown[]; deny: unknown[] } }) {
  return (
    <div className="grid-2">
      <div className="card">
        <div className="card-title">Allowed</div>
        {permissions.allow.length === 0 ? (
          <div className="empty" style={{ padding: 12 }}>None</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
            {permissions.allow.map((p, i) => (
              <span key={i} className="badge badge-green">{String(p)}</span>
            ))}
          </div>
        )}
      </div>
      <div className="card">
        <div className="card-title">Denied</div>
        {permissions.deny.length === 0 ? (
          <div className="empty" style={{ padding: 12 }}>None</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
            {permissions.deny.map((p, i) => (
              <span key={i} className="badge badge-red">{String(p)}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ProjectConfigView({
  config,
  expanded,
  onToggle,
  expandedContent,
}: {
  config: ClaudeProjectConfig;
  expanded: string | null;
  onToggle: (key: string, path?: string) => void;
  expandedContent: string | null;
}) {
  const basePath = config.project.path + '/.claude/';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card">
        <div className="card-title">CLAUDE.md</div>
        {config.claudeMd ? (
          <pre className="json-viewer" style={{ maxHeight: 400 }}>{config.claudeMd}</pre>
        ) : (
          <div className="empty" style={{ padding: 12 }}>No CLAUDE.md</div>
        )}
      </div>

      {config.rules.length > 0 && (
        <>
          <div className="config-category">Rules ({config.rules.length})</div>
          <CardList items={config.rules} type="prule" expanded={expanded} onToggle={onToggle} expandedContent={expandedContent} basePath={basePath + 'rules/'} />
        </>
      )}

      {config.agents.length > 0 && (
        <>
          <div className="config-category">Agents ({config.agents.length})</div>
          <CardList items={config.agents} type="pagent" expanded={expanded} onToggle={onToggle} expandedContent={expandedContent} basePath={basePath + 'agents/'} />
        </>
      )}

      {config.commands.length > 0 && (
        <>
          <div className="config-category">Commands ({config.commands.length})</div>
          <CardList items={config.commands} type="pcmd" expanded={expanded} onToggle={onToggle} expandedContent={expandedContent} basePath={basePath + 'commands/'} />
        </>
      )}

      {config.localSettings && (
        <div className="card">
          <div className="card-title">Local settings.json</div>
          <pre className="json-viewer">{JSON.stringify(config.localSettings, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
