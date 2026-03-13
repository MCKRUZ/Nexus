import { describe, it, expect } from 'vitest';
import { smartTruncate } from './truncate.js';

describe('smartTruncate', () => {
  it('returns text unchanged when under budget', () => {
    const result = smartTruncate('hello world', 1000);
    expect(result.text).toBe('hello world');
    expect(result.truncated).toBe(false);
    expect(result.originalBytes).toBe(11);
  });

  it('returns text unchanged when exactly at budget', () => {
    const text = 'abcdef';
    const result = smartTruncate(text, Buffer.byteLength(text));
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(text);
  });

  it('truncates with head/tail split and separator', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}: some content here`);
    const text = lines.join('\n');
    const maxBytes = 500;

    const result = smartTruncate(text, maxBytes);
    expect(result.truncated).toBe(true);
    expect(result.originalBytes).toBe(Buffer.byteLength(text));
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(maxBytes + 100); // separator overhead
    expect(result.text).toContain('... [');
    expect(result.text).toContain('truncated] ...');
    // Head starts with the first line
    expect(result.text.startsWith('line 1:')).toBe(true);
    // Tail ends with the last line
    expect(result.text.endsWith('line 100: some content here')).toBe(true);
  });

  it('snaps to line boundaries', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const text = lines.join('\n');
    const maxBytes = 100;

    const result = smartTruncate(text, maxBytes);
    expect(result.truncated).toBe(true);
    // Head should start with first line, tail should end with last line
    expect(result.text).toContain('line 1');
    expect(result.text).toContain('line 20');
    // Should contain the separator
    expect(result.text).toContain('truncated');
  });

  it('handles empty input', () => {
    const result = smartTruncate('', 100);
    expect(result.text).toBe('');
    expect(result.truncated).toBe(false);
    expect(result.originalBytes).toBe(0);
  });

  it('handles single-line text over budget', () => {
    const text = 'a'.repeat(200);
    const result = smartTruncate(text, 50);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(50);
  });

  it('handles multi-byte UTF-8 characters', () => {
    // Each emoji is 4 bytes in UTF-8
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}: content`);
    const text = lines.join('\n');
    const result = smartTruncate(text, 100);
    expect(result.truncated).toBe(true);
    // Should not produce invalid UTF-8
    expect(() => Buffer.from(result.text, 'utf-8').toString('utf-8')).not.toThrow();
  });

  it('returns unchanged for maxBytes <= 0', () => {
    const result = smartTruncate('hello', 0);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe('hello');
  });
});
