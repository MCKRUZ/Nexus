/**
 * Conflict detection engine.
 * Runs after extraction to find conflicts between projects.
 */

import Anthropic from '@anthropic-ai/sdk';
import { resolveAnthropicAuth } from '../config/index.js';
import type { Decision } from '../types/index.js';

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    const auth = resolveAnthropicAuth();
    if (!auth.apiKey && !auth.authToken) {
      throw new Error('Anthropic auth not configured — conflict detection unavailable.');
    }
    _client = new Anthropic({
      ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
      ...(auth.authToken ? { authToken: auth.authToken } : {}),
      ...(auth.baseURL ? { baseURL: auth.baseURL } : {}),
    });
  }
  return _client;
}

export interface ConflictDetectionInput {
  projectA: { id: string; name: string; decisions: Decision[] };
  projectB: { id: string; name: string; decisions: Decision[] };
}

export interface DetectedConflict {
  description: string;
  projectIds: [string, string];
  severity: 'high' | 'medium' | 'low';
}

const CONFLICT_SYSTEM = `You are an architectural conflict detector for a multi-project development environment.

Given decisions from two projects, identify GENUINE conflicts — cases where the projects have made incompatible choices that would cause problems if the projects need to interoperate or share code.

Do NOT flag:
- Minor style differences that don't affect interoperability
- Choices that are simply different but not incompatible
- Decisions in completely unrelated domains

Respond with JSON only:
{
  "conflicts": [
    { "description": "...", "severity": "high|medium|low" }
  ]
}`;

export async function detectConflicts(input: ConflictDetectionInput): Promise<DetectedConflict[]> {
  if (input.projectA.decisions.length === 0 || input.projectB.decisions.length === 0) {
    return [];
  }

  const formatDecisions = (decisions: Decision[]) =>
    decisions
      .slice(0, 10) // limit context
      .map((d) => `[${d.kind}] ${d.summary}${d.rationale ? ` (${d.rationale})` : ''}`)
      .join('\n');

  const content = [
    `Project A: ${input.projectA.name}`,
    formatDecisions(input.projectA.decisions),
    '',
    `Project B: ${input.projectB.name}`,
    formatDecisions(input.projectB.decisions),
  ].join('\n');

  const message = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: CONFLICT_SYSTEM,
    messages: [{ role: 'user', content }],
  });

  const rawResponse = message.content[0]?.type === 'text' ? message.content[0].text : '';

  try {
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as {
      conflicts: Array<{ description: string; severity: string }>;
    };

    return (parsed.conflicts ?? []).map((c) => ({
      description: c.description,
      projectIds: [input.projectA.id, input.projectB.id] as [string, string],
      severity: (c.severity as 'high' | 'medium' | 'low') ?? 'medium',
    }));
  } catch {
    return [];
  }
}
