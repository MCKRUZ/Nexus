/**
 * Where the database encryption key lives.
 *
 * The key belongs in the OS credential store, not in a file beside the database.
 * A key in `config.json` travels with the folder: copy `~/.nexus` anywhere and
 * you have both the ciphertext and the means to read it. In the OS store the key
 * cannot leave the machine, so a copied folder is inert.
 *
 * This does NOT defend against code running as the same user — the OS will
 * decrypt for anything under that account, exactly as it would read the file.
 * The gain is decoupling possession of the data from the ability to read it.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const DEFAULT_SERVICE_NAME = 'nexus';
const KEY_NAME = 'db-encryption-key';

/**
 * Credential-store namespace, resolved per call rather than at import.
 *
 * Tests MUST set NEXUS_KEYRING_SERVICE to an isolated value. Without it they
 * would read and delete the real key, which is not recoverable — losing it means
 * losing the database.
 */
function serviceName(): string {
  return process.env['NEXUS_KEYRING_SERVICE'] ?? DEFAULT_SERVICE_NAME;
}

/**
 * The keyring is a native module with no ESM entry point, so it has to be loaded
 * through CommonJS. Getting a working `require` here is harder than it looks,
 * because this module is consumed in two different forms:
 *
 *  - As ESM — the CLI, MCP server and hooks. A bare `require` is undefined, so
 *    every lookup would fall silently back to config.json.
 *  - Bundled into CommonJS — the desktop server sidecar. esbuild rewrites
 *    `import.meta` to `{}` there, so `import.meta.url` is undefined and
 *    `createRequire` throws at import time, killing the process on startup.
 *
 * Both failures have happened. Resolve a base path that exists in either form.
 */
function moduleBaseUrl(): string {
  const url: unknown = import.meta.url;
  if (typeof url === 'string' && url.length > 0) return url;

  // CommonJS bundle: `__filename` is a real module-scope value. `typeof` on an
  // undeclared identifier is safe, so this does not throw under ESM.
  if (typeof __filename === 'string' && __filename.length > 0) {
    return pathToFileURL(__filename).href;
  }

  throw new Error(
    'Cannot determine a module base path to load the OS credential store from. ' +
      'The database key cannot be read without it.',
  );
}

const nodeRequire = createRequire(moduleBaseUrl());

/** Loaded lazily so environments without a credential store still import cleanly. */
type KeyringEntry = {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
};

type EntryCtor = new (service: string, user: string) => KeyringEntry;

let entryCtor: EntryCtor | null | undefined;

function getEntry(): KeyringEntry | null {
  if (entryCtor === undefined) {
    try {
      const { Entry } = nodeRequire('@napi-rs/keyring') as { Entry: EntryCtor };
      entryCtor = Entry;
    } catch {
      entryCtor = null; // no credential store on this platform
    }
  }
  return entryCtor ? new entryCtor(serviceName(), KEY_NAME) : null;
}

/** True when this machine has a usable OS credential store. */
export function isKeychainAvailable(): boolean {
  return getEntry() !== null;
}

/** Read the key from the OS credential store, or null if absent/unavailable. */
export function readKeyFromKeychain(): string | null {
  const entry = getEntry();
  if (!entry) return null;
  try {
    const value = entry.getPassword();
    return value && value.length > 0 ? value : null;
  } catch {
    return null; // no entry stored yet
  }
}

/** Store the key in the OS credential store. Returns false if unavailable. */
export function writeKeyToKeychain(key: string): boolean {
  const entry = getEntry();
  if (!entry) return false;
  entry.setPassword(key);
  return true;
}

/** Remove the key from the OS credential store. Returns false if unavailable. */
export function deleteKeyFromKeychain(): boolean {
  const entry = getEntry();
  if (!entry) return false;
  try {
    return entry.deletePassword();
  } catch {
    return false;
  }
}

export type KeySource = 'env' | 'keychain' | 'config';

/**
 * Environment variable carrying the key for processes that cannot reach the OS
 * credential store themselves. The desktop app's bundled server is the reason
 * this exists: it ships as a packed executable with no native credential module,
 * so the desktop shell reads the key and hands it over when launching it.
 */
export const ENCRYPTION_KEY_ENV = 'NEXUS_ENCRYPTION_KEY';

export interface ResolvedKey {
  key: string;
  source: KeySource;
}

/**
 * Resolve the encryption key: an explicitly handed-over value first, then the OS
 * credential store, then the legacy `config.json` value for installs that
 * predate the credential store.
 */
export function resolveEncryptionKey(configKey?: string): ResolvedKey {
  const fromEnv = process.env[ENCRYPTION_KEY_ENV];
  if (fromEnv && fromEnv.length > 0) return { key: fromEnv, source: 'env' };

  const fromKeychain = readKeyFromKeychain();
  if (fromKeychain) return { key: fromKeychain, source: 'keychain' };

  if (configKey && configKey.length > 0) return { key: configKey, source: 'config' };

  throw new Error(
    `No database encryption key found. Expected one in ${ENCRYPTION_KEY_ENV}, in the ` +
      `OS credential store (${serviceName()}/${KEY_NAME}), or in ~/.nexus/config.json. ` +
      'Run `nexus init` ' +
      'if this is a new install, or restore the key if it was deleted — without it ' +
      'the database cannot be decrypted.',
  );
}
