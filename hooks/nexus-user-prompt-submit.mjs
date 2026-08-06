#!/usr/bin/env node
/**
 * Nexus UserPromptSubmit hook.
 *
 * Records what the user asked, and when the request touches something already
 * decided — or already in conflict — injects that context ahead of the prompt.
 *
 * This runs before every prompt and blocks it, so two rules govern everything
 * here. It must be quiet: an advisory that fires constantly gets skimmed past,
 * including the one time it mattered. And it must fail open: no Nexus fault,
 * misconfiguration or missing database may ever stop someone working. Every
 * failure path exits 0 with no output.
 *
 * It imports @nexus/core/prompt-hook rather than the main entry point. The full
 * surface pulls in the Anthropic SDK, roughly 240ms of module loading that
 * nothing on this path uses, and that cost would be paid on every prompt.
 */

import { createRequire } from 'node:module';

/**
 * Hard ceiling on the whole hook. Past this, drop the advisory and let the user
 * proceed with nothing recorded.
 *
 * Typical cost is under 300ms, but the occasional run is far slower — the
 * database is shared with the extraction and sync hooks, and an open can sit
 * behind their writes. A prompt held up for seconds is worse than a prompt with
 * no advisory, so the tail is cut rather than waited out.
 */
const DEADLINE_MS = 1500;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const done = () => resolve(data);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // not a hook payload we understand
  }

  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : 'unknown';
  if (!prompt.trim()) return;

  // Resolved relative to this file, not the working directory: Claude Code runs
  // the hook from whatever project the user is in.
  //
  // The relative path is tried first because this hook is registered by its
  // absolute path inside the repository, exactly like the other Nexus hooks, and
  // pnpm does not link workspace packages into the repository root — so the bare
  // specifier does not resolve from here. It is kept as a fallback for the case
  // where Nexus is installed as an ordinary dependency.
  let runPromptHook;
  for (const specifier of ['../packages/core/dist/advisories/prompt-hook.js', '@nexus/core/prompt-hook']) {
    try {
      const target = specifier.startsWith('.')
        ? new URL(specifier, import.meta.url).href
        : createRequire(import.meta.url).resolve(specifier);
      ({ runPromptHook } = await import(target));
      break;
    } catch {
      // try the next one
    }
  }
  if (!runPromptHook) return; // Nexus not built — stay out of the way

  const result = runPromptHook({ sessionId, cwd, prompt });
  if (!result.context) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: result.context,
      },
    }),
  );
}

const deadline = setTimeout(() => process.exit(0), DEADLINE_MS);
deadline.unref?.();

main()
  .catch(() => {
    // Deliberately silent: see the fail-open rule above.
  })
  .finally(() => {
    clearTimeout(deadline);
  });
