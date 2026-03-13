/**
 * Portfolio-level conflict & advisory detection engine.
 *
 * Replaces the old pairwise comparison with a single batched LLM call
 * that analyzes one focus project against the entire portfolio.
 *
 * Two tiers:
 *   - **Advisories** (info): Cross-project knowledge recommendations.
 *     "You configured SSH tunneling in openclaw — this applies to ProjectPrism too."
 *   - **Conflicts** (warning): Genuine incompatibilities between projects
 *     that share code/infrastructure. Rare, high signal.
 */

import { readConfig } from '../config/index.js';
import { createProvider } from '../llm/index.js';
import type { Decision, ConflictTier, ConflictSeverity } from '../types/index.js';
import type { LlmUsageInfo } from './extractor.js';

export interface ProjectInfo {
  id: string;
  name: string;
  decisions: Decision[];
  parentId?: string | undefined;
  tags?: string[] | undefined;
}

/** @deprecated Use PortfolioAnalysisInput + analyzePortfolio() instead */
export interface ConflictDetectionInput {
  projectA: ProjectInfo;
  projectB: ProjectInfo;
  knownRelated?: boolean;
}

/** @deprecated Use DetectedInsight instead */
export interface DetectedConflict {
  description: string;
  projectIds: [string, string];
  severity: 'high' | 'medium' | 'low';
}

// ─── Portfolio Analysis (new) ────────────────────────────────────────────────

export interface PortfolioAnalysisInput {
  focusProject: ProjectInfo;
  allProjects: ProjectInfo[];
}

export interface DetectedInsight {
  description: string;
  projectIds: string[];
  tier: ConflictTier;
  severity: ConflictSeverity;
}

/**
 * Returns true if two projects have a structural relationship that makes
 * conflict detection meaningful.
 */
export function areProjectsRelated(a: ProjectInfo, b: ProjectInfo): boolean {
  // Parent/child
  if (a.parentId === b.id || b.parentId === a.id) return true;
  // Siblings (same parent)
  if (a.parentId && a.parentId === b.parentId) return true;

  // Shared tags (at least one non-empty tag in common)
  const aTags = (a.tags ?? []).filter(Boolean);
  const bTags = new Set((b.tags ?? []).filter(Boolean));
  if (aTags.length > 0 && aTags.some((t) => bTags.has(t))) return true;

  return false;
}

const PORTFOLIO_SYSTEM = `You are a cross-project intelligence analyzer for a developer's project portfolio.

You will receive a FOCUS PROJECT with its architectural decisions, and a PORTFOLIO of other projects with their key decisions.

Your job is to produce TWO types of insights:

## ADVISORIES (knowledge transfer)
Useful knowledge from one project that applies to another. These are RECOMMENDATIONS, not problems.
Examples:
- "Project A configured SSH tunneling — this technique applies to Project B's deployment too"
- "Project A chose Zod for validation — Project B currently has no validation library"
- "Project A's caching pattern could improve Project B's API performance"

Rules for advisories:
- Must reference specific decisions, not vague technology overlap
- Must be actionable — the developer can do something with this info
- Maximum 5 advisories

## CONFLICTS (genuine incompatibilities)
Real problems where two projects that share code or infrastructure have made incompatible choices.
These should be RARE and HIGH SIGNAL.

Rules for conflicts:
- Only flag if the projects actually interoperate or share dependencies
- Different tech stacks in independent projects are NOT conflicts
- Must cause actual breakage or maintenance burden
- Maximum 3 conflicts

Respond with JSON only:
{
  "advisories": [
    { "description": "One sentence: what knowledge transfers and why it's useful.", "projectIds": ["id1", "id2"], "severity": "info" }
  ],
  "conflicts": [
    { "description": "One sentence: what conflicts and why it breaks.", "projectIds": ["id1", "id2"], "severity": "high|medium|low" }
  ]
}

If there are no insights, respond: { "advisories": [], "conflicts": [] }`;

export interface PortfolioAnalysisResult {
  insights: DetectedInsight[];
  llmUsage?: LlmUsageInfo;
}

/**
 * Analyze a focus project against the entire portfolio in a single LLM call.
 * Returns advisories (knowledge transfer) and conflicts (incompatibilities).
 */
export async function analyzePortfolio(input: PortfolioAnalysisInput): Promise<PortfolioAnalysisResult> {
  if (input.focusProject.decisions.length === 0) return { insights: [] };

  const others = input.allProjects.filter(
    (p) => p.id !== input.focusProject.id && p.decisions.length > 0,
  );
  if (others.length === 0) return { insights: [] };

  const formatDecisions = (decisions: Decision[], max: number) =>
    decisions
      .slice(0, max)
      .map((d) => `[${d.kind}] ${d.summary}`)
      .join('\n');

  const portfolioSection = others
    .map((p) => `### ${p.name} (id: ${p.id})\n${formatDecisions(p.decisions, 5)}`)
    .join('\n\n');

  const content = [
    `## FOCUS PROJECT: ${input.focusProject.name} (id: ${input.focusProject.id})`,
    formatDecisions(input.focusProject.decisions, 10),
    '',
    `## PORTFOLIO (${others.length} other projects)`,
    portfolioSection,
  ].join('\n');

  const config = readConfig();
  const provider = createProvider(config);

  const result = await provider.chatCompletion({
    system: PORTFOLIO_SYSTEM,
    userMessage: content,
    maxTokens: 1024,
  });

  const rawResponse = result.text;
  const llmUsage: LlmUsageInfo = {
    provider: provider.name,
    model: result.model,
    inputTokens: result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
  };

  try {
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { insights: [], llmUsage };

    const parsed = JSON.parse(jsonMatch[0]) as {
      advisories?: Array<{ description: string; projectIds?: string[]; severity?: string }>;
      conflicts?: Array<{ description: string; projectIds?: string[]; severity?: string }>;
    };

    const insights: DetectedInsight[] = [];

    for (const a of (parsed.advisories ?? []).slice(0, 5)) {
      insights.push({
        description: a.description,
        projectIds: a.projectIds ?? [input.focusProject.id],
        tier: 'advisory',
        severity: 'info',
      });
    }

    const validSeverities = ['critical', 'high', 'medium', 'low'];
    for (const c of (parsed.conflicts ?? []).slice(0, 3)) {
      insights.push({
        description: c.description,
        projectIds: c.projectIds ?? [input.focusProject.id],
        tier: 'conflict',
        severity: (validSeverities.includes(c.severity ?? '')
          ? c.severity
          : 'medium') as ConflictSeverity,
      });
    }

    return { insights, llmUsage };
  } catch {
    return { insights: [], llmUsage };
  }
}

/**
 * @deprecated Use analyzePortfolio() for portfolio-level analysis.
 * Kept for backward compatibility — wraps the old pairwise interface.
 */
export async function detectConflicts(input: ConflictDetectionInput): Promise<DetectedConflict[]> {
  if (input.projectA.decisions.length === 0 || input.projectB.decisions.length === 0) {
    return [];
  }

  if (!input.knownRelated && !areProjectsRelated(input.projectA, input.projectB)) {
    return [];
  }

  const { insights } = await analyzePortfolio({
    focusProject: input.projectA,
    allProjects: [input.projectB],
  });

  return insights
    .filter((i) => i.tier === 'conflict')
    .map((i) => ({
      description: i.description,
      projectIds: [input.projectA.id, input.projectB.id] as [string, string],
      severity: (['high', 'medium', 'low'].includes(i.severity)
        ? i.severity
        : 'medium') as 'high' | 'medium' | 'low',
    }));
}
