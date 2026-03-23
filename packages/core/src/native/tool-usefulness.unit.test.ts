import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseResultMetrics, scoreToolCall, scanSessionToolUsefulness } from './tool-usefulness.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-usefulness-'));
}

function makeJsonlLine(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'user',
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: 'test-session',
    cwd: '/test',
    ...overrides,
  });
}

function makeToolUse(toolName: string, input: Record<string, unknown>, id?: string): string {
  return makeJsonlLine({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: id ?? `toolu_${Math.random().toString(36).slice(2)}`, name: `mcp__nexus-local__${toolName}`, input },
      ],
    },
  });
}

function makeToolResult(toolUseId: string, text: string): string {
  return makeJsonlLine({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text }] },
      ],
    },
  });
}

function makeAssistantText(text: string): string {
  return makeJsonlLine({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  });
}

// ─── parseResultMetrics ──────────────────────────────────────────────────────

describe('parseResultMetrics', () => {
  it('parses nexus_query with results', () => {
    const { count, hasResults } = parseResultMetrics('nexus_query', 'Found 17 results for "SSH":\n\n## Decisions...');
    expect(count).toBe(17);
    expect(hasResults).toBe(true);
  });

  it('parses nexus_query with zero results', () => {
    const { count, hasResults } = parseResultMetrics('nexus_query', 'Found 0 results for "nonexistent"');
    expect(count).toBe(0);
    expect(hasResults).toBe(false);
  });

  it('parses nexus_note set success', () => {
    const { hasResults } = parseResultMetrics('nexus_note', '✓ Note saved for project **Nexus**');
    expect(hasResults).toBe(true);
  });

  it('parses nexus_note search with no results', () => {
    const { hasResults } = parseResultMetrics('nexus_note', 'No notes found matching query');
    expect(hasResults).toBe(false);
  });

  it('parses nexus_decide success', () => {
    const { hasResults } = parseResultMetrics('nexus_decide', '✓ Decision recorded: Use JWT for auth');
    expect(hasResults).toBe(true);
  });

  it('parses nexus_decide error', () => {
    const { hasResults } = parseResultMetrics('nexus_decide', 'Error: project not found');
    expect(hasResults).toBe(false);
  });

  it('parses nexus_check_conflicts as always useful', () => {
    const { hasResults } = parseResultMetrics('nexus_check_conflicts', 'No conflicts detected');
    expect(hasResults).toBe(true);
  });
});

// ─── scoreToolCall ───────────────────────────────────────────────────────────

describe('scoreToolCall', () => {
  function makeDetail(overrides: Partial<Parameters<typeof scoreToolCall>[0]> = {}): Parameters<typeof scoreToolCall>[0] {
    return {
      toolUseId: 'test-id',
      toolName: 'nexus_query',
      input: { query: 'test' },
      resultText: 'Found 5 results for "test":\n\nSome decisions and patterns here',
      resultLength: 200,
      resultCount: 5,
      hasResults: true,
      nextAssistantText: 'Based on the decisions from Nexus, I can see that...',
      positionIndex: 0,
      timestamp: new Date().toISOString(),
      ...overrides,
    };
  }

  it('produces score between 0 and 1', () => {
    const { score } = scoreToolCall(makeDetail(), [makeDetail()]);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('scores higher for results than empty', () => {
    const withResults = scoreToolCall(makeDetail(), [makeDetail()]);
    const withoutResults = scoreToolCall(
      makeDetail({ hasResults: false, resultCount: 0, resultLength: 0, resultText: '' }),
      [makeDetail({ hasResults: false, resultCount: 0, resultLength: 0, resultText: '' })],
    );
    expect(withResults.score).toBeGreaterThan(withoutResults.score);
  });

  it('returns exactly 4 signals', () => {
    const { signals } = scoreToolCall(makeDetail(), [makeDetail()]);
    expect(signals).toHaveLength(4);
    expect(signals.map((s) => s.type)).toEqual([
      'result_content', 'sequential_chain', 'direct_reference', 'result_substance',
    ]);
  });

  it('signal weights sum to 1.0', () => {
    const { signals } = scoreToolCall(makeDetail(), [makeDetail()]);
    const weightSum = signals.reduce((s, sig) => s + sig.weight, 0);
    expect(weightSum).toBeCloseTo(1.0, 5);
  });

  it('scores sequential chain when followed by another nexus call', () => {
    const call1 = makeDetail({ positionIndex: 0 });
    const call2 = makeDetail({ positionIndex: 1 });
    const { signals } = scoreToolCall(call1, [call1, call2]);
    const chain = signals.find((s) => s.type === 'sequential_chain');
    expect(chain!.score).toBe(1.0);
  });

  it('scores 0 for sequential chain when isolated', () => {
    const call = makeDetail({ positionIndex: 0 });
    const { signals } = scoreToolCall(call, [call]);
    const chain = signals.find((s) => s.type === 'sequential_chain');
    expect(chain!.score).toBe(0);
  });
});

// ─── scanSessionToolUsefulness ───────────────────────────────────────────────

describe('scanSessionToolUsefulness', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null for nonexistent file', () => {
    expect(scanSessionToolUsefulness('/nonexistent/file.jsonl')).toBeNull();
  });

  it('returns null for session with no nexus tools', () => {
    const jsonl = [
      makeJsonlLine({ message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] } }),
      makeJsonlLine({ message: { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] } }),
    ].join('\n');
    const filePath = path.join(tmpDir, 'no-nexus.jsonl');
    fs.writeFileSync(filePath, jsonl);

    expect(scanSessionToolUsefulness(filePath)).toBeNull();
  });

  it('scans session with nexus_query returning results', () => {
    const toolId = 'toolu_abc123';
    const jsonl = [
      makeToolUse('nexus_query', { query: 'SSH infrastructure' }, toolId),
      makeToolResult(toolId, 'Found 17 results for "SSH infrastructure":\n\n## Decisions (10)\n- SSH to Mac Mini at 192.168.50.189'),
      makeAssistantText('Based on the Nexus results, I can see the Mac Mini is at 192.168.50.189'),
    ].join('\n');
    const filePath = path.join(tmpDir, 'with-nexus.jsonl');
    fs.writeFileSync(filePath, jsonl);

    const result = scanSessionToolUsefulness(filePath);
    expect(result).not.toBeNull();
    expect(result!.toolCalls).toHaveLength(1);
    expect(result!.toolCalls[0]!.toolName).toBe('nexus_query');
    expect(result!.toolCalls[0]!.usefulnessScore).toBeGreaterThan(0.3);
  });

  it('scores chained nexus calls higher', () => {
    const toolId1 = 'toolu_chain1';
    const toolId2 = 'toolu_chain2';
    const jsonl = [
      makeToolUse('nexus_query', { query: 'Mac mini' }, toolId1),
      makeToolResult(toolId1, 'Found 5 results for "Mac mini":\n\n- Decision: SSH config'),
      makeToolUse('nexus_note', { action: 'search', query: 'infrastructure' }, toolId2),
      makeToolResult(toolId2, '## Mac Mini SSH\nHost: 192.168.50.189'),
      makeAssistantText('I found the SSH details in Nexus'),
    ].join('\n');
    const filePath = path.join(tmpDir, 'chained.jsonl');
    fs.writeFileSync(filePath, jsonl);

    const result = scanSessionToolUsefulness(filePath);
    expect(result).not.toBeNull();
    expect(result!.toolCalls).toHaveLength(2);
    // First call should have sequential chain bonus
    expect(result!.toolCalls[0]!.usefulnessScore).toBeGreaterThan(0.4);
  });

  it('scores empty query results low', () => {
    const toolId = 'toolu_empty';
    const jsonl = [
      makeToolUse('nexus_query', { query: 'nonexistent thing' }, toolId),
      makeToolResult(toolId, 'Found 0 results for "nonexistent thing"'),
      makeAssistantText('I could not find anything in Nexus about that.'),
    ].join('\n');
    const filePath = path.join(tmpDir, 'empty-query.jsonl');
    fs.writeFileSync(filePath, jsonl);

    const result = scanSessionToolUsefulness(filePath);
    expect(result).not.toBeNull();
    expect(result!.toolCalls[0]!.usefulnessScore).toBeLessThan(0.3);
  });
});
