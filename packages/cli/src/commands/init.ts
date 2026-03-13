import { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isInitialized,
  initConfig,
  ensureNexusDir,
  readConfig,
  writeConfig,
  NEXUS_DIR,
  DB_FILE,
  NexusService,
} from '@nexus/core';
import type { NexusConfig } from '@nexus/core';
import { log } from '../lib/output.js';
import {
  prompt,
  promptWithDefault,
  promptYesNo,
  promptSelect,
  closePrompt,
} from '../lib/prompt.js';
import {
  installMcpServer,
  installHook,
  getClaudeSettingsPath,
} from '../lib/settings.js';
import { installSessionTrackingHooks } from './hook.js';
import { installMemoryRule } from './install-memory-rule.js';

function resolveNexusRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(__filename), '..', '..', '..', '..');
}

async function testLangfuse(
  baseUrl: string,
  publicKey: string,
  secretKey: string,
): Promise<boolean> {
  const credentials = Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/public/health`, {
      headers: { Authorization: `Basic ${credentials}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    clearTimeout(timeout);
    return false;
  }
}

interface InitOpts {
  force?: boolean;
  nonInteractive?: boolean;
  skipHooks?: boolean;
  skipProject?: boolean;
}

export function initCommand(): Command {
  return new Command('init')
    .description('Initialize Nexus — interactive setup wizard')
    .option('--force', 'Re-initialize configuration (preserves existing database)')
    .option('--non-interactive', 'Skip all prompts, use defaults')
    .option('--skip-hooks', 'Do not install Claude Code hooks or MCP server')
    .option('--skip-project', 'Do not register current directory as a project')
    .action(async (opts: InitOpts) => {
      const interactive = !opts.nonInteractive;
      const nexusRoot = resolveNexusRoot();
      const alreadyInitialized = isInitialized();

      // ── Guard: already initialized without --force ──
      if (alreadyInitialized && !opts.force) {
        log.warn('Nexus is already initialized.');
        log.dim(`  Database: ${DB_FILE}`);
        log.dim(`  Config:   ${path.join(NEXUS_DIR, 'config.json')}`);
        log.info('Run with --force to update configuration.');
        return;
      }

      try {
        // ── Step 1: Encryption key + DB ──
        let config: NexusConfig;

        if (alreadyInitialized && opts.force) {
          log.warn('Nexus is already initialized. Updating configuration...');
          config = readConfig();
          // Preserve encryption key — don't regenerate (DB would become unreadable)
        } else {
          log.info('Initializing Nexus...');
          ensureNexusDir();
          config = initConfig();
          log.success('Generated encryption key');
          log.dim(`  Config: ${path.join(NEXUS_DIR, 'config.json')}`);
        }

        // Open DB to run migrations (safe to call on existing DB)
        const svc = NexusService.open();

        if (!alreadyInitialized) {
          log.success('Created encrypted database');
          log.dim(`  Database: ${DB_FILE}`);
        }

        console.log('');

        // ── Step 2: LLM Provider ──
        console.log('  ── LLM Provider (for decision/pattern extraction) ──');
        console.log('  Extraction uses a cheap LLM to analyze session transcripts.');
        console.log('');

        let provider: 'anthropic' | 'openrouter' | 'ollama' = 'anthropic';

        if (interactive) {
          const choice = await promptSelect('  Select provider:', [
            'Anthropic (default — uses Claude Code OAuth if no key set)',
            'OpenRouter',
            'Ollama (local, free)',
          ]);
          if (choice.startsWith('OpenRouter')) provider = 'openrouter';
          else if (choice.startsWith('Ollama')) provider = 'ollama';
        }

        config = { ...config, llmProvider: provider };

        if (provider === 'anthropic') {
          const envKey = process.env['ANTHROPIC_API_KEY'];
          if (envKey && interactive) {
            const useEnv = await promptYesNo('  ANTHROPIC_API_KEY detected in environment. Use it?');
            if (useEnv) {
              config = { ...config, anthropicApiKey: envKey };
            }
          } else if (interactive) {
            const key = await prompt('  Anthropic API key (leave blank to use Claude Code OAuth): ');
            if (key.trim()) {
              config = { ...config, anthropicApiKey: key.trim() };
            }
            const baseUrl = await prompt('  Custom base URL (leave blank for default): ');
            if (baseUrl.trim()) {
              config = { ...config, anthropicBaseUrl: baseUrl.trim() };
            }
          }
          log.success(`Provider: Anthropic${config.anthropicApiKey ? ' (API key)' : ' (Claude Code OAuth)'}`);
        } else if (provider === 'openrouter') {
          const envKey = process.env['OPENROUTER_API_KEY'];
          if (envKey && interactive) {
            const useEnv = await promptYesNo('  OPENROUTER_API_KEY detected in environment. Use it?');
            if (useEnv) {
              config = { ...config, openrouterApiKey: envKey };
            }
          } else if (interactive) {
            const key = await prompt('  OpenRouter API key: ');
            if (key.trim()) {
              config = { ...config, openrouterApiKey: key.trim() };
            }
          }
          if (interactive) {
            const model = await promptWithDefault('  Model', 'anthropic/claude-haiku-4-5');
            config = { ...config, openrouterModel: model };
          }
          log.success('Provider: OpenRouter');
        } else {
          // ollama
          if (interactive) {
            const baseUrl = await promptWithDefault('  Ollama base URL', 'http://localhost:11434');
            const model = await promptWithDefault('  Model', 'llama3.1:8b');
            config = { ...config, ollamaBaseUrl: baseUrl, ollamaModel: model };
          } else {
            config = { ...config, ollamaBaseUrl: 'http://localhost:11434', ollamaModel: 'llama3.1:8b' };
          }
          log.success('Provider: Ollama (local)');
        }

        console.log('');

        // ── Step 3: Langfuse (optional) ──
        console.log('  ── Langfuse (optional observability) ──');
        let configureLangfuse = false;
        if (interactive) {
          configureLangfuse = await promptYesNo('  Configure Langfuse tracing?', false);
        }

        if (configureLangfuse) {
          const baseUrl = await prompt('  Base URL: ');
          const publicKey = await prompt('  Public key: ');
          const secretKey = await prompt('  Secret key: ');

          if (baseUrl.trim() && publicKey.trim() && secretKey.trim()) {
            process.stdout.write('  Testing connection... ');
            const ok = await testLangfuse(baseUrl.trim(), publicKey.trim(), secretKey.trim());
            if (ok) {
              console.log('Connected');
              config = {
                ...config,
                langfuse: {
                  baseUrl: baseUrl.trim(),
                  publicKey: publicKey.trim(),
                  secretKey: secretKey.trim(),
                },
              };
              log.success('Langfuse configured');
            } else {
              console.log('Failed');
              log.warn('Could not connect to Langfuse. Skipping — you can add it later in ~/.nexus/config.json');
            }
          }
        } else {
          log.dim('  Skipped Langfuse');
        }

        // Save config before hooks (in case something fails later)
        writeConfig(config);
        console.log('');

        // ── Step 4: Claude Code Integration ──
        if (!opts.skipHooks) {
          console.log('  ── Claude Code Integration ──');
          log.dim(`  Installing into ${getClaudeSettingsPath()}...`);

          // MCP server
          const mcpPath = path.join(nexusRoot, 'packages', 'mcp', 'dist', 'index.js');
          const mcpInstalled = installMcpServer('nexus-local', {
            command: 'node',
            args: [mcpPath],
          });
          if (mcpInstalled) {
            log.success('MCP server (nexus-local)');
          } else {
            log.dim('  MCP server (nexus-local) — already installed');
          }

          // Stop hook (post-session extraction)
          const cliPath = path.join(nexusRoot, 'packages', 'cli', 'dist', 'index.js');
          const stopInstalled = installHook(
            'Stop',
            `node "${cliPath}" hook post-session --quiet`,
          );
          if (stopInstalled) {
            log.success('Stop hook (post-session extraction)');
          } else {
            log.dim('  Stop hook — already installed');
          }

          // Session tracking hooks (.mjs files + PostToolUse/SessionStart)
          const trackingResult = installSessionTrackingHooks(nexusRoot);
          if (trackingResult.ok) {
            log.success('Session tracking hooks (PostToolUse + SessionStart)');
          } else {
            log.warn(`Session tracking: ${trackingResult.error}`);
          }

          console.log('');
        } else {
          log.dim('  Skipped hooks/MCP installation (--skip-hooks)');
          console.log('');
        }

        // ── Step 5: Memory Rule ──
        const ruleInstalled = installMemoryRule({ ...(opts.force ? { force: true } : {}), nexusRoot });
        if (ruleInstalled) {
          log.success('Installed ~/.claude/rules/nexus-memory.md');
        } else {
          log.warn('Memory rule template not found — skipping');
        }

        console.log('');

        // ── Step 6: Register Project ──
        if (!opts.skipProject) {
          let registerProject = true;
          const cwd = process.cwd();
          const dirName = path.basename(cwd);

          if (interactive) {
            registerProject = await promptYesNo('  Register current directory as a project?');
          }

          if (registerProject) {
            let projectName = dirName;
            if (interactive) {
              projectName = await promptWithDefault('  Project name', dirName);
            }

            const existing = svc.getProjectByPath(cwd);
            if (existing) {
              log.dim(`  Already registered: ${existing.name}`);
            } else {
              svc.addProject({ path: cwd, name: projectName });
              log.success(`Registered: ${projectName}`);
            }
          }
        } else {
          log.dim('  Skipped project registration (--skip-project)');
        }

        console.log('');

        // ── Step 7: Health Check ──
        console.log('  ── Health Check ──');
        try {
          const report = svc.getDoctorReport();
          for (const check of report.checks) {
            if (check.status === 'pass') {
              log.success(check.name);
            } else if (check.status === 'warn') {
              log.warn(`${check.name}: ${check.message}`);
            } else {
              log.error(`${check.name}: ${check.message}`);
            }
          }
          const projectCount = report.projects.length;
          if (projectCount > 0) {
            log.success(`${projectCount} project(s) registered`);
          }
        } catch {
          log.dim('  Could not run health check');
        }

        svc.close();

        console.log('');
        log.success('Nexus initialized successfully!');
        console.log('');
        log.warn(
          'Back up ~/.nexus/config.json — it contains your encryption key.',
        );
        if (!opts.skipHooks) {
          log.info('Restart Claude Code to activate MCP server + hooks.');
        }
      } finally {
        closePrompt();
      }
    });
}
