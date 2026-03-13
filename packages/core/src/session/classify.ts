/**
 * Pure event classifier for Claude Code tool events.
 *
 * Maps tool invocations to categorized events for session tracking.
 * No DB, no side effects — safe to use in both hooks and Nexus core.
 */

import type { ClassifiedEvent, SessionEventType, SessionEventCategory, SessionEventPriority } from '../types/index.js';
import { smartTruncate } from '../utils/truncate.js';

const MAX_DATA_BYTES = 300;

function truncData(s: string): string {
  return smartTruncate(s, MAX_DATA_BYTES).text;
}

/** Extract a file path from tool input, handling common shapes. */
function extractPath(input: Record<string, unknown>): string {
  return String(input['file_path'] ?? input['path'] ?? input['notebook_path'] ?? '');
}

/** Classify a tool event into zero or more ClassifiedEvents. */
export function classifyToolEvent(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: string,
  isError: boolean,
): ClassifiedEvent[] {
  const events: ClassifiedEvent[] = [];
  const lower = toolName.toLowerCase();

  // File operations
  if (lower === 'read') {
    events.push(mkEvent('file_read', 'file', 1, extractPath(toolInput), toolName));
  } else if (lower === 'write') {
    events.push(mkEvent('file_write', 'file', 1, extractPath(toolInput), toolName));
  } else if (lower === 'edit' || lower === 'multiedit') {
    events.push(mkEvent('file_edit', 'file', 1, extractPath(toolInput), toolName));
  } else if (lower === 'notebookedit') {
    events.push(mkEvent('file_edit', 'file', 1, extractPath(toolInput), toolName));
  }

  // Task operations
  else if (lower === 'taskcreate') {
    const subject = String(toolInput['subject'] ?? '');
    events.push(mkEvent('task_create', 'task', 1, truncData(subject), toolName));
  } else if (lower === 'taskupdate') {
    const status = String(toolInput['status'] ?? '');
    const taskId = String(toolInput['taskId'] ?? '');
    events.push(mkEvent('task_update', 'task', 1, truncData(`#${taskId} -> ${status}`), toolName));
  }

  // Bash — sub-classify
  else if (lower === 'bash') {
    const cmd = String(toolInput['command'] ?? '');
    classifyBash(cmd, toolOutput, isError, events);
  }

  // Agent / Skill
  else if (lower === 'agent' || lower === 'skill') {
    const desc = String(toolInput['description'] ?? toolInput['skill'] ?? '');
    events.push(mkEvent('subagent', 'subagent', 3, truncData(desc), toolName));
  }

  // MCP tools (anything with __ separator like mcp__server__tool)
  else if (toolName.includes('__')) {
    events.push(mkEvent('mcp_tool', 'tool', 3, truncData(toolName), toolName));
  }

  // Error on any tool
  if (isError && events.length === 0) {
    events.push(mkEvent('error', 'error', 2, truncData(toolOutput.slice(0, 300)), toolName));
  } else if (isError) {
    events.push(mkEvent('error', 'error', 2, truncData(toolOutput.slice(0, 300)), toolName));
  }

  return events;
}

function classifyBash(
  cmd: string,
  output: string,
  isError: boolean,
  events: ClassifiedEvent[],
): void {
  const trimmed = cmd.trim();

  // Git commands
  if (/\bgit\b/.test(trimmed)) {
    const subCmd = trimmed.match(/git\s+(\S+)/)?.[1] ?? 'unknown';
    events.push(mkEvent('git', 'git', 2, truncData(`git ${subCmd}`), 'Bash'));
  }

  // cd commands
  else if (/^\s*cd\b/.test(trimmed)) {
    const dir = trimmed.replace(/^\s*cd\s+/, '').replace(/["']/g, '');
    events.push(mkEvent('env', 'env', 2, truncData(`cwd: ${dir}`), 'Bash'));
  }

  // Error exit
  if (isError) {
    events.push(mkEvent('error', 'error', 2, truncData(output.slice(0, 300)), 'Bash'));
  }
}

function mkEvent(
  type: SessionEventType,
  category: SessionEventCategory,
  priority: SessionEventPriority,
  data: string,
  source: string,
): ClassifiedEvent {
  return { type, category, priority, data, source };
}
