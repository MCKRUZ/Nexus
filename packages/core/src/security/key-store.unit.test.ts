import { describe, it, expect, afterEach } from 'vitest';
import {
  isKeychainAvailable,
  readKeyFromKeychain,
  writeKeyToKeychain,
  deleteKeyFromKeychain,
  resolveEncryptionKey,
} from './key-store.js';

// Isolate the credential-store namespace before anything reads or writes it.
// Against the default namespace these tests would delete the real database key,
// which is unrecoverable — losing it means losing the database.
process.env['NEXUS_KEYRING_SERVICE'] = 'nexus-unit-test';

const CONFIG_KEY = 'legacy-key-from-config-json';
const STORED_KEY = 'key-held-in-os-credential-store';

afterEach(() => {
  if (isKeychainAvailable()) deleteKeyFromKeychain();
  delete process.env['NEXUS_ENCRYPTION_KEY'];
});

describe('key supplied through the environment', () => {
  // The desktop app's server runs as a packed executable with no access to the
  // OS credential store. The desktop shell reads the key and passes it in, so
  // this path is the only way that server can open the database.
  const ENV_KEY = 'key-handed-over-by-the-desktop-shell';

  it('is preferred over both the credential store and config.json', () => {
    if (isKeychainAvailable()) writeKeyToKeychain(STORED_KEY);
    process.env['NEXUS_ENCRYPTION_KEY'] = ENV_KEY;

    const resolved = resolveEncryptionKey(CONFIG_KEY);
    expect(resolved.key).toBe(ENV_KEY);
    expect(resolved.source).toBe('env');
  });

  it('is ignored when empty, rather than masking a real key', () => {
    process.env['NEXUS_ENCRYPTION_KEY'] = '';

    const resolved = resolveEncryptionKey(CONFIG_KEY);
    expect(resolved.key).toBe(CONFIG_KEY);
    expect(resolved.source).toBe('config');
  });
});

describe('resolveEncryptionKey', () => {
  it('falls back to the config key when the credential store holds nothing', () => {
    if (isKeychainAvailable()) deleteKeyFromKeychain();

    const resolved = resolveEncryptionKey(CONFIG_KEY);
    expect(resolved.key).toBe(CONFIG_KEY);
    expect(resolved.source).toBe('config');
  });

  it('throws a actionable error when no key exists anywhere', () => {
    if (isKeychainAvailable()) deleteKeyFromKeychain();

    expect(() => resolveEncryptionKey(undefined)).toThrow(/No database encryption key found/);
  });

  it('treats an empty config key as absent', () => {
    if (isKeychainAvailable()) deleteKeyFromKeychain();
    expect(() => resolveEncryptionKey('')).toThrow(/No database encryption key found/);
  });
});

describe.runIf(isKeychainAvailable())('with an OS credential store', () => {
  it('round-trips a key', () => {
    expect(writeKeyToKeychain(STORED_KEY)).toBe(true);
    expect(readKeyFromKeychain()).toBe(STORED_KEY);
  });

  it('prefers the credential store over the config value', () => {
    writeKeyToKeychain(STORED_KEY);

    const resolved = resolveEncryptionKey(CONFIG_KEY);
    expect(resolved.key).toBe(STORED_KEY);
    expect(resolved.source).toBe('keychain');
  });

  it('resolves from the credential store with no config value at all', () => {
    writeKeyToKeychain(STORED_KEY);

    const resolved = resolveEncryptionKey(undefined);
    expect(resolved.key).toBe(STORED_KEY);
    expect(resolved.source).toBe('keychain');
  });

  it('reports nothing after deletion', () => {
    writeKeyToKeychain(STORED_KEY);
    expect(deleteKeyFromKeychain()).toBe(true);
    expect(readKeyFromKeychain()).toBeNull();
  });
});
