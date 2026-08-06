/**
 * Loads the key store the way the desktop app does: bundled into CommonJS.
 *
 * The desktop server sidecar is not run as ESM. It is bundled by esbuild into a
 * single CommonJS file and packed into a standalone executable, and esbuild
 * rewrites `import.meta` to an empty object in that format. A loader written
 * against `import.meta.url` alone therefore receives `undefined` and throws at
 * import time, taking the whole server down before it serves a request.
 *
 * The ESM test next door covers the CLI, MCP server and hooks. This one covers
 * the desktop app, which is the only consumer that sees the CommonJS form. Both
 * are needed: a fix for either format silently broke the other once already.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const distEntry = path.join(packageRoot, 'dist', 'index.js');

let bundlePath: string;
let cleanupDir: string;

afterAll(() => {
  if (cleanupDir) fs.rmSync(cleanupDir, { recursive: true, force: true });
});

beforeAll(() => {
  expect(
    fs.existsSync(distEntry),
    `Expected built output at ${distEntry}. Run \`pnpm build\` before the test suite.`,
  ).toBe(true);

  // Bundle inside the package so Node can still resolve the native keyring from
  // `node_modules`. Where the bundle is *shipped* is a packaging concern handled
  // separately; this test is about whether the loader works in CommonJS at all.
  const outDir = fs.mkdtempSync(path.join(packageRoot, 'nexus-cjs-'));
  cleanupDir = outDir;
  bundlePath = path.join(outDir, 'bundle.cjs');

  // Same shape as the sidecar build: bundle to CommonJS, leave the native
  // SQLite driver external.
  execFileSync(
    process.execPath,
    [
      path.join(packageRoot, 'node_modules', 'esbuild', 'bin', 'esbuild'),
      distEntry,
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${bundlePath}`,
      '--external:better-sqlite3',
    ],
    { cwd: packageRoot, encoding: 'utf8' },
  );
}, 60_000);

function runInCommonJs(source: string): string {
  return execFileSync(process.execPath, ['--eval', source], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, NEXUS_KEYRING_SERVICE: 'nexus-cjs-test' },
  }).trim();
}

describe('key store bundled as CommonJS', () => {
  it('imports without throwing', () => {
    // The original failure: createRequire(undefined) throws at module scope, so
    // the server died before reaching any of its own code.
    const out = runInCommonJs(
      `require(${JSON.stringify(bundlePath)}); console.log('LOADED');`,
    );
    expect(out).toBe('LOADED');
  });

  it('reaches the OS credential store', () => {
    const out = runInCommonJs(
      `const m = require(${JSON.stringify(bundlePath)});` +
        `console.log(m.isKeychainAvailable() ? 'AVAILABLE' : 'UNAVAILABLE');`,
    );
    expect(out).toBe('AVAILABLE');
  });

  it('round-trips a key', () => {
    const out = runInCommonJs(
      `const m = require(${JSON.stringify(bundlePath)});` +
        `m.writeKeyToKeychain('cjs-round-trip');` +
        `const got = m.readKeyFromKeychain();` +
        `m.deleteKeyFromKeychain();` +
        `console.log(got);`,
    );
    expect(out).toBe('cjs-round-trip');
  });
});
