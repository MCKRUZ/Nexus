/**
 * LLM provider abstraction for the extraction pipeline.
 * Allows switching between OpenRouter, Anthropic, and Ollama
 * via ~/.nexus/config.json without changing extraction logic.
 */

import type { NexusConfig } from '../config/index.js';
import { createOpenRouterProvider } from './openrouter.js';
import { createAnthropicProvider } from './anthropic.js';
import { createOllamaProvider } from './ollama.js';

export type LlmProviderType = 'openrouter' | 'anthropic' | 'ollama';

export interface ChatCompletionOptions {
  system: string;
  userMessage: string;
  maxTokens: number;
}

export interface ChatCompletionResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number } | undefined;
  model?: string | undefined;
}

export interface LlmProvider {
  readonly name: LlmProviderType;
  chatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResult>;
}

let _provider: LlmProvider | null = null;
let _configSnapshot: string | null = null;

/**
 * Creates (or returns cached) LLM provider based on config.
 * Provider is cached until config changes.
 */
export function createProvider(config: NexusConfig): LlmProvider {
  const snapshot = JSON.stringify({
    llmProvider: config.llmProvider,
    openrouterApiKey: config.openrouterApiKey,
    openrouterModel: config.openrouterModel,
    ollamaBaseUrl: config.ollamaBaseUrl,
    ollamaModel: config.ollamaModel,
    anthropicApiKey: config.anthropicApiKey,
    anthropicBaseUrl: config.anthropicBaseUrl,
    anthropicModel: config.anthropicModel,
  });

  if (_provider && _configSnapshot === snapshot) {
    return _provider;
  }

  const providerType = config.llmProvider ?? 'anthropic';

  switch (providerType) {
    case 'openrouter':
      _provider = createOpenRouterProvider(config);
      break;
    case 'anthropic':
      _provider = createAnthropicProvider(config);
      break;
    case 'ollama':
      _provider = createOllamaProvider(config);
      break;
    default:
      throw new Error(`Unknown LLM provider: ${providerType as string}. Valid: openrouter, anthropic, ollama`);
  }

  _configSnapshot = snapshot;
  return _provider;
}

/** Reset cached provider (useful for testing). */
export function resetProvider(): void {
  _provider = null;
  _configSnapshot = null;
}
