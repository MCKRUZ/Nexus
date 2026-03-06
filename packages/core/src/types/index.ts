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

export const ConflictSchema = z.object({
  id: z.string().uuid(),
  projectIds: z.array(z.string().uuid()).min(2),
  description: z.string(),
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
