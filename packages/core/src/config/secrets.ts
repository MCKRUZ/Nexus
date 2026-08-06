/**
 * Where third-party credentials come from.
 *
 * Nexus used to keep them inline in config.json, which meant anything that could
 * read the file could use them. They now live in whatever secret store the
 * machine already has, reached through a command the user configures — the same
 * shape git uses for credential helpers, and the reason no vendor-specific path
 * is hardcoded anywhere in this package.
 *
 * Resolution order, first hit wins:
 *   1. An environment variable of the same name — for CI and one-off overrides.
 *   2. `secretCommand` from config.json, invoked with the secret's name appended.
 *   3. Nothing. Callers treat a missing credential as "integration not
 *      configured" and carry on; none of this is required for Nexus to work.
 *
 * Results are cached for the life of the process. A helper typically shells out
 * to an OS credential store, which is far too slow to repeat per request — and
 * secrets do not change under a running process in practice.
 */

import { execFileSync } from 'node:child_process';
import { readConfig } from './index.js';

/** How long a credential helper gets before it is treated as unavailable. */
const HELPER_TIMEOUT_MS = 10_000;

const cache = new Map<string, string | null>();

function runHelper(name: string): string | null {
  let command: readonly string[] | undefined;
  try {
    command = readConfig().secretCommand;
  } catch {
    return null; // not initialized yet
  }
  if (!command || command.length === 0) return null;

  const [bin, ...args] = command;
  if (!bin) return null;

  try {
    const out = execFileSync(bin, [...args, name], {
      encoding: 'utf8',
      timeout: HELPER_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // A helper that is missing, slow or unhappy means "no credential", not a
    // fault worth propagating — every caller here has a working no-op path.
    return null;
  }
}

/** Resolve one named credential, or null when it is not configured anywhere. */
export function resolveSecret(name: string): string | null {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const fromEnv = process.env[name];
  const value = fromEnv && fromEnv.length > 0 ? fromEnv : runHelper(name);

  cache.set(name, value);
  return value;
}

/** Forget everything resolved so far. Exists for tests. */
export function clearSecretCache(): void {
  cache.clear();
}

export interface LangfuseCredentials {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
}

/**
 * Credential names Nexus looks up for Langfuse.
 *
 * Exported so setup can tell the user exactly what to store rather than
 * restating the names and drifting from what the resolver actually reads.
 */
export const LANGFUSE_SECRET_NAMES = {
  baseUrl: 'NEXUS_LANGFUSE_BASE_URL',
  publicKey: 'NEXUS_LANGFUSE_PUBLIC_KEY',
  secretKey: 'NEXUS_LANGFUSE_SECRET_KEY',
} as const;

/**
 * Langfuse credentials, or null when the integration is not set up.
 *
 * Falls back to the inline `langfuse` block for installs that predate the secret
 * store. That fallback is the only remaining reason for those fields to exist.
 */
export function resolveLangfuseCredentials(): LangfuseCredentials | null {
  const baseUrl = resolveSecret(LANGFUSE_SECRET_NAMES.baseUrl);
  const publicKey = resolveSecret(LANGFUSE_SECRET_NAMES.publicKey);
  const secretKey = resolveSecret(LANGFUSE_SECRET_NAMES.secretKey);
  if (baseUrl && publicKey && secretKey) return { baseUrl, publicKey, secretKey };

  let legacy: LangfuseCredentials | undefined;
  try {
    legacy = readConfig().langfuse;
  } catch {
    return null;
  }
  if (legacy?.baseUrl && legacy.publicKey && legacy.secretKey) return legacy;

  return null;
}
