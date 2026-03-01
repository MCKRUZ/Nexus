/** Typed API client for the Nexus server at localhost:47340 */

const BASE = '/api';

export interface Project {
  id: string;
  name: string;
  path: string;
  registeredAt: number;
  lastSeenAt?: number;
  parentId?: string;
  tags: string[];
}

export interface Decision {
  id: string;
  projectId: string;
  kind: 'architecture' | 'library' | 'pattern' | 'naming' | 'security' | 'other';
  summary: string;
  rationale?: string;
  sessionId?: string;
  recordedAt: number;
  supersededBy?: string;
}

export interface Pattern {
  id: string;
  projectId: string;
  name: string;
  description: string;
  examplePath?: string;
  frequency: number;
  lastSeenAt: number;
}

export interface Preference {
  id: string;
  key: string;
  value: string;
  scope: 'global' | 'project';
  projectId?: string;
  updatedAt: number;
}

export interface Conflict {
  id: string;
  projectIds: string[];
  description: string;
  detectedAt: number;
  resolvedAt?: number;
  resolution?: string;
}

export interface Stats {
  projects: number;
  decisions: number;
  patterns: number;
}

export interface QueryResult {
  decisions: Decision[];
  patterns: Pattern[];
  preferences: Preference[];
}

export interface ConflictCheck {
  hasConflicts: boolean;
  conflicts: Conflict[];
  potentialConflicts: Array<{ topic: string; description: string }>;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  stats: () => get<Stats>('/stats'),
  projects: {
    list: () => get<Project[]>('/projects'),
    get: (id: string) => get<Project>(`/projects/${id}`),
    decisions: (id: string) => get<Decision[]>(`/projects/${id}/decisions`),
    patterns: (id: string) => get<Pattern[]>(`/projects/${id}/patterns`),
    preferences: (id: string) => get<Preference[]>(`/projects/${id}/preferences`),
    dependencies: (id: string, depth = 2) =>
      get<Array<{ from: string; to: string }>>(`/projects/${id}/dependencies?depth=${depth}`),
  },
  decisions: {
    create: (d: {
      projectId: string;
      kind: Decision['kind'];
      summary: string;
      rationale?: string;
    }) => post<Decision>('/decisions', d),
  },
  preferences: {
    list: (projectId?: string) =>
      get<Preference[]>('/preferences' + (projectId ? `?projectId=${projectId}` : '')),
    set: (d: { key: string; value: string; scope: 'global' | 'project'; projectId?: string }) =>
      post<Preference>('/preferences', d),
  },
  conflicts: {
    check: (projectIds?: string[]) =>
      get<ConflictCheck>(
        '/conflicts' + (projectIds ? `?projectIds=${projectIds.join(',')}` : ''),
      ),
  },
  query: (q: string, projectId?: string) =>
    get<QueryResult>(
      `/query?q=${encodeURIComponent(q)}` + (projectId ? `&projectId=${projectId}` : ''),
    ),
};
