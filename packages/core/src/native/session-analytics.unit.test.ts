import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { scanSessionForNexusTools, computeSessionAnalytics } from './session-analytics.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-'));
}

function writeJsonl(dir: string, filename: string, lines: object[]): string {
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n'));
  return filePath;
}

function makeAssistantToolUse(uuid: string, ts: string, toolName: string) {
  return {
    uuid,
    timestamp: ts,
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'thinking...' },
        { type: 'tool_use', id: `tu_${uuid}`, name: toolName, input: {} },
      ],
    },
  };
}

function makeUserTurn(uuid: string, ts: string, text: string) {
  return {
    uuid,
    timestamp: ts,
    sessionId: 'test-session',
    cwd: '/test/project',
    message: { role: 'user', content: text },
  };
}

function makeToolResult(uuid: string, ts: string, toolUseId: string) {
  return {
    uuid,
    timestamp: ts,
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content: 'result' },
      ],
    },
  };
}

describe('scanSessionForNexusTools', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects nexus tool calls in MCP format', () => {
    const jsonlPath = writeJsonl(tmpDir, 'session.jsonl', [
      makeUserTurn('u1', '2026-03-09T10:00:00Z', 'query nexus'),
      makeAssistantToolUse('a1', '2026-03-09T10:00:01Z', 'mcp__nexus-local__nexus_query'),
      makeToolResult('u2', '2026-03-09T10:00:02Z', 'tu_a1'),
      makeAssistantToolUse('a2', '2026-03-09T10:00:03Z', 'mcp__nexus-local__nexus_decide'),
      makeToolResult('u3', '2026-03-09T10:00:04Z', 'tu_a2'),
      makeAssistantToolUse('a3', '2026-03-09T10:00:05Z', 'Read'),
    ]);

    const result = scanSessionForNexusTools(jsonlPath);
    expect(result).not.toBeNull();
    expect(result!.nexusToolCalls).toBe(2);
    expect(result!.toolCalls).toBe(3);
    expect(result!.toolBreakdown['nexus_query']).toBe(1);
    expect(result!.toolBreakdown['nexus_decide']).toBe(1);
  });

  it('counts user turns correctly (excludes tool results)', () => {
    const jsonlPath = writeJsonl(tmpDir, 'session.jsonl', [
      makeUserTurn('u1', '2026-03-09T10:00:00Z', 'hello'),
      makeAssistantToolUse('a1', '2026-03-09T10:00:01Z', 'Read'),
      makeToolResult('u2', '2026-03-09T10:00:02Z', 'tu_a1'),
      makeUserTurn('u3', '2026-03-09T10:00:05Z', 'thanks'),
    ]);

    const result = scanSessionForNexusTools(jsonlPath);
    expect(result!.userTurns).toBe(2);
  });

  it('returns null for empty/nonexistent files', () => {
    expect(scanSessionForNexusTools('/nonexistent.jsonl')).toBeNull();
  });

  it('handles sessions with no nexus tools', () => {
    const jsonlPath = writeJsonl(tmpDir, 'session.jsonl', [
      makeUserTurn('u1', '2026-03-09T10:00:00Z', 'edit code'),
      makeAssistantToolUse('a1', '2026-03-09T10:00:01Z', 'Edit'),
      makeToolResult('u2', '2026-03-09T10:00:02Z', 'tu_a1'),
    ]);

    const result = scanSessionForNexusTools(jsonlPath);
    expect(result!.nexusToolCalls).toBe(0);
    expect(result!.toolBreakdown).toEqual({});
  });
});

describe('computeSessionAnalytics', () => {
  let tmpDir: string;
  let projectDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
    // Simulate ~/.claude/projects/test-project/ structure
    projectDir = path.join(tmpDir, 'projects', 'C--test-project');
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('computes analytics across multiple sessions', async () => {
    // Session 1: uses nexus
    writeJsonl(projectDir, 'session1.jsonl', [
      makeUserTurn('u1', '2026-03-09T10:00:00Z', 'query'),
      makeAssistantToolUse('a1', '2026-03-09T10:00:01Z', 'mcp__nexus-local__nexus_query'),
      makeToolResult('u2', '2026-03-09T10:00:02Z', 'tu_a1'),
      makeUserTurn('u3', '2026-03-09T10:00:05Z', 'done'),
    ]);

    // Session 2: no nexus
    writeJsonl(projectDir, 'session2.jsonl', [
      makeUserTurn('u1', '2026-03-09T11:00:00Z', 'edit'),
      makeAssistantToolUse('a1', '2026-03-09T11:00:01Z', 'Read'),
      makeToolResult('u2', '2026-03-09T11:00:02Z', 'tu_a1'),
      makeUserTurn('u3', '2026-03-09T11:00:05Z', 'more editing'),
      makeAssistantToolUse('a2', '2026-03-09T11:00:06Z', 'Edit'),
      makeToolResult('u4', '2026-03-09T11:00:07Z', 'tu_a2'),
    ]);

    const analytics = await computeSessionAnalytics(tmpDir);

    expect(analytics.totalSessions).toBe(2);
    expect(analytics.sessionsWithNexus).toBe(1);
    expect(analytics.sessionsWithoutNexus).toBe(1);
    expect(analytics.nexusAdoptionRate).toBe(0.5);
    expect(analytics.totalNexusToolCalls).toBe(1);
    expect(analytics.toolUsageCounts['nexus_query']).toBe(1);
    expect(analytics.topNexusSessions).toHaveLength(1);
    expect(analytics.dailyAdoption).toHaveLength(1);
    expect(analytics.dailyAdoption[0]!.withNexus).toBe(1);
    expect(analytics.dailyAdoption[0]!.withoutNexus).toBe(1);
  });

  it('returns zeros for empty directory', async () => {
    const emptyDir = createTempDir();
    try {
      const analytics = await computeSessionAnalytics(emptyDir);
      expect(analytics.totalSessions).toBe(0);
      expect(analytics.nexusAdoptionRate).toBe(0);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
