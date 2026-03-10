import fs from 'node:fs';
import path from 'node:path';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OverheadItem {
  category: string;
  file: string;
  lines: number;
  words: number;
  estimatedTokens: number;
  summary?: string;
}

export interface ProjectOverhead {
  project: string;
  cwd: string;
  items: OverheadItem[];
  totalTokens: number;
  nexusSectionTokens: number;
  nexusSectionPct: number;
  totalSessionLoad: number; // global + this project
}

export interface HookDetail {
  event: string;
  type: 'command' | 'prompt';
  description: string;
  words: number;
  estimatedTokens: number;
}

export interface SkillDetail {
  name: string;
  hasSkillMd: boolean;
  words: number;
  estimatedTokens: number;
}

export interface OptimizationSuggestion {
  severity: 'high' | 'medium' | 'low';
  category: string;
  title: string;
  description: string;
  currentTokens: number;
  potentialSavings: number;
  target?: string;
}

export interface ContextOverhead {
  globalRules: OverheadItem[];
  globalRulesTotal: number;
  skills: SkillDetail[];
  skillsCount: number;
  skillsEstTokens: number;
  hooks: HookDetail[];
  hookPromptsTotal: number;
  hookCommandsCount: number;
  projects: ProjectOverhead[];
  grandTotal: number;
  suggestions: OptimizationSuggestion[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

function wordsToTokens(words: number): number {
  // ~1.33 tokens per word is a good estimate for markdown/code content
  return Math.round(words / 0.75);
}

function readFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function scanMdFiles(dir: string, category: string): OverheadItem[] {
  const items: OverheadItem[] = [];
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const content = readFile(fullPath);
      if (!content) continue;
      const lines = content.split('\n').length;
      const words = countWords(content);
      // Generate a 1-line summary from the first heading or first line
      const firstHeading = content.match(/^#\s+(.+)/m);
      const summary = firstHeading?.[1] ?? content.split('\n')[0]?.slice(0, 80) ?? '';
      items.push({
        category,
        file,
        lines,
        words,
        estimatedTokens: wordsToTokens(words),
        summary,
      });
    }
  } catch {
    // Directory doesn't exist
  }
  return items;
}

// ─── Nexus section analysis ─────────────────────────────────────────────────

function analyzeNexusSection(content: string): { nexusWords: number; totalWords: number } {
  const totalWords = countWords(content);
  const nexusStart = content.indexOf('<!-- nexus:start -->');
  const nexusEnd = content.indexOf('<!-- nexus:end -->');
  if (nexusStart === -1 || nexusEnd === -1) return { nexusWords: 0, totalWords };
  const nexusContent = content.slice(nexusStart, nexusEnd + '<!-- nexus:end -->'.length);
  return { nexusWords: countWords(nexusContent), totalWords };
}

// ─── Hook scanner ────────────────────────────────────────────────────────────

interface HookEntry {
  type: string;
  command?: string;
  prompt?: string;
}

function scanHooks(claudeDir: string): { hooks: HookDetail[]; promptsTotal: number; commandsCount: number } {
  const hooks: HookDetail[] = [];
  const settingsPath = path.join(claudeDir, 'settings.json');
  let promptsTotal = 0;
  let commandsCount = 0;

  try {
    const raw = readFile(settingsPath);
    if (!raw) return { hooks, promptsTotal, commandsCount };
    const settings = JSON.parse(raw) as Record<string, unknown>;
    const hooksObj = settings['hooks'] as Record<string, HookEntry[]> | undefined;
    if (!hooksObj) return { hooks, promptsTotal, commandsCount };

    for (const [event, hookList] of Object.entries(hooksObj)) {
      if (!Array.isArray(hookList)) continue;
      for (const hook of hookList) {
        if (hook.type === 'prompt' && hook.prompt) {
          const words = countWords(hook.prompt);
          const tokens = wordsToTokens(words);
          promptsTotal += tokens;
          hooks.push({
            event,
            type: 'prompt',
            description: hook.prompt.slice(0, 80).replace(/\n/g, ' '),
            words,
            estimatedTokens: tokens,
          });
        } else if (hook.type === 'command' && hook.command) {
          commandsCount++;
          const cmdName = hook.command.split(/\s+/).slice(0, 3).join(' ');
          hooks.push({
            event,
            type: 'command',
            description: cmdName,
            words: 0,
            estimatedTokens: 0,
          });
        }
      }
    }
  } catch {
    // Parse error
  }

  return { hooks, promptsTotal, commandsCount };
}

// ─── Skills scanner ──────────────────────────────────────────────────────────

function scanSkills(claudeDir: string): SkillDetail[] {
  const skillsDir = path.join(claudeDir, 'skills');
  const results: SkillDetail[] = [];

  try {
    const entries = fs.readdirSync(skillsDir).filter((entry) => {
      const fullPath = path.join(skillsDir, entry);
      return fs.statSync(fullPath).isDirectory();
    });

    for (const name of entries) {
      const skillMdPath = path.join(skillsDir, name, 'SKILL.md');
      const content = readFile(skillMdPath);
      const words = content ? countWords(content) : 0;
      results.push({
        name,
        hasSkillMd: content.length > 0,
        words,
        estimatedTokens: wordsToTokens(words),
      });
    }
  } catch {
    // No skills dir
  }

  return results.sort((a, b) => b.estimatedTokens - a.estimatedTokens);
}

// ─── Project overhead scanner ────────────────────────────────────────────────

function scanProjectOverhead(claudeDir: string, globalTotal: number): ProjectOverhead[] {
  const projectsDir = path.join(claudeDir, 'projects');
  const results: ProjectOverhead[] = [];

  try {
    const projectDirs = fs.readdirSync(projectsDir).filter((entry) => {
      const fullPath = path.join(projectsDir, entry);
      return fs.statSync(fullPath).isDirectory();
    });

    for (const projDir of projectDirs) {
      const items: OverheadItem[] = [];

      // Decode project path from dir name
      const decodedPath = projDir.replace(/--/g, ':\\').replace(/-/g, path.sep);
      const projectName = decodedPath.split(/[/\\]/).pop() ?? projDir;

      let nexusSectionTokens = 0;
      let claudeMdTotalWords = 0;

      // CLAUDE.md in the actual project directory
      const claudeMdPath = path.join(decodedPath, 'CLAUDE.md');
      const claudeMdContent = readFile(claudeMdPath);
      if (claudeMdContent) {
        const lines = claudeMdContent.split('\n').length;
        const words = countWords(claudeMdContent);
        claudeMdTotalWords = words;
        const nexus = analyzeNexusSection(claudeMdContent);
        nexusSectionTokens = wordsToTokens(nexus.nexusWords);
        const manualWords = words - nexus.nexusWords;

        if (nexus.nexusWords > 0) {
          items.push({
            category: 'CLAUDE.md (manual)',
            file: 'CLAUDE.md',
            lines,
            words: manualWords,
            estimatedTokens: wordsToTokens(manualWords),
            summary: `Manual project instructions`,
          });
          items.push({
            category: 'CLAUDE.md (nexus auto-gen)',
            file: 'CLAUDE.md [nexus:start...end]',
            lines: 0,
            words: nexus.nexusWords,
            estimatedTokens: nexusSectionTokens,
            summary: `Auto-synced Nexus intelligence section`,
          });
        } else {
          items.push({
            category: 'CLAUDE.md',
            file: 'CLAUDE.md',
            lines,
            words,
            estimatedTokens: wordsToTokens(words),
          });
        }
      }

      // MEMORY.md
      const memoryPath = path.join(projectsDir, projDir, 'memory', 'MEMORY.md');
      const memoryContent = readFile(memoryPath);
      if (memoryContent) {
        const words = countWords(memoryContent);
        items.push({
          category: 'MEMORY.md',
          file: 'MEMORY.md',
          lines: memoryContent.split('\n').length,
          words,
          estimatedTokens: wordsToTokens(words),
        });
      }

      // Project-level .claude/rules/*.md
      const projRulesDir = path.join(decodedPath, '.claude', 'rules');
      items.push(...scanMdFiles(projRulesDir, 'Project Rules'));

      if (items.length > 0) {
        const totalTokens = items.reduce((s, i) => s + i.estimatedTokens, 0);
        const nexusPct = claudeMdTotalWords > 0
          ? Math.round((nexusSectionTokens / wordsToTokens(claudeMdTotalWords)) * 100)
          : 0;
        results.push({
          project: projectName,
          cwd: decodedPath,
          items,
          totalTokens,
          nexusSectionTokens,
          nexusSectionPct: nexusPct,
          totalSessionLoad: globalTotal + totalTokens,
        });
      }
    }
  } catch {
    // Projects dir doesn't exist
  }

  return results.sort((a, b) => b.totalTokens - a.totalTokens);
}

// ─── Optimization suggestions ────────────────────────────────────────────────

function generateSuggestions(
  projects: ProjectOverhead[],
  globalRules: OverheadItem[],
  skills: SkillDetail[],
): OptimizationSuggestion[] {
  const suggestions: OptimizationSuggestion[] = [];

  // 1. Large nexus sections
  for (const proj of projects) {
    if (proj.nexusSectionTokens > 3000) {
      suggestions.push({
        severity: 'high',
        category: 'Nexus Auto-Gen',
        title: `${proj.project}: Nexus section is ${proj.nexusSectionPct}% of CLAUDE.md`,
        description: `The auto-synced Nexus Intelligence section has grown to ~${proj.nexusSectionTokens} tokens. Consider archiving older cross-project contexts and keeping only the 5 most relevant. Use nexus_query for on-demand lookups instead.`,
        currentTokens: proj.nexusSectionTokens,
        potentialSavings: Math.round(proj.nexusSectionTokens * 0.6),
        target: proj.cwd,
      });
    }
  }

  // 2. Large CLAUDE.md files (total)
  for (const proj of projects) {
    const claudeMd = proj.items.filter((i) => i.category.startsWith('CLAUDE.md'));
    const claudeTotal = claudeMd.reduce((s, i) => s + i.estimatedTokens, 0);
    if (claudeTotal > 5000 && proj.nexusSectionPct < 50) {
      suggestions.push({
        severity: 'medium',
        category: 'CLAUDE.md Size',
        title: `${proj.project}: CLAUDE.md is ~${claudeTotal} tokens`,
        description: `The manual portion of CLAUDE.md is large. Review for outdated instructions, verbose examples, or sections that could be moved to project rules files.`,
        currentTokens: claudeTotal,
        potentialSavings: Math.round(claudeTotal * 0.3),
        target: proj.cwd,
      });
    }
  }

  // 3. Large MEMORY.md files
  for (const proj of projects) {
    const memory = proj.items.find((i) => i.category === 'MEMORY.md');
    if (memory && memory.estimatedTokens > 2000) {
      suggestions.push({
        severity: 'medium',
        category: 'MEMORY.md Growth',
        title: `${proj.project}: MEMORY.md is ~${memory.estimatedTokens} tokens`,
        description: `Session memory has grown large. Split into active (recent, <1000 words) and archive (historical, loaded on-demand). Remove outdated entries.`,
        currentTokens: memory.estimatedTokens,
        potentialSavings: Math.round(memory.estimatedTokens * 0.5),
        target: proj.cwd,
      });
    }
  }

  // 4. Heavy session load projects
  for (const proj of projects) {
    if (proj.totalSessionLoad > 10000) {
      suggestions.push({
        severity: proj.totalSessionLoad > 15000 ? 'high' : 'medium',
        category: 'Session Load',
        title: `${proj.project}: ~${proj.totalSessionLoad} tokens per session`,
        description: `Total context loaded when working in this project (global + project-specific). Every message carries this overhead. Target <8,000 for optimal efficiency.`,
        currentTokens: proj.totalSessionLoad,
        potentialSavings: Math.max(0, proj.totalSessionLoad - 8000),
        target: proj.cwd,
      });
    }
  }

  // 5. Large skills
  for (const skill of skills) {
    if (skill.estimatedTokens > 4000) {
      suggestions.push({
        severity: 'low',
        category: 'Skill Size',
        title: `Skill "${skill.name}" is ~${skill.estimatedTokens} tokens`,
        description: `This skill's SKILL.md is large. When invoked, it consumes significant context. Consider trimming verbose examples or splitting into sub-skills.`,
        currentTokens: skill.estimatedTokens,
        potentialSavings: Math.round(skill.estimatedTokens * 0.3),
        target: skill.name,
      });
    }
  }

  // 6. Global rules that could be trimmed
  for (const rule of globalRules) {
    if (rule.estimatedTokens > 250) {
      suggestions.push({
        severity: 'low',
        category: 'Global Rules',
        title: `${rule.file}: ~${rule.estimatedTokens} tokens`,
        description: `This global rules file is loaded in every conversation across all projects. Review for content Claude already knows or verbose examples that could be compressed.`,
        currentTokens: rule.estimatedTokens,
        potentialSavings: Math.round(rule.estimatedTokens * 0.2),
        target: rule.file,
      });
    }
  }

  // Sort by potential savings descending
  return suggestions.sort((a, b) => b.potentialSavings - a.potentialSavings);
}

// ─── Main ────────────────────────────────────────────────────────────────────

export function computeContextOverhead(claudeDir: string): ContextOverhead {
  const rulesDir = path.join(claudeDir, 'rules');
  const globalRules = scanMdFiles(rulesDir, 'Global Rules');
  const globalRulesTotal = globalRules.reduce((s, i) => s + i.estimatedTokens, 0);

  const skills = scanSkills(claudeDir);
  const skillsCount = skills.length;
  // Skill names + descriptions in system prompt: ~100 tokens per skill
  const skillsEstTokens = skillsCount * 100;

  const { hooks, promptsTotal, commandsCount } = scanHooks(claudeDir);

  const globalTotal = globalRulesTotal + skillsEstTokens + promptsTotal;

  const projects = scanProjectOverhead(claudeDir, globalTotal);

  const projectsTotal = projects.reduce((s, p) => s + p.totalTokens, 0);
  const grandTotal = globalTotal + projectsTotal;

  const suggestions = generateSuggestions(projects, globalRules, skills);

  return {
    globalRules,
    globalRulesTotal,
    skills,
    skillsCount,
    skillsEstTokens,
    hooks,
    hookPromptsTotal: promptsTotal,
    hookCommandsCount: commandsCount,
    projects,
    grandTotal,
    suggestions,
  };
}
