/**
 * LLM-powered extraction engine.
 * Reads session transcripts and extracts:
 * - Architectural decisions
 * - Code patterns
 * - Developer preferences
 *
 * SECURITY: filterSecrets() is applied to all content BEFORE sending to the LLM.
 * No file contents are ever sent — only filtered summaries.
 */

import { filterSecrets } from '../security/index.js';
import { readConfig } from '../config/index.js';
import { createProvider } from '../llm/index.js';
import { smartTruncate } from '../utils/truncate.js';
import type { DecisionKind } from '../types/index.js';

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

export interface LlmUsageInfo {
  provider: string;
  model?: string | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

export interface ExtractionResult {
  decisions: ExtractedDecision[];
  patterns: ExtractedPattern[];
  preferences: ExtractedPreference[];
  rawResponse?: string;
  llmUsage?: LlmUsageInfo;
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

  // Truncate to avoid excessive token usage — 60/40 head/tail split preserves both
  // the beginning (setup context) and the end (errors, conclusions)
  const { text: truncated } = smartTruncate(filtered, maxChars);

  const config = readConfig();
  const provider = createProvider(config);

  const result = await provider.chatCompletion({
    system: EXTRACTION_SYSTEM_PROMPT,
    userMessage: `Extract architectural knowledge from this Claude Code session transcript:\n\n${truncated}`,
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
    // Extract JSON from response (it might be wrapped in markdown)
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { decisions: [], patterns: [], preferences: [], rawResponse, llmUsage };
    }

    const parsed = JSON.parse(jsonMatch[0]) as ExtractionResult;
    return {
      decisions: parsed.decisions ?? [],
      patterns: parsed.patterns ?? [],
      preferences: parsed.preferences ?? [],
      rawResponse,
      llmUsage,
    };
  } catch {
    return { decisions: [], patterns: [], preferences: [], rawResponse, llmUsage };
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
