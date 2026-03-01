/**
 * LLM-powered extraction engine.
 * Reads session transcripts and extracts:
 * - Architectural decisions
 * - Code patterns
 * - Developer preferences
 * - Potential conflicts
 *
 * SECURITY: filterSecrets() is applied to all content BEFORE sending to the LLM.
 * No file contents are ever sent — only filtered summaries.
 */

import Anthropic from '@anthropic-ai/sdk';
import { filterSecrets } from '../security/index.js';
import type { DecisionKind } from '../types/index.js';

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

export interface ExtractedDecision {
  kind: DecisionKind;
  summary: string;
  rationale?: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface ExtractedPattern {
  name: string;
  description: string;
  examplePath?: string;
}

export interface ExtractedPreference {
  key: string;
  value: string;
}

export interface ExtractionResult {
  decisions: ExtractedDecision[];
  patterns: ExtractedPattern[];
  preferences: ExtractedPreference[];
  rawResponse?: string;
}

const EXTRACTION_SYSTEM_PROMPT = `You are an architectural knowledge extractor for a developer intelligence system.

Given a Claude Code session transcript, extract:
1. **Architectural decisions** — explicit choices made (libraries, patterns, naming, security approaches)
2. **Code patterns** — recurring implementation approaches observed
3. **Developer preferences** — personal style or workflow choices

IMPORTANT RULES:
- Only extract decisions that were CONFIRMED (not just discussed or rejected)
- Be conservative — only extract high-confidence items
- For decisions, the summary must be a clear declarative statement ("Use X for Y")
- Never include file contents, credentials, or sensitive data
- Max 5 decisions, 3 patterns, 3 preferences per extraction

Respond with valid JSON only, in this exact schema:
{
  "decisions": [
    { "kind": "architecture|library|pattern|naming|security|other", "summary": "...", "rationale": "...", "confidence": "high|medium|low" }
  ],
  "patterns": [
    { "name": "...", "description": "..." }
  ],
  "preferences": [
    { "key": "...", "value": "..." }
  ]
}`;

export interface ExtractFromTranscriptOptions {
  /** The session transcript text — will be filtered for secrets before use */
  transcript: string;
  /** Max chars to send to LLM (prevents huge token bills) */
  maxChars?: number;
}

export async function extractFromTranscript(
  opts: ExtractFromTranscriptOptions,
): Promise<ExtractionResult> {
  const maxChars = opts.maxChars ?? 15_000;

  // SECURITY: Filter secrets before sending to any LLM
  const { filtered, redactedCount } = filterSecrets(opts.transcript);

  if (redactedCount > 0) {
    console.warn(`[nexus-extractor] Redacted ${redactedCount} potential secrets from transcript before extraction`);
  }

  // Truncate to avoid excessive token usage
  const truncated = filtered.length > maxChars
    ? filtered.slice(-maxChars) // take the END (most recent context is most relevant)
    : filtered;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001', // cheapest model for extraction
    max_tokens: 1024,
    system: EXTRACTION_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Extract architectural knowledge from this Claude Code session transcript:\n\n${truncated}`,
      },
    ],
  });

  const rawResponse = message.content[0]?.type === 'text' ? message.content[0].text : '';

  try {
    // Extract JSON from response (it might be wrapped in markdown)
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { decisions: [], patterns: [], preferences: [], rawResponse };
    }

    const parsed = JSON.parse(jsonMatch[0]) as ExtractionResult;
    return {
      decisions: parsed.decisions ?? [],
      patterns: parsed.patterns ?? [],
      preferences: parsed.preferences ?? [],
      rawResponse,
    };
  } catch {
    return { decisions: [], patterns: [], preferences: [], rawResponse };
  }
}

export interface ExtractFromFilesOptions {
  /** List of file paths to use as context (paths only — NOT contents, for security) */
  filePaths: string[];
  /** Human-readable description of what was done this session */
  sessionSummary: string;
}

/**
 * Lightweight extraction when full transcript is not available.
 * Only uses file paths + session summary — no file contents ever sent.
 */
export async function extractFromFileSummary(
  opts: ExtractFromFilesOptions,
): Promise<ExtractionResult> {
  const content = [
    `Session summary: ${opts.sessionSummary}`,
    '',
    `Files modified (${opts.filePaths.length}):`,
    ...opts.filePaths.map((p) => `  - ${p}`),
  ].join('\n');

  return extractFromTranscript({ transcript: content, maxChars: 5000 });
}
