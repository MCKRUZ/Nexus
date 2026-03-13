import { describe, it, expect } from 'vitest';
import { classifyToolEvent } from './classify.js';

describe('classifyToolEvent', () => {
  it('classifies Read as file_read with P1', () => {
    const events = classifyToolEvent('Read', { file_path: '/src/index.ts' }, '', false);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('file_read');
    expect(events[0]!.category).toBe('file');
    expect(events[0]!.priority).toBe(1);
    expect(events[0]!.data).toBe('/src/index.ts');
  });

  it('classifies Write as file_write with P1', () => {
    const events = classifyToolEvent('Write', { file_path: '/src/new.ts' }, '', false);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('file_write');
    expect(events[0]!.priority).toBe(1);
  });

  it('classifies Edit as file_edit', () => {
    const events = classifyToolEvent('Edit', { file_path: '/src/foo.ts' }, '', false);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('file_edit');
  });

  it('classifies TaskCreate with subject', () => {
    const events = classifyToolEvent('TaskCreate', { subject: 'Fix the bug' }, '', false);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('task_create');
    expect(events[0]!.category).toBe('task');
    expect(events[0]!.data).toBe('Fix the bug');
  });

  it('classifies TaskUpdate with status', () => {
    const events = classifyToolEvent('TaskUpdate', { taskId: '1', status: 'completed' }, '', false);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('task_update');
    expect(events[0]!.data).toBe('#1 -> completed');
  });

  it('classifies Bash + git as git event', () => {
    const events = classifyToolEvent('Bash', { command: 'git status' }, '', false);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('git');
    expect(events[0]!.category).toBe('git');
    expect(events[0]!.priority).toBe(2);
  });

  it('classifies Bash + cd as env event', () => {
    const events = classifyToolEvent('Bash', { command: 'cd /src' }, '', false);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('env');
    expect(events[0]!.data).toBe('cwd: /src');
  });

  it('classifies Bash errors', () => {
    const events = classifyToolEvent('Bash', { command: 'npm test' }, 'Error: test failed', true);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.some((e) => e.category === 'error')).toBe(true);
  });

  it('classifies Agent as subagent with P3', () => {
    const events = classifyToolEvent('Agent', { description: 'research codebase' }, '', false);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('subagent');
    expect(events[0]!.priority).toBe(3);
  });

  it('classifies MCP tools (double underscore) as mcp_tool', () => {
    const events = classifyToolEvent('mcp__nexus__query', {}, '', false);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('mcp_tool');
    expect(events[0]!.category).toBe('tool');
  });

  it('adds error event when tool has error and no other events', () => {
    const events = classifyToolEvent('UnknownTool', {}, 'something broke', true);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('error');
  });

  it('truncates data for long tool output', () => {
    const longSubject = 'x'.repeat(500);
    const events = classifyToolEvent('TaskCreate', { subject: longSubject }, '', false);
    // smartTruncate caps at 300 bytes (may add separator for multi-line, but single line just cuts)
    expect(events[0]!.data.length).toBeLessThanOrEqual(300);
  });
});
