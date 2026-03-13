import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateEncryptionKey } from '../security/index.js';

export const NEXUS_DIR = path.join(os.homedir(), '.nexus');
export const CONFIG_FILE = path.join(NEXUS_DIR, 'config.json');
export const DB_FILE = path.join(NEXUS_DIR, 'nexus.db');

export interface NexusConfig {
  version: number;
  encryptionKey: string; // TODO: migrate to OS keychain in a future release
  createdAt: number;
  /** LLM provider for extraction pipeline. Default: 'anthropic' */
  llmProvider?: 'openrouter' | 'anthropic' | 'ollama';
  /** API key for OpenRouter. Falls back to OPENROUTER_API_KEY env var. */
  openrouterApiKey?: string;
  /** OpenRouter model ID. Default: 'anthropic/claude-haiku-4-5' */
  openrouterModel?: string;
  /** API key for Anthropic / local proxy. Falls back to ANTHROPIC_API_KEY env var. */
  anthropicApiKey?: string;
  /**
   * Base URL for Anthropic API or a local proxy (e.g. http://your-proxy.internal:4040).
   * Falls back to ANTHROPIC_BASE_URL env var. When set without an apiKey,
   * a placeholder key is used so the Anthropic SDK doesn't throw.
   */
  anthropicBaseUrl?: string;
  /** Anthropic model ID. Default: 'claude-haiku-4-5-20251001' */
  anthropicModel?: string;
  /** Base URL for Ollama. Default: 'http://localhost:11434' */
  ollamaBaseUrl?: string;
  /** Ollama model name. Default: 'llama3.1:8b' */
  ollamaModel?: string;
  langfuse?: {
    baseUrl: string;
    publicKey: string;
    secretKey: string;
  };
}

export function ensureNexusDir(): void {
  fs.mkdirSync(NEXUS_DIR, { recursive: true });
}

export function isInitialized(): boolean {
  return fs.existsSync(CONFIG_FILE) && fs.existsSync(DB_FILE);
}

export function readConfig(): NexusConfig {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error('Nexus is not initialized. Run `nexus init` first.');
  }
  const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  return JSON.parse(raw) as NexusConfig;
}

export function writeConfig(config: NexusConfig): void {
  ensureNexusDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  // Restrict permissions on the config file (contains encryption key)
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    // chmod may not be supported on all platforms
  }
}

export interface AnthropicAuth {
  /** API key (X-Api-Key header). Mutually exclusive with authToken. */
  apiKey?: string;
  /** OAuth Bearer token. Used when authenticating via Claude Code OAuth. */
  authToken?: string;
  /** Custom base URL for a local proxy (e.g. http://your-proxy.internal:4040). */
  baseURL?: string;
}

/**
 * Resolves Anthropic auth in priority order:
 *   1. ANTHROPIC_API_KEY env var → { apiKey }
 *   2. anthropicApiKey in ~/.nexus/config.json → { apiKey }
 *   3. Claude Code OAuth token in ~/.claude/.credentials.json → { authToken }
 *      (Nexus is specifically a Claude Code tool; reading its credentials is intentional)
 *
 * Also resolves baseURL from ANTHROPIC_BASE_URL env var or anthropicBaseUrl in config.
 */
export function resolveAnthropicAuth(): AnthropicAuth {
  // Only use a custom base URL if explicitly configured for Nexus.
  // ANTHROPIC_BASE_URL env var is typically a Langfuse tracing proxy meant for
  // Claude Code's own calls — Nexus's extraction calls should go direct.
  const nexusBaseURL = (() => {
    try { return readConfig().anthropicBaseUrl; } catch { return undefined; }
  })();

  // 1. Explicit API key in env (use Nexus-specific base URL only, not env proxy)
  if (process.env['ANTHROPIC_API_KEY']) {
    return { apiKey: process.env['ANTHROPIC_API_KEY'], ...(nexusBaseURL ? { baseURL: nexusBaseURL } : {}) };
  }

  // 2. API key in nexus config
  try {
    const cfg = readConfig();
    if (cfg.anthropicApiKey) {
      return { apiKey: cfg.anthropicApiKey, ...(nexusBaseURL ? { baseURL: nexusBaseURL } : {}) };
    }
  } catch {
    // config may not exist yet
  }

  // 3. Claude Code OAuth token (~/.claude/.credentials.json) — long-lived token, auto-managed by Claude Code
  //    OAuth tokens go to the default Anthropic endpoint — never through a custom proxy.
  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    if (fs.existsSync(credPath)) {
      const creds = JSON.parse(fs.readFileSync(credPath, 'utf8')) as {
        claudeAiOauth?: { accessToken?: string; expiresAt?: number };
      };
      const token = creds.claudeAiOauth?.accessToken;
      const expiresAt = creds.claudeAiOauth?.expiresAt ?? 0;
      if (token && Date.now() < expiresAt) {
        return { authToken: token };
      }
    }
  } catch {
    // credentials file may not exist or be malformed
  }

  return { ...(nexusBaseURL ? { baseURL: nexusBaseURL } : {}) };
}

/** @deprecated Use resolveAnthropicAuth() */
export function resolveAnthropicApiKey(): string | undefined {
  return resolveAnthropicAuth().apiKey;
}

/**
 * Resolves the Anthropic base URL for Nexus-specific calls.
 * Only reads from Nexus config — ignores ANTHROPIC_BASE_URL env var
 * (which is typically a Langfuse tracing proxy for Claude Code, not for Nexus).
 */
export function resolveAnthropicBaseUrl(): string | undefined {
  try {
    const cfg = readConfig();
    if (cfg.anthropicBaseUrl) return cfg.anthropicBaseUrl;
  } catch {
    // config may not exist yet
  }
  return undefined;
}

export function initConfig(): NexusConfig {
  const config: NexusConfig = {
    version: 1,
    encryptionKey: generateEncryptionKey(),
    createdAt: Date.now(),
  };
  writeConfig(config);
  return config;
}
