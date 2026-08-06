/**
 * Loads the key store the way production does: real Node, real ESM, built output.
 *
 * The unit tests run under vitest, which supplies a CommonJS `require` shim. That
 * shim hid a real bug — the module loaded the native keyring with a bare
 * `require`, which is undefined in the ESM output the CLI actually runs, so every
 * key lookup fell silently back to config.json while the tests stayed green.
 *
 * This test spawns a separate Node process so no shim is present. It is the only
 * coverage of the loader the CLI, MCP server and hooks all go through.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const distEntry = path.join(packageRoot, 'dist', 'index.js');

function runInRealEsm(source: string): string {
  return execFileSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, NEXUS_KEYRING_SERVICE: 'nexus-esm-test' },
  }).trim();
}

describe('key store under real ESM', () => {
  it('has built output to test against', () => {
    expect(
      fs.existsSync(distEntry),
      `Expected built output at ${distEntry}. Run \`pnpm build\` before the test suite — ` +
        'this test exists to check the compiled module, so skipping it would restore the ' +
        'blind spot it was written to close.',
    ).toBe(true);
  });

  it('reaches the OS credential store without a CommonJS shim', () => {
    const entryUrl = new URL(`file://${distEntry.replace(/\\/g, '/')}`).href;
    const out = runInRealEsm(
      `import { isKeychainAvailable } from ${JSON.stringify(entryUrl)};` +
        `console.log(isKeychainAvailable() ? 'AVAILABLE' : 'UNAVAILABLE');`,
    );
    expect(out).toBe('AVAILABLE');
  });

  it('round-trips a key through the compiled module', () => {
    const entryUrl = new URL(`file://${distEntry.replace(/\\/g, '/')}`).href;
    const out = runInRealEsm(
      `import { writeKeyToKeychain, readKeyFromKeychain, deleteKeyFromKeychain } from ${JSON.stringify(entryUrl)};` +
        `writeKeyToKeychain('esm-round-trip');` +
        `const got = readKeyFromKeychain();` +
        `deleteKeyFromKeychain();` +
        `console.log(got);`,
    );
    expect(out).toBe('esm-round-trip');
  });
});
