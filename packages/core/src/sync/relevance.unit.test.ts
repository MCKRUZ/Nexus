import { describe, it, expect } from 'vitest';
import { selectRelevantProjects } from './relevance.js';
import type { ProjectCandidate } from './relevance.js';
import type { Note } from '../types/index.js';

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    title: 'Test Note',
    content: 'Some content about this project.',
    tags: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source: 'test',
    ...overrides,
  };
}

function makeCandidate(
  id: string,
  projectName: string,
  notes: Note[],
  tags: string[] = [],
  parentId?: string,
): ProjectCandidate {
  return {
    projectName,
    project: { id, tags, parentId },
    notes,
  };
}

const emptyTarget = {
  project: { id: 'target-id', tags: [] as string[] },
  notes: [] as Note[],
};

describe('selectRelevantProjects', () => {
  it('returns empty when no candidates', () => {
    const result = selectRelevantProjects(emptyTarget, []);
    expect(result).toEqual([]);
  });

  it('always includes parent project regardless of score', () => {
    const parentId = 'parent-id';
    const target = {
      project: { id: 'child-id', parentId, tags: [] as string[] },
      notes: [] as Note[],
    };
    const parentCandidate = makeCandidate(
      parentId,
      'ParentProject',
      [makeNote({ title: 'Unrelated', content: 'XYZ unrelated zzz mmm' })],
    );
    const unrelatedCandidate = makeCandidate(
      'other-id',
      'UnrelatedProject',
      [makeNote({ title: 'Another', content: 'Another unrelated thing xyz' })],
    );
    const result = selectRelevantProjects(target, [parentCandidate, unrelatedCandidate]);
    const names = result.map((r) => r.projectName);
    expect(names).toContain('ParentProject');
  });

  it('always includes child project regardless of score', () => {
    const targetId = 'parent-id';
    const target = {
      project: { id: targetId, tags: [] as string[] },
      notes: [] as Note[],
    };
    const childCandidate = makeCandidate(
      'child-id',
      'ChildProject',
      [makeNote({ title: 'Child note', content: 'XYZ completely different topic zzzz' })],
      [],
      targetId, // parentId points to target
    );
    const result = selectRelevantProjects(target, [childCandidate]);
    expect(result.map((r) => r.projectName)).toContain('ChildProject');
  });

  it('tag overlap boosts score above unrelated project', () => {
    const target = {
      project: { id: 'target-id', tags: ['typescript', 'mckruz-project'] },
      notes: [makeNote({ title: 'TS project', content: 'typescript node project' })],
    };
    const taggedCandidate = makeCandidate(
      'tagged-id',
      'TaggedProject',
      [makeNote({ title: 'Tagged', content: 'typescript project stuff here node' })],
      ['typescript', 'mckruz-project'],
    );
    const untaggedCandidate = makeCandidate(
      'untagged-id',
      'UntaggedProject',
      [makeNote({ title: 'Untagged', content: 'python machine learning training stuff' })],
      ['python'],
    );
    const result = selectRelevantProjects(target, [taggedCandidate, untaggedCandidate], {
      maxProjects: 1,
    });
    // Tagged project should win the single slot
    expect(result[0]?.projectName).toBe('TaggedProject');
  });

  it('excludes zero-score projects', () => {
    const target = {
      project: { id: 'target-id', tags: [] as string[] },
      notes: [makeNote({ title: 'TypeScript API', content: 'typescript rest api endpoint' })],
    };
    // Candidate with completely unrelated content and no tag overlap
    const unrelatedCandidate = makeCandidate(
      'unrelated-id',
      'UnrelatedProject',
      [makeNote({ title: 'ML Training', content: 'kohya lora stable diffusion training epochs batch' })],
      [],
    );
    // Remove all shared terms — target has typescript, api, endpoint; candidate has kohya, lora, etc.
    // BM25 score should be ~0 since no term overlap, and no tag overlap
    // We check by overriding queryTokens to ensure no match
    const emptyTargetLocal = {
      project: { id: 'target-id', tags: [] as string[] },
      notes: [] as Note[],
    };
    const result = selectRelevantProjects(emptyTargetLocal, [unrelatedCandidate]);
    // With no query terms and no tag overlap, score = 0, should be excluded
    expect(result).toHaveLength(0);
  });

  it('respects maxProjects cap', () => {
    const target = {
      project: { id: 'target-id', tags: ['typescript'] },
      notes: [makeNote({ title: 'TS', content: 'typescript node server api' })],
    };
    const candidates: ProjectCandidate[] = Array.from({ length: 6 }, (_, i) =>
      makeCandidate(
        `proj-${i}`,
        `Project${i}`,
        [makeNote({ title: `Note ${i}`, content: `typescript node project ${i} server api endpoint` })],
        ['typescript'],
      ),
    );
    const result = selectRelevantProjects(target, candidates, { maxProjects: 2 });
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it('respects maxChars cap, truncating at project boundary', () => {
    const target = {
      project: { id: 'target-id', tags: ['typescript'] },
      notes: [makeNote({ title: 'TS', content: 'typescript api' })],
    };
    // Each candidate has ~2000 chars of content
    const bigContent = 'typescript '.repeat(200); // ~2200 chars
    const candidates: ProjectCandidate[] = Array.from({ length: 5 }, (_, i) =>
      makeCandidate(
        `proj-${i}`,
        `Project${i}`,
        [makeNote({ content: bigContent })],
        ['typescript'],
      ),
    );
    // Cap at 5000 chars — should fit at most 2 projects (~2200 each)
    const result = selectRelevantProjects(target, candidates, {
      maxChars: 5000,
      maxProjects: 10,
    });
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it('scores tech-keyword-matching project higher than unrelated one', () => {
    const target = {
      project: { id: 'target-id', tags: [] as string[] },
      notes: [
        makeNote({
          title: 'Tauri Desktop App',
          content: 'tauri rust desktop application react typescript webview native shell',
        }),
      ],
    };
    const relatedCandidate = makeCandidate(
      'related-id',
      'RelatedProject',
      [
        makeNote({
          title: 'Tauri Config',
          content: 'tauri desktop application rust native webview configuration',
        }),
      ],
    );
    const unrelatedCandidate = makeCandidate(
      'unrelated-id',
      'UnrelatedProject',
      [
        makeNote({
          title: 'Recipe Blog',
          content: 'cooking recipe ingredients vegetables pasta salad dinner lunch',
        }),
      ],
    );
    const result = selectRelevantProjects(target, [relatedCandidate, unrelatedCandidate], {
      maxProjects: 2,
    });
    const names = result.map((r) => r.projectName);
    // Related should appear and precede unrelated
    expect(names[0]).toBe('RelatedProject');
  });
});
