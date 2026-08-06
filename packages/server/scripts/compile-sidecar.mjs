/**
 * Compiles the Hono server into a standalone executable for Tauri to ship
 * alongside the desktop app.
 *
 * Tauri looks for a sidecar named `<base>-<rust target triple>`, so the name has
 * to match the toolchain that will build the app — not whatever this script
 * guesses from `process.platform`. Ask rustc directly; if the two disagree the
 * bundler fails late with a confusing "sidecar not found".
 */

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binariesDir = path.resolve(serverDir, '../dashboard/src-tauri/binaries');

/** Rust target triple → the pkg target that produces a matching binary. */
const PKG_TARGETS = {
  'x86_64-pc-windows-msvc': 'node22-win-x64',
  'aarch64-pc-windows-msvc': 'node22-win-arm64',
  'x86_64-apple-darwin': 'node22-macos-x64',
  'aarch64-apple-darwin': 'node22-macos-arm64',
  'x86_64-unknown-linux-gnu': 'node22-linux-x64',
  'aarch64-unknown-linux-gnu': 'node22-linux-arm64',
};

function hostTargetTriple() {
  const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const host = out.split('\n').find((line) => line.startsWith('host:'));
  if (!host) {
    throw new Error('Could not read the host target triple from `rustc -vV`.');
  }
  return host.slice('host:'.length).trim();
}

/**
 * Runs through a shell because pnpm is a `.cmd` shim on Windows. Paths are kept
 * relative to `serverDir` and quoted: the checkout path may contain spaces, and
 * an unquoted one gets split into two arguments by cmd.exe.
 */
function run(command) {
  execSync(command, { cwd: serverDir, stdio: 'inherit' });
}

const triple = hostTargetTriple();
const pkgTarget = PKG_TARGETS[triple];
if (!pkgTarget) {
  throw new Error(
    `No sidecar build configured for ${triple}. Add it to PKG_TARGETS in ${path.relative(serverDir, fileURLToPath(import.meta.url))}.`,
  );
}

const extension = triple.includes('windows') ? '.exe' : '';
const fileName = `nexus-server-${triple}${extension}`;
const outputPath = path.join(binariesDir, fileName);
const relativeOutput = `../dashboard/src-tauri/binaries/${fileName}`;

fs.mkdirSync(binariesDir, { recursive: true });

console.log(`[sidecar] host: ${triple} → pkg target: ${pkgTarget}`);

run('pnpm bundle');
run(
  `pnpm exec pkg dist/bundle.cjs --config pkg.json --target ${pkgTarget} --output "${relativeOutput}"`,
);

if (!fs.existsSync(outputPath)) {
  throw new Error(`pkg reported success but ${outputPath} does not exist.`);
}

console.log(`[sidecar] ${outputPath} (${(fs.statSync(outputPath).size / 1e6).toFixed(1)} MB)`);
