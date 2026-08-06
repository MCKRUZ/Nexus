import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveSecret, clearSecretCache, resolveLangfuseCredentials } from './secrets.js';
import * as config from './index.js';

const NAME = 'NEXUS_TEST_SECRET';

beforeEach(() => {
  clearSecretCache();
  delete process.env[NAME];
});

afterEach(() => {
  vi.restoreAllMocks();
  clearSecretCache();
  delete process.env[NAME];
});

/** A helper that echoes back the name it was asked for, via a real child process. */
function echoHelper(): string[] {
  return [process.execPath, '-e', 'process.stdout.write("value-for-" + process.argv[1])'];
}

describe('resolveSecret', () => {
  it('prefers an environment variable over the helper', () => {
    process.env[NAME] = 'from-env';
    vi.spyOn(config, 'readConfig').mockReturnValue({
      version: 1,
      createdAt: 0,
      secretCommand: echoHelper(),
    });

    expect(resolveSecret(NAME)).toBe('from-env');
  });

  it('falls back to the configured helper', () => {
    vi.spyOn(config, 'readConfig').mockReturnValue({
      version: 1,
      createdAt: 0,
      secretCommand: echoHelper(),
    });

    expect(resolveSecret(NAME)).toBe(`value-for-${NAME}`);
  });

  it('returns null when no helper is configured', () => {
    vi.spyOn(config, 'readConfig').mockReturnValue({ version: 1, createdAt: 0 });
    expect(resolveSecret(NAME)).toBeNull();
  });

  it('treats a broken helper as an unset credential rather than a fault', () => {
    // A missing secret store must degrade to "integration not configured".
    // Throwing here would take down callers that work fine without it.
    vi.spyOn(config, 'readConfig').mockReturnValue({
      version: 1,
      createdAt: 0,
      secretCommand: ['definitely-not-a-real-binary-xyz'],
    });

    expect(() => resolveSecret(NAME)).not.toThrow();
    expect(resolveSecret(NAME)).toBeNull();
  });

  it('treats an uninitialized config as an unset credential', () => {
    vi.spyOn(config, 'readConfig').mockImplementation(() => {
      throw new Error('Nexus is not initialized. Run `nexus init` first.');
    });
    expect(resolveSecret(NAME)).toBeNull();
  });

  it('invokes the helper once and caches the result', () => {
    const spy = vi.spyOn(config, 'readConfig').mockReturnValue({
      version: 1,
      createdAt: 0,
      secretCommand: echoHelper(),
    });

    resolveSecret(NAME);
    resolveSecret(NAME);
    resolveSecret(NAME);

    // Each helper run reads config once; caching means only the first does.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('caches a negative result too, so a missing secret is not re-fetched', () => {
    const spy = vi.spyOn(config, 'readConfig').mockReturnValue({ version: 1, createdAt: 0 });
    resolveSecret(NAME);
    resolveSecret(NAME);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('resolveLangfuseCredentials', () => {
  const KEYS = ['NEXUS_LANGFUSE_BASE_URL', 'NEXUS_LANGFUSE_PUBLIC_KEY', 'NEXUS_LANGFUSE_SECRET_KEY'];

  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  it('assembles credentials from the secret store', () => {
    process.env['NEXUS_LANGFUSE_BASE_URL'] = 'https://langfuse.example';
    process.env['NEXUS_LANGFUSE_PUBLIC_KEY'] = 'pk-test';
    process.env['NEXUS_LANGFUSE_SECRET_KEY'] = 'sk-test';
    vi.spyOn(config, 'readConfig').mockReturnValue({ version: 1, createdAt: 0 });

    expect(resolveLangfuseCredentials()).toEqual({
      baseUrl: 'https://langfuse.example',
      publicKey: 'pk-test',
      secretKey: 'sk-test',
    });
  });

  it('falls back to the legacy inline block for older installs', () => {
    vi.spyOn(config, 'readConfig').mockReturnValue({
      version: 1,
      createdAt: 0,
      langfuse: { baseUrl: 'https://old.example', publicKey: 'pk-old', secretKey: 'sk-old' },
    });

    expect(resolveLangfuseCredentials()?.publicKey).toBe('pk-old');
  });

  it('reports nothing rather than partial credentials', () => {
    // Half a credential set produces confusing auth failures downstream; absence
    // is handled cleanly as "Langfuse not configured".
    process.env['NEXUS_LANGFUSE_BASE_URL'] = 'https://langfuse.example';
    vi.spyOn(config, 'readConfig').mockReturnValue({ version: 1, createdAt: 0 });

    expect(resolveLangfuseCredentials()).toBeNull();
  });

  it('returns null when Langfuse is not set up at all', () => {
    vi.spyOn(config, 'readConfig').mockReturnValue({ version: 1, createdAt: 0 });
    expect(resolveLangfuseCredentials()).toBeNull();
  });
});
