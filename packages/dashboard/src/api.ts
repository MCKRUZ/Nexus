/** Typed API client for the Nexus server at localhost:47340 */

// In Tauri, the app is loaded via tauri:// protocol, so relative URLs won't
// reach the sidecar server. Use the absolute localhost URL when running as desktop.
const isTauri = '__TAURI_INTERNALS__' in window;
const BASE = isTauri ? 'http://localhost:47340/api' : '/api';

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
  tier: 'advisory' | 'conflict';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  detectedAt: number;
  resolvedAt?: number;
  resolution?: string;
}

export interface Note {
  id: string;
  projectId: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  source: string;
}

export interface Stats {
  projects: number;
  decisions: number;
  patterns: number;
  notes: number;
}

export interface QueryResult {
  decisions: Decision[];
  patterns: Pattern[];
  preferences: Preference[];
}

export interface ConflictCheck {
  hasConflicts: boolean;
  conflicts: Conflict[];
  advisories: Conflict[];
  potentialConflicts: Array<{ topic: string; description: string; projectA: string; projectB: string; summaryA: string; summaryB: string }>;
}

// ─── Native session types ──────────────────────────────────────────────────────

export interface NativeSession {
  sessionId: string;
  jsonlPath: string;
  cwd: string;
  gitBranch?: string;
  slug?: string;
  startedAt: string;
  lastActivityAt: string;
  userTurns: number;
  toolCalls: number;
}

export interface NativeEvent {
  uuid: string;
  parentUuid?: string;
  timestamp: string;
  type: 'user' | 'assistant';
  text?: string;
  toolUse?: { id: string; name: string; input: unknown };
  toolResult?: { toolUseId: string; content: unknown };
}

export interface NativeSessionDetail extends NativeSession {
  events: NativeEvent[];
}

export interface NativeStats {
  totalSessions: number;
  totalUserTurns: number;
  totalToolCalls: number;
  projects: string[];
}

// ─── Langfuse types ────────────────────────────────────────────────────────────

export interface LangfuseDailyMetric {
  date: string;
  countTraces: number;
  countObservations: number;
  totalCost: number;
  usage: Array<{
    model: string;
    inputUsage: number;
    outputUsage: number;
    totalUsage: number;
    countObservations: number;
    countTraces: number;
    totalCost: number;
  }>;
}

export interface LangfuseTrace {
  id: string;
  timestamp: string;
  name?: string;
  sessionId?: string;
  userId?: string;
  tags: string[];
  latency?: number; // seconds
  totalCost?: number;
  scores: Array<{ name: string; value: number }>;
  input?: unknown;
  output?: unknown;
  environment?: string;
}

export interface LangfuseSession {
  id: string;
  createdAt: string;
  projectId: string;
  environment?: string;
}

export interface LangfuseObservation {
  id: string;
  traceId: string;
  type: 'SPAN' | 'GENERATION' | 'EVENT';
  name?: string;
  startTime: string;
  endTime?: string;
  input?: unknown;
  output?: unknown;
  model?: string;
  modelParameters?: Record<string, unknown>;
  metadata?: unknown;
  level?: 'DEFAULT' | 'DEBUG' | 'WARNING' | 'ERROR';
  statusMessage?: string;
  parentObservationId?: string;
  usageDetails?: Record<string, number>;
  costDetails?: Record<string, number>;
  environment?: string;
  version?: string;
}

export interface LangfuseTraceDetail extends LangfuseTrace {
  metadata?: unknown;
  release?: string;
  version?: string;
  bookmarked?: boolean;
  observations: LangfuseObservation[];
}

export interface LangfuseScore {
  id: string;
  timestamp: string;
  traceId: string;
  name: string;
  value: number;
  dataType: 'NUMERIC' | 'BOOLEAN' | 'CATEGORICAL';
}

// ─── Analytics types ──────────────────────────────────────────────────────────

export interface SessionAnalytics {
  totalSessions: number;
  sessionsWithNexus: number;
  sessionsWithoutNexus: number;
  nexusAdoptionRate: number;
  toolUsageCounts: Record<string, number>;
  totalNexusToolCalls: number;
  withNexusAvg: { userTurns: number; toolCalls: number; durationMs: number };
  withoutNexusAvg: { userTurns: number; toolCalls: number; durationMs: number };
  dailyAdoption: Array<{ date: string; withNexus: number; withoutNexus: number }>;
  topNexusSessions: Array<{
    sessionId: string;
    cwd: string;
    nexusToolCalls: number;
    userTurns: number;
    toolCalls: number;
    startedAt: string;
  }>;
}

export interface AuditCountByDay {
  date: string;
  source: string;
  count: number;
}

export interface AuditCountByOperation {
  operation: string;
  count: number;
}

export interface ActivityEvent {
  id: string;
  type: 'decision' | 'pattern';
  projectId: string;
  projectName: string;
  kind?: string;
  name?: string;
  summary?: string;
  description?: string;
  rationale?: string;
  frequency?: number;
  timestamp: number;
}

// ─── Tool usefulness types ───────────────────────────────────────────────────

export interface UsefulnessSignal {
  type: 'result_content' | 'sequential_chain' | 'direct_reference' | 'result_substance';
  score: number;
  weight: number;
  detail?: string;
}

export interface NexusToolCallSummary {
  toolName: string;
  inputPreview: string;
  resultPreview: string;
  usefulnessScore: number;
  signals: UsefulnessSignal[];
  sessionId: string;
  timestamp: string;
}

export interface ToolUsefulnessAggregate {
  toolName: string;
  totalCalls: number;
  avgScore: number;
  emptyResultRate: number;
  followUpRate: number;
  referenceRate: number;
}

export interface ToolUsefulnessAnalytics {
  overallScore: number;
  totalToolCalls: number;
  byTool: ToolUsefulnessAggregate[];
  dailyScores: Array<{ date: string; avgScore: number; calls: number }>;
  topUseful: NexusToolCallSummary[];
  leastUseful: NexusToolCallSummary[];
}

// ─── Token analytics types ───────────────────────────────────────────────────

export interface TokenUsageByModel {
  model: string;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  requestCount: number;
}

export interface SessionTokenUsage {
  sessionId: string;
  cwd: string;
  slug?: string;
  startedAt: string;
  models: TokenUsageByModel[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheWriteTokens: number;
  totalCacheReadTokens: number;
  totalEstimatedCostUsd: number;
  requestCount: number;
  userTurns: number;
  toolCalls: number;
}

export interface TokenAnalytics {
  totalEstimatedCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheWriteTokens: number;
  totalCacheReadTokens: number;
  totalRequests: number;
  byModel: TokenUsageByModel[];
  byDay: Array<{
    date: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    estimatedCostUsd: number;
    requestCount: number;
  }>;
  byProject: Array<{
    project: string;
    cwd: string;
    estimatedCostUsd: number;
    totalTokens: number;
    requestCount: number;
  }>;
  topSessions: SessionTokenUsage[];
  cacheSavingsUsd: number;
  efficiency: EfficiencyMetrics;
}

export interface ProjectEfficiency {
  project: string;
  cwd: string;
  sessions: number;
  avgCostPerSession: number;
  avgCostPerTurn: number;
  avgTokensPerTurn: number;
  avgOutputPerInput: number;
  cacheHitRate: number;
  avgTurnsPerSession: number;
  avgToolCallsPerSession: number;
  totalCost: number;
}

export interface EfficiencyMetrics {
  avgCostPerTurn: number;
  avgTokensPerTurn: number;
  avgOutputPerInput: number;
  cacheHitRate: number;
  avgTurnsPerSession: number;
  avgToolCallsPerSession: number;
  avgCostPerSession: number;
  totalSessions: number;
  totalUserTurns: number;
  totalToolCalls: number;
  byProject: ProjectEfficiency[];
}

// ─── Context overhead types ──────────────────────────────────────────────────

export interface OverheadItem {
  category: string;
  file: string;
  lines: number;
  words: number;
  estimatedTokens: number;
  summary?: string;
}

export interface ProjectOverhead {
  project: string;
  cwd: string;
  items: OverheadItem[];
  totalTokens: number;
  nexusSectionTokens: number;
  nexusSectionPct: number;
  totalSessionLoad: number;
}

export interface HookDetail {
  event: string;
  type: 'command' | 'prompt';
  description: string;
  words: number;
  estimatedTokens: number;
}

export interface SkillDetail {
  name: string;
  hasSkillMd: boolean;
  words: number;
  estimatedTokens: number;
}

export interface OptimizationSuggestion {
  severity: 'high' | 'medium' | 'low';
  category: string;
  title: string;
  description: string;
  currentTokens: number;
  potentialSavings: number;
  target?: string;
}

export interface ContextOverhead {
  globalRules: OverheadItem[];
  globalRulesTotal: number;
  skills: SkillDetail[];
  skillsCount: number;
  skillsEstTokens: number;
  hooks: HookDetail[];
  hookPromptsTotal: number;
  hookCommandsCount: number;
  projects: ProjectOverhead[];
  grandTotal: number;
  suggestions: OptimizationSuggestion[];
}

// ─── Session Token Detail types ──────────────────────────────────────────────

export type MessageSource =
  | 'system_context'
  | 'hook_injection'
  | 'user_message'
  | 'tool_result'
  | 'assistant_text'
  | 'assistant_tool'
  | 'assistant_mixed';

export interface TimelineMessage {
  index: number;
  timestamp: string;
  role: 'user' | 'assistant';
  source: MessageSource;
  summary: string;
  toolNames?: string[];
  tokens?: {
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    costUsd: number;
    cacheHitPct: number;
    inputDelta: number;
  };
  model?: string;
}

export interface SessionTokenDetail {
  sessionId: string;
  cwd: string;
  startedAt: string;
  lastActivityAt: string;
  durationMs: number;
  userTurns: number;
  toolCalls: number;
  timeline: TimelineMessage[];
  sourceBreakdown: Array<{
    source: MessageSource;
    count: number;
    estimatedTokens: number;
    pctOfInput: number;
  }>;
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    costUsd: number;
    cacheSavingsUsd: number;
    cacheHitRate: number;
    hypotheticalCostWithoutCache: number;
  };
  models: Array<{ model: string; requests: number; costUsd: number }>;
}

// ─── Session Tracking types ─────────────────────────────────────────────────

export interface TrackedSession {
  session_id: string;
  project_dir: string | null;
  started_at: number | null;
  last_event: number | null;
  event_count: number;
  compact_count: number;
}

export interface SessionEvent {
  id: number;
  type: string;
  category: string;
  priority: number;
  data: string;
  source: string;
  created_at: number;
}

// ─── Health / Diagnostics types ─────────────────────────────────────────────

export interface DoctorCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
}

export interface ProjectHealth {
  projectId: string;
  projectName: string;
  coverageScore: number;
  lastSyncAge: number | null;
  noteCount: number;
  decisionCount: number;
  patternCount: number;
  gaps: string[];
}

export interface DoctorReport {
  overall: 'healthy' | 'degraded' | 'failing';
  checks: DoctorCheck[];
  projects: ProjectHealth[];
}

export interface DoctorFixResult {
  linkedFamilies: Array<{ rootName: string; children: string[] }>;
  syncedProjects: string[];
  skippedProjects: string[];
}

export interface PipelineStats {
  hookRuns: number;
  hookSkips: number;
  extractionSuccesses: number;
  extractionFailures: number;
  syncSuccesses: number;
  syncFailures: number;
  lastRun: string | null;
  avgExtractedItems: number;
}

// ─── Nexus LLM Cost types ───────────────────────────────────────────────────

export interface LlmCostByDay {
  date: string;
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface LlmCostSummary {
  totalCostUsd: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byDay: LlmCostByDay[];
  byProvider: Array<{ provider: string; model: string; calls: number; costUsd: number }>;
}

// ─── Claude Config types ────────────────────────────────────────────────────

export interface ClaudeConfigRule {
  name: string;
  file: string;
  body: string;
  [key: string]: string;
}

export interface ClaudeConfigSkill {
  name: string;
  file: string;
  isSymlink: boolean;
  body: string;
  [key: string]: string | boolean;
}

export interface ClaudeConfigAgent {
  name: string;
  file: string;
  body: string;
  [key: string]: string;
}

export interface ClaudeConfigCommand {
  name: string;
  file: string;
  body: string;
  [key: string]: string;
}

export interface ClaudeGlobalConfig {
  settings: Record<string, unknown>;
  rules: ClaudeConfigRule[];
  skills: ClaudeConfigSkill[];
  agents: ClaudeConfigAgent[];
  commands: ClaudeConfigCommand[];
  hooks: Record<string, unknown>;
  mcpServers: Record<string, unknown>;
  permissions: { allow: unknown[]; deny: unknown[] };
}

export interface ClaudeProjectConfig {
  project: { id: string; name: string; path: string };
  claudeMd: string | null;
  rules: ClaudeConfigRule[];
  agents: ClaudeConfigAgent[];
  commands: ClaudeConfigCommand[];
  localSettings: Record<string, unknown> | null;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path);
  if (!res.ok) {
    let msg = `GET ${path} → ${res.status}`;
    try {
      const body = await res.json() as { error?: string };
      if (body.error) msg = body.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    throw new Error(`GET ${path} → unexpected content-type: ${ct}`);
  }
  return res.json() as Promise<T>;
}

export interface SyncResult {
  projectId: string;
  projectName: string;
  updated: boolean;
  claudeMdPath: string | null;
  error: string | null;
}

export interface SyncAllResult {
  results: SyncResult[];
  updatedCount: number;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `POST ${path} → ${res.status}`;
    try {
      const errBody = await res.json() as { error?: string };
      if (errBody.error) msg = errBody.error;
    } catch { /* body not JSON */ }
    throw new Error(msg);
  }
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    throw new Error(`POST ${path} → unexpected content-type: ${ct}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  stats: () => get<Stats>('/stats'),
  syncAll: () => post<SyncAllResult>('/sync', {}),
  projects: {
    list: () => get<Project[]>('/projects'),
    get: (id: string) => get<Project>(`/projects/${id}`),
    counts: () => get<Array<{ id: string; decisions: number; patterns: number; notes: number }>>('/projects/counts'),
    decisions: (id: string) => get<Decision[]>(`/projects/${id}/decisions`),
    patterns: (id: string) => get<Pattern[]>(`/projects/${id}/patterns`),
    preferences: (id: string) => get<Preference[]>(`/projects/${id}/preferences`),
    notes: (id: string) => get<Note[]>(`/projects/${id}/notes`),
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
  notes: {
    listForProject: (projectId: string) => get<Note[]>(`/projects/${projectId}/notes`),
    search: (query: string, projectId?: string) =>
      get<Note[]>(
        `/notes/search?q=${encodeURIComponent(query)}` +
          (projectId ? `&projectId=${projectId}` : ''),
      ),
    upsert: (d: { projectId: string; title: string; content: string; tags?: string[] }) =>
      post<Note>('/notes', d),
    delete: (id: string) =>
      fetch(`${BASE}/notes/${id}`, { method: 'DELETE' }).then((r) => {
        if (!r.ok) throw new Error(`DELETE /notes/${id} → ${r.status}`);
        return r.json() as Promise<{ deleted: boolean }>;
      }),
  },
  preferences: {
    list: (projectId?: string) =>
      get<Preference[]>('/preferences' + (projectId ? `?projectId=${projectId}` : '')),
    set: (d: { key: string; value: string; scope: 'global' | 'project'; projectId?: string }) =>
      post<Preference>('/preferences', d),
  },
  conflicts: {
    check: (projectIds?: string[], tier?: 'advisory' | 'conflict') => {
      let url = '/conflicts';
      const params: string[] = [];
      if (projectIds) params.push(`projectIds=${projectIds.join(',')}`);
      if (tier) params.push(`tier=${tier}`);
      if (params.length) url += `?${params.join('&')}`;
      return get<ConflictCheck>(url);
    },
    dismiss: (id: string) =>
      post<{ dismissed: boolean }>(`/conflicts/${id}/dismiss`, {}),
  },
  query: (q: string, projectId?: string) =>
    get<QueryResult>(
      `/query?q=${encodeURIComponent(q)}` + (projectId ? `&projectId=${projectId}` : ''),
    ),
  activity: (limit = 500) => get<ActivityEvent[]>(`/activity?limit=${limit}`),
  analytics: {
    sessions: (sinceDays = 30) =>
      get<SessionAnalytics>(`/analytics/sessions?since=${sinceDays}`),
    auditDaily: (since?: number, until?: number) => {
      let url = '/analytics/audit/daily';
      const params: string[] = [];
      if (since != null) params.push(`since=${since}`);
      if (until != null) params.push(`until=${until}`);
      if (params.length) url += `?${params.join('&')}`;
      return get<AuditCountByDay[]>(url);
    },
    tokens: (sinceDays = 30) =>
      get<TokenAnalytics>(`/analytics/tokens?since=${sinceDays}`),
    contextOverhead: () =>
      get<ContextOverhead>('/analytics/context-overhead'),
    llmCosts: (sinceDays = 30) =>
      get<LlmCostSummary>(`/analytics/llm-costs?since=${sinceDays}d`),
    auditOperations: (since?: number, until?: number) => {
      let url = '/analytics/audit/operations';
      const params: string[] = [];
      if (since != null) params.push(`since=${since}`);
      if (until != null) params.push(`until=${until}`);
      if (params.length) url += `?${params.join('&')}`;
      return get<AuditCountByOperation[]>(url);
    },
    toolUsefulness: (sinceDays = 30) =>
      get<ToolUsefulnessAnalytics>(`/analytics/tool-usefulness?since=${sinceDays}`),
  },
  native: {
    stats: () => get<NativeStats>('/native/stats'),
    sessions: (cwd?: string) =>
      get<NativeSession[]>('/native/sessions' + (cwd ? `?cwd=${encodeURIComponent(cwd)}` : '')),
    session: (encodedPath: string) => get<NativeSessionDetail>(`/native/sessions/${encodedPath}`),
    sessionTokens: (encodedPath: string) => get<SessionTokenDetail>(`/native/session-tokens?path=${encodedPath}`),
  },
  health: {
    doctor: () => get<DoctorReport>('/health/doctor'),
    fix: () => post<DoctorFixResult>('/health/fix', {}),
    pipeline: (sinceDays = 7, projectId?: string) => {
      let url = `/health/pipeline?since=${sinceDays}d`;
      if (projectId) url += `&projectId=${projectId}`;
      return get<PipelineStats>(url);
    },
  },
  sessionTracking: {
    active: () => get<TrackedSession[]>('/sessions/active'),
    events: (sessionId: string, limit = 200) =>
      get<SessionEvent[]>(`/sessions/${encodeURIComponent(sessionId)}/events?limit=${limit}`),
    snapshot: (sessionId: string) =>
      get<{ snapshot: string }>(`/sessions/${encodeURIComponent(sessionId)}/snapshot`),
  },
  claudeConfig: {
    global: () => get<ClaudeGlobalConfig>('/claude-config/global'),
    project: (id: string) => get<ClaudeProjectConfig>(`/claude-config/project/${id}`),
    file: (filePath: string) =>
      get<{ path: string; content: string }>(`/claude-config/file?path=${encodeURIComponent(filePath)}`),
  },
  langfuse: {
    status: () => get<{ configured: boolean }>('/langfuse/status'),
    metrics: (days = 30) =>
      get<{ data: LangfuseDailyMetric[] }>(`/langfuse/metrics/daily?limit=${days}`),
    traces: (
      limit = 50,
      page = 1,
      filters?: { name?: string; userId?: string; sessionId?: string },
    ) => {
      let url = `/langfuse/traces?limit=${Math.min(limit, 100)}&page=${page}`;
      if (filters?.name) url += `&name=${encodeURIComponent(filters.name)}`;
      if (filters?.userId) url += `&userId=${encodeURIComponent(filters.userId)}`;
      if (filters?.sessionId) url += `&sessionId=${encodeURIComponent(filters.sessionId)}`;
      return get<{ data: LangfuseTrace[]; meta: { totalItems: number } }>(url);
    },
    scores: (limit = 100) =>
      get<{ data: LangfuseScore[]; meta: { totalItems: number } }>(`/langfuse/scores?limit=${Math.min(limit, 100)}`),
    sessions: (limit = 50, page = 1) =>
      get<{ data: LangfuseSession[]; meta: { totalItems: number } }>(
        `/langfuse/sessions?limit=${Math.min(limit, 100)}&page=${page}`,
      ),
    traceDetail: (id: string) => get<LangfuseTraceDetail>(`/langfuse/traces/${id}`),
    observations: (
      limit = 50,
      page = 1,
      filters?: { name?: string; type?: string; traceId?: string; userId?: string },
    ) => {
      let url = `/langfuse/observations?limit=${Math.min(limit, 100)}&page=${page}`;
      if (filters?.name) url += `&name=${encodeURIComponent(filters.name)}`;
      if (filters?.type) url += `&type=${encodeURIComponent(filters.type)}`;
      if (filters?.traceId) url += `&traceId=${encodeURIComponent(filters.traceId)}`;
      if (filters?.userId) url += `&userId=${encodeURIComponent(filters.userId)}`;
      return get<{ data: LangfuseObservation[]; meta: { totalItems: number } }>(url);
    },
  },
};
