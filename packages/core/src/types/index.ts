import { z } from 'zod';

// ─── Project ────────────────────────────────────────────────────────────────

export const ProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  path: z.string(),
  registeredAt: z.number(), // Unix ms
  lastSeenAt: z.number().optional(),
  parentId: z.string().uuid().optional(), // For cross-project dependency graph
  tags: z.array(z.string()).default([]),
});

export type Project = z.infer<typeof ProjectSchema>;

// ─── Decision ───────────────────────────────────────────────────────────────

export const DecisionKindSchema = z.enum([
  'architecture',
  'library',
  'pattern',
  'naming',
  'security',
  'other',
]);

export type DecisionKind = z.infer<typeof DecisionKindSchema>;

export const DecisionSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  kind: DecisionKindSchema,
  summary: z.string().max(500),
  rationale: z.string().optional(),
  sessionId: z.string().optional(),
  recordedAt: z.number(),
  supersededBy: z.string().uuid().optional(),
});

export type Decision = z.infer<typeof DecisionSchema>;

// ─── Pattern ─────────────────────────────────────────────────────────────────

export const PatternSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string().max(200),
  description: z.string(),
  examplePath: z.string().optional(), // file path reference, not content
  frequency: z.number().default(1),
  lastSeenAt: z.number(),
});

export type Pattern = z.infer<typeof PatternSchema>;

// ─── Conflict ────────────────────────────────────────────────────────────────

export const ConflictTierSchema = z.enum(['advisory', 'conflict']);
export type ConflictTier = z.infer<typeof ConflictTierSchema>;

export const ConflictSeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export type ConflictSeverity = z.infer<typeof ConflictSeveritySchema>;

export const ConflictSchema = z.object({
  id: z.string().uuid(),
  projectIds: z.array(z.string().uuid()).min(2),
  description: z.string(),
  tier: ConflictTierSchema,
  severity: ConflictSeveritySchema,
  detectedAt: z.number(),
  resolvedAt: z.number().optional(),
  resolution: z.string().optional(),
});

export type Conflict = z.infer<typeof ConflictSchema>;

// ─── Preference ───────────────────────────────────────────────────────────────

export const PreferenceSchema = z.object({
  id: z.string().uuid(),
  key: z.string().max(200),
  value: z.string(),
  scope: z.enum(['global', 'project']),
  projectId: z.string().uuid().optional(),
  updatedAt: z.number(),
});

export type Preference = z.infer<typeof PreferenceSchema>;

// ─── Note ─────────────────────────────────────────────────────────────────────

export const NoteSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string().max(500),
  content: z.string().max(50000),
  tags: z.array(z.string()).default([]),
  createdAt: z.number(),
  updatedAt: z.number(),
  source: z.string(),
});

export type Note = z.infer<typeof NoteSchema>;

// ─── Impact Analysis ─────────────────────────────────────────────────────────

export interface ImpactEvidence {
  type: 'decision' | 'note' | 'pattern';
  title: string;
  snippet: string;
  overlap: number;
}

export type ImpactRelationship = 'parent' | 'child' | 'sibling' | 'tag' | 'infrastructure';

export interface AffectedProject {
  projectId: string;
  projectName: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  confidence: number;
  evidence: ImpactEvidence[];
  relationship: ImpactRelationship;
}

export interface ImpactResult {
  affectedProjects: AffectedProject[];
  summary: string;
}

// ─── Session Events (for compaction recovery) ────────────────────────────────

export const SessionEventTypeSchema = z.enum([
  'file_read', 'file_write', 'file_edit',
  'task_create', 'task_update',
  'error', 'git', 'decision', 'env', 'intent', 'rule',
  'mcp_tool', 'subagent',
]);
export type SessionEventType = z.infer<typeof SessionEventTypeSchema>;

export const SessionEventCategorySchema = z.enum([
  'file', 'task', 'error', 'git', 'env', 'decision', 'intent', 'rule', 'tool', 'subagent',
]);
export type SessionEventCategory = z.infer<typeof SessionEventCategorySchema>;

export const SessionEventPrioritySchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type SessionEventPriority = z.infer<typeof SessionEventPrioritySchema>;

export const ClassifiedEventSchema = z.object({
  type: SessionEventTypeSchema,
  category: SessionEventCategorySchema,
  priority: SessionEventPrioritySchema,
  data: z.string().max(300),
  source: z.string(),
});
export type ClassifiedEvent = z.infer<typeof ClassifiedEventSchema>;

// ─── Audit Log ────────────────────────────────────────────────────────────────

export const AuditEntrySchema = z.object({
  id: z.string().uuid(),
  operation: z.string(),
  source: z.enum(['cli', 'mcp', 'daemon', 'test']),
  projectId: z.string().uuid().optional(),
  at: z.number(),
  meta: z.record(z.string()).optional(),
});

export type AuditEntry = z.infer<typeof AuditEntrySchema>;
