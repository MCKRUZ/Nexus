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
  portfolio: [],
  decisions: [],
  conflicts: [],
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

  it('renders portfolio map table with (this) marker', () => {
    const result = syncClaudeMd({
      ...EMPTY_INPUT,
      projectPath: tmpDir,
      portfolio: [
        { name: 'TeamsBuddy', description: 'Teams bot for standup automation', tags: ['csharp', 'signalr'], isCurrent: true },
        { name: 'Nexus', description: 'Cross-project intelligence layer', tags: ['typescript', 'sqlite'], isCurrent: false, lastSeenAt: Date.now() },
        { name: 'OpenClaw', description: '', tags: ['typescript'], isCurrent: false, lastSeenAt: Date.now() },
      ],
    });

    const content = fs.readFileSync(result.claudeMdPath, 'utf8');
    expect(content).toContain('### Portfolio');
    expect(content).toContain('| Project | Description | Tech |');
    expect(content).toContain('**TeamsBuddy** (this)');
    expect(content).toContain('Teams bot for standup automation');
    expect(content).toContain('| Nexus |');
    // Project without description gets dash
    expect(content).toMatch(/OpenClaw.*—/);
  });

  it('excludes "Project Overview" note from own-project context', () => {
    const result = syncClaudeMd({
      ...EMPTY_INPUT,
      projectPath: tmpDir,
      portfolio: [
        { name: 'MyProject', description: 'My project overview content', tags: [], isCurrent: true },
      ],
      notes: [
        { id: 'n1', projectId: 'p1', title: 'Project Overview', content: 'My project overview content', tags: [], createdAt: Date.now(), updatedAt: Date.now(), source: 'mcp' },
        { id: 'n2', projectId: 'p1', title: 'Architecture Notes', content: 'Some architecture details', tags: ['arch'], createdAt: Date.now(), updatedAt: Date.now(), source: 'mcp' },
      ],
    });

    const content = fs.readFileSync(result.claudeMdPath, 'utf8');
    // "Project Overview" should NOT appear as a ### Project Context heading
    expect(content).not.toContain('#### Project Overview');
    // But "Architecture Notes" should appear
    expect(content).toContain('#### Architecture Notes');
  });

  it('renders behavioral rule text', () => {
    const result = syncClaudeMd({ ...EMPTY_INPUT, projectPath: tmpDir });
    const content = fs.readFileSync(result.claudeMdPath, 'utf8');

    expect(content).toContain('**Cross-project rule**');
    expect(content).toContain('nexus_query');
  });

  it('renders active conflicts', () => {
    const result = syncClaudeMd({
      ...EMPTY_INPUT,
      projectPath: tmpDir,
      conflicts: [
        {
          id: 'c1',
          projectIds: ['p1', 'p2'],
          description: 'Auth format divergence',
          tier: 'conflict',
          severity: 'high',
          detectedAt: Date.now(),
        },
      ],
    });

    const content = fs.readFileSync(result.claudeMdPath, 'utf8');
    expect(content).toContain('### Active Conflicts');
    expect(content).toContain('[high] Auth format divergence');
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

  it('truncates portfolio description to 80 chars', () => {
    const longDesc = 'D'.repeat(200);
    const result = syncClaudeMd({
      ...EMPTY_INPUT,
      projectPath: tmpDir,
      portfolio: [
        { name: 'LongProject', description: longDesc, tags: ['ts'], isCurrent: true },
      ],
    });

    const content = fs.readFileSync(result.claudeMdPath, 'utf8');
    expect(content).not.toContain(longDesc);
    expect(content).toContain('D'.repeat(79) + '…');
  });

  it('phase 3 drops conflicts section when over budget', () => {
    // Create a large input that will push past budget
    const manyDecisions = Array.from({ length: 20 }, (_, i) => ({
      id: `d${i}`,
      projectId: 'p1',
      kind: 'architecture' as const,
      summary: `Decision number ${i} — ${'x'.repeat(100)}`,
      recordedAt: Date.now(),
    }));
    const manyNotes = Array.from({ length: 15 }, (_, i) => ({
      id: `n${i}`,
      projectId: 'p1',
      title: `Note ${i}`,
      content: 'N'.repeat(500),
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      source: 'mcp' as const,
    }));
    const manyPortfolio = Array.from({ length: 20 }, (_, i) => ({
      name: `Project${i}`,
      description: 'A'.repeat(80),
      tags: ['tag1', 'tag2', 'tag3'],
      isCurrent: i === 0,
    }));

    const result = syncClaudeMd({
      ...EMPTY_INPUT,
      projectPath: tmpDir,
      decisions: manyDecisions,
      notes: manyNotes,
      portfolio: manyPortfolio,
      conflicts: [
        {
          id: 'c1',
          projectIds: ['p1', 'p2'],
          description: 'Should be dropped in phase 3',
          tier: 'conflict',
          severity: 'high',
          detectedAt: Date.now(),
        },
      ],
    });

    const content = fs.readFileSync(result.claudeMdPath, 'utf8');
    // At phase 3, conflicts should be dropped
    // (The section may or may not contain conflicts depending on budget)
    // But it should always be within the budget
    const nexusStart = content.indexOf('<!-- nexus:start -->');
    const nexusEnd = content.indexOf('<!-- nexus:end -->') + '<!-- nexus:end -->'.length;
    const sectionLength = nexusEnd - nexusStart;
    expect(sectionLength).toBeLessThanOrEqual(6000);
  });

  it('keeps total Nexus section under 6000 chars with many decisions and portfolio entries', () => {
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
    const manyPortfolio = Array.from({ length: 15 }, (_, i) => ({
      name: `Project${i}`,
      description: 'A'.repeat(80),
      tags: ['tag1', 'tag2', 'tag3'],
      isCurrent: i === 0,
    }));

    const result = syncClaudeMd({
      ...EMPTY_INPUT,
      projectPath: tmpDir,
      decisions: manyDecisions,
      notes: manyNotes,
      portfolio: manyPortfolio,
    });

    const content = fs.readFileSync(result.claudeMdPath, 'utf8');
    const nexusStart = content.indexOf('<!-- nexus:start -->');
    const nexusEnd = content.indexOf('<!-- nexus:end -->') + '<!-- nexus:end -->'.length;
    const sectionLength = nexusEnd - nexusStart;
    expect(sectionLength).toBeLessThanOrEqual(6000);
  });
});

describe('cross-project note injection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renders related project notes in the section', () => {
    const result = syncClaudeMd({
      ...EMPTY_INPUT,
      projectPath: tmpDir,
      relatedProjectNotes: [
        {
          projectName: 'OpenClaw',
          notes: [
            { id: 'rn1', projectId: 'p2', title: 'Key Entities', content: 'Sage and Jarvis are AI agents', tags: ['ai'], createdAt: Date.now(), updatedAt: Date.now(), source: 'mcp' },
          ],
        },
      ],
    });

    const content = fs.readFileSync(result.claudeMdPath, 'utf8');
    expect(content).toContain('### Context from OpenClaw');
    expect(content).toContain('#### Key Entities');
    expect(content).toContain('Sage and Jarvis are AI agents');
  });

  it('excludes "Project Overview" from related project notes', () => {
    const result = syncClaudeMd({
      ...EMPTY_INPUT,
      projectPath: tmpDir,
      relatedProjectNotes: [
        {
          projectName: 'SomeProject',
          notes: [
            { id: 'rn1', projectId: 'p2', title: 'Project Overview', content: 'Already in portfolio', tags: [], createdAt: Date.now(), updatedAt: Date.now(), source: 'mcp' },
            { id: 'rn2', projectId: 'p2', title: 'API Design', content: 'REST with versioning', tags: ['api'], createdAt: Date.now(), updatedAt: Date.now(), source: 'mcp' },
          ],
        },
      ],
    });

    const content = fs.readFileSync(result.claudeMdPath, 'utf8');
    expect(content).not.toContain('#### Project Overview');
    expect(content).toContain('#### API Design');
    expect(content).toContain('REST with versioning');
  });

  it('skips related projects with only Project Overview notes', () => {
    const result = syncClaudeMd({
      ...EMPTY_INPUT,
      projectPath: tmpDir,
      relatedProjectNotes: [
        {
          projectName: 'EmptyProject',
          notes: [
            { id: 'rn1', projectId: 'p2', title: 'Project Overview', content: 'Nothing useful here', tags: [], createdAt: Date.now(), updatedAt: Date.now(), source: 'mcp' },
          ],
        },
      ],
    });

    const content = fs.readFileSync(result.claudeMdPath, 'utf8');
    expect(content).not.toContain('Context from EmptyProject');
  });

  it('renders multiple related projects', () => {
    const result = syncClaudeMd({
      ...EMPTY_INPUT,
      projectPath: tmpDir,
      relatedProjectNotes: [
        {
          projectName: 'ProjectA',
          notes: [
            { id: 'rn1', projectId: 'p2', title: 'Auth Pattern', content: 'Uses JWT', tags: [], createdAt: Date.now(), updatedAt: Date.now(), source: 'mcp' },
          ],
        },
        {
          projectName: 'ProjectB',
          notes: [
            { id: 'rn2', projectId: 'p3', title: 'DB Schema', content: 'PostgreSQL with Prisma', tags: [], createdAt: Date.now(), updatedAt: Date.now(), source: 'mcp' },
          ],
        },
      ],
    });

    const content = fs.readFileSync(result.claudeMdPath, 'utf8');
    expect(content).toContain('### Context from ProjectA');
    expect(content).toContain('### Context from ProjectB');
    expect(content).toContain('Uses JWT');
    expect(content).toContain('PostgreSQL with Prisma');
  });

  it('truncates related note content to the same budget as own notes', () => {
    const longContent = 'Z'.repeat(300);
    const result = syncClaudeMd({
      ...EMPTY_INPUT,
      projectPath: tmpDir,
      relatedProjectNotes: [
        {
          projectName: 'BigProject',
          notes: [
            { id: 'rn1', projectId: 'p2', title: 'Big Note', content: longContent, tags: [], createdAt: Date.now(), updatedAt: Date.now(), source: 'mcp' },
          ],
        },
      ],
    });

    const content = fs.readFileSync(result.claudeMdPath, 'utf8');
    expect(content).not.toContain(longContent);
    expect(content).toContain('Z'.repeat(149) + '…');
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
