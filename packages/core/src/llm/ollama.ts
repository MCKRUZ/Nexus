/**
 * Ollama LLM provider.
 * Uses Node 22 built-in fetch — no additional dependencies.
 * API: http://localhost:11434/api/chat
 */

import type { NexusConfig } from '../config/index.js';
import type { LlmProvider, ChatCompletionOptions, ChatCompletionResult } from './provider.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'llama3.1:8b';

export function createOllamaProvider(config: NexusConfig): LlmProvider {
  const baseUrl = config.ollamaBaseUrl ?? DEFAULT_BASE_URL;
  const model = config.ollamaModel ?? DEFAULT_MODEL;

  return {
    name: 'ollama',

    async chatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [
            { role: 'system', content: opts.system },
            { role: 'user', content: opts.userMessage },
          ],
          options: {
            num_predict: opts.maxTokens,
          },
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Ollama API error ${response.status}: ${body}`);
      }

      const data = (await response.json()) as {
        message?: { content?: string };
        prompt_eval_count?: number;
        eval_count?: number;
      };

      const text = data.message?.content ?? '';

      return {
        text,
        usage: (data.prompt_eval_count != null || data.eval_count != null)
          ? {
              inputTokens: data.prompt_eval_count ?? 0,
              outputTokens: data.eval_count ?? 0,
            }
          : undefined,
        model,
      };
    },
  };
}
