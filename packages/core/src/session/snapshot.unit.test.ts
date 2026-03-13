import { describe, it, expect } from 'vitest';
import { buildSessionSnapshot } from './snapshot.js';
import type { ClassifiedEvent } from '../types/index.js';

function mkEvent(
  type: ClassifiedEvent['type'],
  category: ClassifiedEvent['category'],
  priority: ClassifiedEvent['priority'],
  data: string,
  source = 'Test',
): ClassifiedEvent {
  return { type, category, priority, data, source };
}

describe('buildSessionSnapshot', () => {
  it('returns empty for no events', () => {
    expect(buildSessionSnapshot([])).toBe('');
  });

  it('includes P1 file events', () => {
    const events: ClassifiedEvent[] = [
      mkEvent('file_read', 'file', 1, '/src/index.ts'),
      mkEvent('file_write', 'file', 1, '/src/new.ts'),
    ];
    const snap = buildSessionSnapshot(events);
    expect(snap).toContain('Session Recovery');
    expect(snap).toContain('/src/index.ts');
    expect(snap).toContain('/src/new.ts');
    expect(snap).toContain('Files touched');
  });

  it('includes P1 task events', () => {
    const events: ClassifiedEvent[] = [
      mkEvent('task_create', 'task', 1, 'Fix the bug'),
    ];
    const snap = buildSessionSnapshot(events);
    expect(snap).toContain('Tasks');
    expect(snap).toContain('Fix the bug');
  });

  it('includes P2 error and git events', () => {
    const events: ClassifiedEvent[] = [
      mkEvent('error', 'error', 2, 'TypeError: foo is not a function'),
      mkEvent('git', 'git', 2, 'git commit'),
    ];
    const snap = buildSessionSnapshot(events);
    expect(snap).toContain('Recent errors');
    expect(snap).toContain('TypeError');
    expect(snap).toContain('Git operations');
    expect(snap).toContain('git commit');
  });

  it('includes P3 tool usage', () => {
    const events: ClassifiedEvent[] = [
      mkEvent('mcp_tool', 'tool', 3, 'nexus_query', 'mcp__nexus__query'),
      mkEvent('mcp_tool', 'tool', 3, 'nexus_query', 'mcp__nexus__query'),
      mkEvent('subagent', 'subagent', 3, 'explore codebase', 'Agent'),
    ];
    const snap = buildSessionSnapshot(events);
    expect(snap).toContain('Tool Usage');
    expect(snap).toContain('mcp__nexus__query: 2x');
    expect(snap).toContain('Subagents used');
  });

  it('deduplicates files', () => {
    const events: ClassifiedEvent[] = [
      mkEvent('file_read', 'file', 1, '/src/index.ts'),
      mkEvent('file_read', 'file', 1, '/src/index.ts'),
      mkEvent('file_read', 'file', 1, '/src/other.ts'),
    ];
    const snap = buildSessionSnapshot(events);
    // Should only appear once
    const matches = snap.match(/\/src\/index\.ts/g);
    expect(matches).toHaveLength(1);
  });

  it('respects maxBytes budget by dropping P3 first', () => {
    const events: ClassifiedEvent[] = [
      mkEvent('file_read', 'file', 1, '/src/index.ts'),
      mkEvent('error', 'error', 2, 'some error'),
      mkEvent('mcp_tool', 'tool', 3, 'some_tool', 'SomeTool'),
    ];
    // Very tight budget
    const snap = buildSessionSnapshot(events, 200);
    expect(snap).toContain('Session Recovery');
    // Should still have P1 content
    expect(snap).toContain('/src/index.ts');
  });

  it('handles mixed priorities', () => {
    const events: ClassifiedEvent[] = [
      mkEvent('file_read', 'file', 1, '/a.ts'),
      mkEvent('git', 'git', 2, 'git push'),
      mkEvent('subagent', 'subagent', 3, 'test runner'),
      mkEvent('task_create', 'task', 1, 'Deploy app'),
      mkEvent('error', 'error', 2, 'build failed'),
    ];
    const snap = buildSessionSnapshot(events, 4096);
    expect(snap).toContain('/a.ts');
    expect(snap).toContain('Deploy app');
    expect(snap).toContain('git push');
    expect(snap).toContain('build failed');
    expect(snap).toContain('test runner');
  });
});
