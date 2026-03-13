/**
 * OpenRouter LLM provider.
 * Uses Node 22 built-in fetch — no additional dependencies.
 * API: https://openrouter.ai/api/v1/chat/completions (OpenAI-compatible)
 */

import type { NexusConfig } from '../config/index.js';
import type { LlmProvider, ChatCompletionOptions, ChatCompletionResult } from './provider.js';

const DEFAULT_MODEL = 'anthropic/claude-haiku-4-5';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export function createOpenRouterProvider(config: NexusConfig): LlmProvider {
  const apiKey = config.openrouterApiKey ?? process.env['OPENROUTER_API_KEY'];
  if (!apiKey) {
    throw new Error(
      'OpenRouter API key not configured. Options:\n' +
      '  1. Add "openrouterApiKey" to ~/.nexus/config.json\n' +
      '  2. Set OPENROUTER_API_KEY env var',
    );
  }

  const model = config.openrouterModel ?? DEFAULT_MODEL;

  return {
    name: 'openrouter',

    async chatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
      const response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/mckruz/nexus',
          'X-Title': 'Nexus',
        },
        body: JSON.stringify({
          model,
          max_tokens: opts.maxTokens,
          messages: [
            { role: 'system', content: opts.system },
            { role: 'user', content: opts.userMessage },
          ],
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`OpenRouter API error ${response.status}: ${body}`);
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const text = data.choices?.[0]?.message?.content ?? '';

      return {
        text,
        usage: data.usage
          ? {
              inputTokens: data.usage.prompt_tokens ?? 0,
              outputTokens: data.usage.completion_tokens ?? 0,
            }
          : undefined,
        model,
      };
    },
  };
}
