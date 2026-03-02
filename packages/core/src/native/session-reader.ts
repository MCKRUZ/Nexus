import fs from 'node:fs';
import path from 'node:path';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface NativeSession {
  sessionId: string;
  jsonlPath: string;
  cwd: string;
  gitBranch?: string;
  slug?: string;
  startedAt: string;
  lastActivityAt: string;
  userTurns: number;
  toolCalls: number;
}

export interface NativeEvent {
  uuid: string;
  parentUuid?: string;
  timestamp: string;
  type: 'user' | 'assistant';
  text?: string;
  toolUse?: { id: string; name: string; input: unknown };
  toolResult?: { toolUseId: string; content: unknown };
}

export interface NativeSessionDetail extends NativeSession {
  events: NativeEvent[];
}

export interface NativeStats {
  totalSessions: number;
  totalUserTurns: number;
  totalToolCalls: number;
  projects: string[];
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface RawLine {
  type?: string;
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  slug?: string;
  sessionId?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

// ─── JSONL parsing ────────────────────────────────────────────────────────────

function parseJsonlFile(filePath: string): RawLine[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const result: RawLine[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        result.push(JSON.parse(trimmed) as RawLine);
      } catch {
        // skip malformed lines
      }
    }
    return result;
  } catch {
    return [];
  }
}

interface ProcessedSession {
  sessionId: string;
  cwd: string;
  gitBranch: string | undefined;
  slug: string | undefined;
  startedAt: string;
  lastActivityAt: string;
  userTurns: number;
  toolCalls: number;
  events: NativeEvent[];
}

function processLines(lines: RawLine[]): ProcessedSession {
  const events: NativeEvent[] = [];
  let sessionId = '';
  let cwd = '';
  let gitBranch: string | undefined;
  let slug: string | undefined;
  let startedAt = '';
  let lastActivityAt = '';
  let userTurns = 0;
  let toolCalls = 0;

  for (const line of lines) {
    if (line.type === 'progress') continue;
    if (!line.uuid || !line.timestamp) continue;

    // Extract session metadata from first occurrence
    if (!sessionId && line.sessionId) sessionId = line.sessionId;
    if (!cwd && line.cwd) cwd = line.cwd;
    if (!gitBranch && line.gitBranch) gitBranch = line.gitBranch;
    if (!slug && line.slug) slug = line.slug;
    if (!startedAt) startedAt = line.timestamp;
    lastActivityAt = line.timestamp;

    const role = line.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;

    const content = line.message?.content;
    const contentArr: unknown[] = Array.isArray(content) ? content : [];

    if (role === 'user') {
      const toolResultBlocks = contentArr.filter(
        (b): b is Record<string, unknown> =>
          typeof b === 'object' && b !== null &&
          (b as Record<string, unknown>)['type'] === 'tool_result',
      );

      if (toolResultBlocks.length === 0) {
        // Pure user message — counts as a user turn
        userTurns++;
        const textContent =
          typeof content === 'string'
            ? content
            : contentArr
                .filter(
                  (b): b is Record<string, unknown> =>
                    typeof b === 'object' && b !== null &&
                    (b as Record<string, unknown>)['type'] === 'text',
                )
                .map(b => b['text'] as string)
                .join('\n');
        events.push({
          uuid: line.uuid,
          ...(line.parentUuid ? { parentUuid: line.parentUuid } : {}),
          timestamp: line.timestamp,
          type: 'user',
          ...(textContent ? { text: textContent } : {}),
        });
      } else {
        const block = toolResultBlocks[0]!;
        events.push({
          uuid: line.uuid,
          ...(line.parentUuid ? { parentUuid: line.parentUuid } : {}),
          timestamp: line.timestamp,
          type: 'user',
          toolResult: {
            toolUseId: (block['tool_use_id'] as string) ?? '',
            content: block['content'],
          },
        });
      }
    } else {
      // assistant
      const textBlocks = contentArr
        .filter(
          (b): b is Record<string, unknown> =>
            typeof b === 'object' && b !== null &&
            (b as Record<string, unknown>)['type'] === 'text',
        )
        .map(b => b['text'] as string)
        .join('\n');

      const toolUseBlocks = contentArr.filter(
        (b): b is Record<string, unknown> =>
          typeof b === 'object' && b !== null &&
          (b as Record<string, unknown>)['type'] === 'tool_use',
      );

      toolCalls += toolUseBlocks.length;

      const firstToolUse = toolUseBlocks[0];
      events.push({
        uuid: line.uuid,
        ...(line.parentUuid ? { parentUuid: line.parentUuid } : {}),
        timestamp: line.timestamp,
        type: 'assistant',
        ...(textBlocks ? { text: textBlocks } : {}),
        ...(firstToolUse
          ? {
              toolUse: {
                id: (firstToolUse['id'] as string) ?? '',
                name: (firstToolUse['name'] as string) ?? '',
                input: firstToolUse['input'],
              },
            }
          : {}),
      });
    }
  }

  return { sessionId, cwd, gitBranch, slug, startedAt, lastActivityAt, userTurns, toolCalls, events };
}

// ─── Transcript conversion ────────────────────────────────────────────────────

/**
 * Converts parsed session events into a plain-text transcript suitable for
 * LLM extraction. Tool results are omitted (noisy, may contain secrets).
 */
export function sessionToTranscript(events: NativeEvent[]): string {
  const lines: string[] = [];
  for (const ev of events) {
    const ts = ev.timestamp ? `[${ev.timestamp}] ` : '';
    if (ev.type === 'user' && ev.text) {
      lines.push(`${ts}USER: ${ev.text}`);
    } else if (ev.type === 'assistant') {
      if (ev.text) {
        lines.push(`${ts}ASSISTANT: ${ev.text}`);
      }
      if (ev.toolUse) {
        const input =
          ev.toolUse.input != null
            ? JSON.stringify(ev.toolUse.input).slice(0, 300)
            : '';
        lines.push(`${ts}TOOL: ${ev.toolUse.name}(${input})`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Finds the most recently modified JSONL file in ~/.claude/projects/ whose
 * `cwd` field matches the given project path. Returns the file path or null.
 */
export function findRecentJsonlForProject(
  projectPath: string,
  claudeDir: string,
): string | null {
  const projectsDir = path.join(claudeDir, 'projects');
  if (!fs.existsSync(projectsDir)) return null;

  // Collect all jsonl files sorted by mtime descending
  const allFiles: { file: string; mtime: number }[] = [];
  try {
    for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(projectsDir, entry.name);
      try {
        for (const f of fs.readdirSync(dirPath)) {
          if (!f.endsWith('.jsonl')) continue;
          const fullPath = path.join(dirPath, f);
          try {
            const stat = fs.statSync(fullPath);
            allFiles.push({ file: fullPath, mtime: stat.mtimeMs });
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  } catch {
    return null;
  }

  allFiles.sort((a, b) => b.mtime - a.mtime);

  const normalized = path.normalize(projectPath).toLowerCase();

  // Check the 30 most recent files — read just first few lines for cwd
  for (const { file } of allFiles.slice(0, 30)) {
    try {
      const firstLines = fs.readFileSync(file, 'utf-8').split('\n').slice(0, 10);
      for (const line of firstLines) {
        try {
          const parsed = JSON.parse(line) as { cwd?: string };
          if (parsed.cwd && path.normalize(parsed.cwd).toLowerCase() === normalized) {
            return file;
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* skip unreadable */ }
  }

  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function listSessions(claudeDir: string): Promise<NativeSession[]> {
  const projectsDir = path.join(claudeDir, 'projects');
  if (!fs.existsSync(projectsDir)) return [];

  const sessions: NativeSession[] = [];

  try {
    const projectDirs = fs
      .readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => path.join(projectsDir, d.name));

    for (const projDir of projectDirs) {
      let jsonlFiles: string[];
      try {
        jsonlFiles = fs
          .readdirSync(projDir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => path.join(projDir, f));
      } catch {
        continue;
      }

      for (const jsonlPath of jsonlFiles) {
        const lines = parseJsonlFile(jsonlPath);
        if (lines.length === 0) continue;

        const parsed = processLines(lines);
        if (!parsed.startedAt) continue;

        sessions.push({
          sessionId: parsed.sessionId || path.basename(jsonlPath, '.jsonl'),
          jsonlPath,
          cwd: parsed.cwd,
          ...(parsed.gitBranch ? { gitBranch: parsed.gitBranch } : {}),
          ...(parsed.slug ? { slug: parsed.slug } : {}),
          startedAt: parsed.startedAt,
          lastActivityAt: parsed.lastActivityAt,
          userTurns: parsed.userTurns,
          toolCalls: parsed.toolCalls,
        });
      }
    }
  } catch {
    // return partial results on error
  }

  return sessions.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

export async function getSessionDetail(jsonlPath: string): Promise<NativeSessionDetail> {
  const lines = parseJsonlFile(jsonlPath);
  const parsed = processLines(lines);

  return {
    sessionId: parsed.sessionId || path.basename(jsonlPath, '.jsonl'),
    jsonlPath,
    cwd: parsed.cwd,
    ...(parsed.gitBranch ? { gitBranch: parsed.gitBranch } : {}),
    ...(parsed.slug ? { slug: parsed.slug } : {}),
    startedAt: parsed.startedAt,
    lastActivityAt: parsed.lastActivityAt,
    userTurns: parsed.userTurns,
    toolCalls: parsed.toolCalls,
    events: parsed.events,
  };
}

export async function getNativeStats(claudeDir: string): Promise<NativeStats> {
  const sessions = await listSessions(claudeDir);

  const projects = [
    ...new Set(sessions.map(s => (s.cwd ? path.basename(s.cwd) : '')).filter(Boolean)),
  ];

  return {
    totalSessions: sessions.length,
    totalUserTurns: sessions.reduce((s, sess) => s + sess.userTurns, 0),
    totalToolCalls: sessions.reduce((s, sess) => s + sess.toolCalls, 0),
    projects,
  };
}
