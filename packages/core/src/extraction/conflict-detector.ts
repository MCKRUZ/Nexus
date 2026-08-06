/**
 * Portfolio-level conflict detection engine.
 *
 * A single batched LLM call analyzes one focus project against the whole
 * portfolio, looking for genuine incompatibilities between projects that share
 * code or infrastructure. Rare and high signal by design — returning nothing is
 * the expected outcome most of the time.
 *
 * It also used to emit "advisories": knowledge-transfer suggestions at info
 * severity. That tier was retired after producing ~12,900 records that were
 * never read, because a suggestion with no occasion to appear has nowhere to go.
 * Conflicts survive because the prompt hook gives them one — it raises them when
 * the user asks something they bear on. Existing advisory rows are kept and
 * marked dismissed; nothing new is generated.
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

/*
 * This used to ask for "advisories" as well — knowledge-transfer suggestions,
 * up to five per run. It produced 12,933 of them over three months and not one
 * was ever read or dismissed, because a recommendation with no occasion attached
 * has nowhere useful to appear. Conflicts do have an occasion: the prompt hook
 * raises them when the user asks something they bear on.
 *
 * Asking for both cost tokens on every run to generate half an answer that was
 * discarded, so the advisory half is gone from the prompt, not just from the
 * parsing. Existing advisory rows are retained and marked dismissed.
 */
const PORTFOLIO_SYSTEM = `You are a cross-project intelligence analyzer for a developer's project portfolio.

You will receive a FOCUS PROJECT with its architectural decisions, and a PORTFOLIO of other projects with their key decisions.

Your job is to find CONFLICTS: genuine incompatibilities where two projects that
share code or infrastructure have made choices that cannot both hold.

These should be RARE and HIGH SIGNAL. Returning none is the normal outcome and is
always better than padding the list.

Rules:
- Only flag if the projects actually interoperate or share dependencies
- Different tech stacks in independent projects are NOT conflicts
- Must cause actual breakage or maintenance burden
- Do NOT report knowledge-transfer suggestions, similarities, or opportunities —
  only incompatibilities
- Maximum 3 conflicts

Respond with JSON only:
{
  "conflicts": [
    { "description": "One sentence: what conflicts and why it breaks.", "projectIds": ["id1", "id2"], "severity": "high|medium|low" }
  ]
}

If there are no conflicts, respond: { "conflicts": [] }`;

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
      conflicts?: Array<{ description: string; projectIds?: string[]; severity?: string }>;
    };

    const insights: DetectedInsight[] = [];
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
