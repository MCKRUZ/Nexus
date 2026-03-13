/**
 * Anthropic LLM provider.
 * Wraps the existing @anthropic-ai/sdk usage from the extraction pipeline.
 */

import Anthropic from '@anthropic-ai/sdk';
import { resolveAnthropicAuth } from '../config/index.js';
import type { NexusConfig } from '../config/index.js';
import type { LlmProvider, ChatCompletionOptions, ChatCompletionResult } from './provider.js';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

export function createAnthropicProvider(config: NexusConfig): LlmProvider {
  const model = config.anthropicModel ?? DEFAULT_MODEL;
  const auth = resolveAnthropicAuth();
  if (!auth.apiKey && !auth.authToken) {
    throw new Error(
      'Anthropic auth not configured. Options:\n' +
      '  1. Set ANTHROPIC_API_KEY env var\n' +
      '  2. Add "anthropicApiKey" to ~/.nexus/config.json\n' +
      '  3. Log in to Claude Code (`claude login`) — Nexus can use your OAuth token',
    );
  }

  const client = new Anthropic({
    ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
    ...(auth.authToken ? { authToken: auth.authToken } : {}),
    ...(auth.baseURL ? { baseURL: auth.baseURL } : {}),
  });

  return {
    name: 'anthropic',

    async chatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
      const message = await client.messages.create({
        model,
        max_tokens: opts.maxTokens,
        system: opts.system,
        messages: [{ role: 'user', content: opts.userMessage }],
      });

      const text = message.content[0]?.type === 'text' ? message.content[0].text : '';

      return {
        text,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
        },
        model,
      };
    },
  };
}
