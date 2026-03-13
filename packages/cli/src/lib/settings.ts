import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface HookEntry {
  type: string;
  command: string;
  matcher?: string;
}

interface HookGroup {
  hooks: HookEntry[];
  matcher?: string;
}

type ClaudeSettings = Record<string, unknown>;

export function readClaudeSettings(): ClaudeSettings {
  if (!fs.existsSync(SETTINGS_PATH)) return {};
  return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')) as ClaudeSettings;
}

export function writeClaudeSettings(settings: ClaudeSettings): void {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
}

export function isMcpServerInstalled(name: string): boolean {
  const settings = readClaudeSettings();
  const servers = (settings['mcpServers'] ?? {}) as Record<string, unknown>;
  return name in servers;
}

export function installMcpServer(name: string, config: McpServerConfig): boolean {
  if (isMcpServerInstalled(name)) return false;
  const settings = readClaudeSettings();
  const servers = (settings['mcpServers'] ?? {}) as Record<string, unknown>;
  servers[name] = config;
  settings['mcpServers'] = servers;
  writeClaudeSettings(settings);
  return true;
}

export function isHookInstalled(event: string, pattern: string): boolean {
  const settings = readClaudeSettings();
  const hooks = (settings['hooks'] ?? {}) as Record<string, HookGroup[]>;
  const eventHooks = hooks[event] ?? [];
  return eventHooks.some((group) =>
    (group.hooks ?? []).some((h) => h.command?.includes(pattern)),
  );
}

export function installHook(
  event: string,
  command: string,
  matcher?: string,
): boolean {
  // Check if a hook with a matching command substring already exists
  const pattern = command.includes('nexus-post-tool-use')
    ? 'nexus-post-tool-use'
    : command.includes('nexus-session-start')
      ? 'nexus-session-start'
      : command.includes('hook post-session')
        ? 'hook post-session'
        : command;

  if (isHookInstalled(event, pattern)) return false;

  const settings = readClaudeSettings();
  const hooks = (settings['hooks'] ?? {}) as Record<string, HookGroup[]>;
  const eventHooks = (hooks[event] ?? []) as HookGroup[];

  const entry: HookGroup = {
    hooks: [{ type: 'command', command }],
    ...(matcher ? { matcher } : {}),
  };

  eventHooks.push(entry);
  hooks[event] = eventHooks;
  settings['hooks'] = hooks;
  writeClaudeSettings(settings);
  return true;
}

export function getClaudeSettingsPath(): string {
  return SETTINGS_PATH;
}

export function getClaudeHooksDir(): string {
  return path.join(CLAUDE_DIR, 'hooks');
}
