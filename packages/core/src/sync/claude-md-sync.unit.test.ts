import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { syncClaudeMd, removeNexusSection } from './claude-md-sync.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-'));
}

const EMPTY_INPUT = {
  notes: [],
  relatedProjectNotes: [],
  decisions: [],
  patterns: [],
  preferences: [],
  conflicts: [],
  relatedProjects: [],
};

describe('syncClaudeMd', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates CLAUDE.md when it does not exist', () => {
    const result = syncClaudeMd({ ...EMPTY_INPUT, projectPath: tmpDir });

    expect(result.updated).toBe(true);
    expect(fs.existsSync(result.claudeMdPath)).toBe(true);
  });

  it('includes nexus:start and nexus:end markers', () => {
    const result = syncClaudeMd({ ...EMPTY_INPUT, projectPath: tmpDir });
    const content = fs.readFileSync(result.claudeMdPath, 'utf8');

    expect(content).toContain('<!-- nexus:start -->');
    expect(content).toContain('<!-- nexus:end -->');
  });

  it('renders decisions in the section', () => {
    const result = syncClaudeMd({
      ...EMPTY_INPUT,
      projectPath: tmpDir,
      decisions: [
        {
          id: 'abc',
          projectId: 'proj1',
          kind: 'architecture',
          summary: 'Use microservices',
          recordedAt: Date.now(),
        },
      ],
    });

    const content = fs.readFileSync(result.claudeMdPath, 'utf8');
    expect(content).toContain('Use microservices');
    expect(content).toContain('[architecture]');
  });

  it('does not update when content is identical', () => {
    // First sync
    syncClaudeMd({ ...EMPTY_INPUT, projectPath: tmpDir });

    // Second sync with same data
    const result2 = syncClaudeMd({ ...EMPTY_INPUT, projectPath: tmpDir });
    expect(result2.updated).toBe(false);
  });

  it('updates only the nexus section, leaving other content untouched', () => {
    const existingContent = '# My Project\n\nSome important docs.\n\n';
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), existingContent, 'utf8');

    syncClaudeMd({ ...EMPTY_INPUT, projectPath: tmpDir });

    const content = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
    expect(content).toContain('# My Project');
    expect(content).toContain('Some important docs.');
    expect(content).toContain('<!-- nexus:start -->');
  });

  it('renders notes from related projects under their own heading', () => {
    const result = syncClaudeMd({
      ...EMPTY_INPUT,
      projectPath: tmpDir,
      relatedProjectNotes: [
        {
          projectName: 'Sage',
          notes: [
            {
              id: 'n1',
              projectId: 'sage-id',
              title: 'Sage Overview',
              content: 'Sage is a voice AI companion.',
              tags: ['context'],
              createdAt: Date.now(),
              updatedAt: Date.now(),
              source: 'mcp',
            },
          ],
        },
      ],
    });

    const content = fs.readFileSync(result.claudeMdPath, 'utf8');
    expect(content).toContain('### Context from Sage');
    expect(content).toContain('#### Sage Overview');
    expect(content).toContain('Sage is a voice AI companion.');
  });

  it('updates existing nexus section when decisions change', () => {
    // Initial sync
    syncClaudeMd({ ...EMPTY_INPUT, projectPath: tmpDir });

    // Second sync with a decision
    const result = syncClaudeMd({
      ...EMPTY_INPUT,
      projectPath: tmpDir,
      decisions: [
        {
          id: 'def',
          projectId: 'proj1',
          kind: 'library',
          summary: 'Use Zod for validation',
          recordedAt: Date.now(),
        },
      ],
    });

    expect(result.updated).toBe(true);
    const content = fs.readFileSync(result.claudeMdPath, 'utf8');
    expect(content).toContain('Use Zod for validation');

    // Should only have one nexus section
    const startCount = (content.match(/<!-- nexus:start -->/g) ?? []).length;
    expect(startCount).toBe(1);
  });
});

describe('token budget enforcement', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('truncates decision summaries longer than 80 chars', () => {
    const longSummary = 'A'.repeat(120);
    const result = syncClaudeMd({
      ...EMPTY_INPUT,
      projectPath: tmpDir,
      decisions: [
        { id: 'd1', projectId: 'p1', kind: 'architecture', summary: longSummary, recordedAt: Date.now() },
      ],
    });

    const content = fs.readFileSync(result.claudeMdPath, 'utf8');
    // The full 120-char summary must NOT appear verbatim
    expect(content).not.toContain(longSummary);
    // A truncated version ending with ellipsis must appear
    expect(content).toContain('A'.repeat(79) + '…');
  });

  it('truncates own note content to 150 chars', () => {
    const longContent = 'B'.repeat(300);
    const result = syncClaudeMd({
      ...EMPTY_INPUT,
      projectPath: tmpDir,
      notes: [
        { id: 'n1', projectId: 'p1', title: 'Big Note', content: longContent, tags: [], createdAt: Date.now(), updatedAt: Date.now(), source: 'mcp' },
      ],
    });

    const content = fs.readFileSync(result.claudeMdPath, 'utf8');
    expect(content).not.toContain(longContent);
    expect(content).toContain('B'.repeat(149) + '…');
  });

  it('truncates cross-project note content to 80 chars', () => {
    const longContent = 'C'.repeat(200);
    const result = syncClaudeMd({
      ...EMPTY_INPUT,
      projectPath: tmpDir,
      relatedProjectNotes: [
        {
          projectName: 'OtherProject',
          notes: [
            { id: 'n2', projectId: 'p2', title: 'Cross Note', content: longContent, tags: [], createdAt: Date.now(), updatedAt: Date.now(), source: 'mcp' },
          ],
        },
      ],
    });

    const content = fs.readFileSync(result.claudeMdPath, 'utf8');
    expect(content).not.toContain(longContent);
    expect(content).toContain('C'.repeat(79) + '…');
  });

  it('keeps total Nexus section under 6000 chars with many decisions and notes', () => {
    const manyDecisions = Array.from({ length: 20 }, (_, i) => ({
      id: `d${i}`,
      projectId: 'p1',
      kind: 'architecture' as const,
      summary: `Decision number ${i} — ${'x'.repeat(100)}`,
      recordedAt: Date.now(),
    }));
    const manyNotes = Array.from({ length: 10 }, (_, i) => ({
      id: `n${i}`,
      projectId: 'p1',
      title: `Note ${i}`,
      content: 'N'.repeat(500),
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      source: 'mcp' as const,
    }));

    const result = syncClaudeMd({
      ...EMPTY_INPUT,
      projectPath: tmpDir,
      decisions: manyDecisions,
      notes: manyNotes,
    });

    const content = fs.readFileSync(result.claudeMdPath, 'utf8');
    const nexusStart = content.indexOf('<!-- nexus:start -->');
    const nexusEnd = content.indexOf('<!-- nexus:end -->') + '<!-- nexus:end -->'.length;
    const sectionLength = nexusEnd - nexusStart;
    expect(sectionLength).toBeLessThanOrEqual(6000);
  });
});

describe('removeNexusSection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when no CLAUDE.md exists', () => {
    expect(removeNexusSection(tmpDir)).toBe(false);
  });

  it('removes nexus section and leaves rest intact', () => {
    const content = '# Project\n\nDocs here.\n\n<!-- nexus:start -->\n## Nexus Intelligence\n<!-- nexus:end -->\n';
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), content, 'utf8');

    const result = removeNexusSection(tmpDir);
    expect(result).toBe(true);

    const remaining = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
    expect(remaining).toContain('# Project');
    expect(remaining).not.toContain('<!-- nexus:start -->');
    expect(remaining).not.toContain('Nexus Intelligence');
  });
});
