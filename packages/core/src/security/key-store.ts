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
 * through CommonJS. A bare `require` is NOT available here — this package
 * compiles to ESM, where `require` is undefined and every lookup would fall
 * silently back to config.json. `createRequire` gives us a real one.
 */
const nodeRequire = createRequire(import.meta.url);

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

export type KeySource = 'keychain' | 'config';

export interface ResolvedKey {
  key: string;
  source: KeySource;
}

/**
 * Resolve the encryption key: OS credential store first, then the legacy
 * `config.json` value for installs that predate the credential store.
 */
export function resolveEncryptionKey(configKey?: string): ResolvedKey {
  const fromKeychain = readKeyFromKeychain();
  if (fromKeychain) return { key: fromKeychain, source: 'keychain' };

  if (configKey && configKey.length > 0) return { key: configKey, source: 'config' };

  throw new Error(
    'No database encryption key found. Expected one in the OS credential store ' +
      `(${serviceName()}/${KEY_NAME}) or in ~/.nexus/config.json. Run \`nexus init\` ` +
      'if this is a new install, or restore the key if it was deleted — without it ' +
      'the database cannot be decrypted.',
  );
}
