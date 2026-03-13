import { createInterface, type Interface } from 'node:readline';

let rl: Interface | null = null;

function getRL(): Interface {
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
  }
  return rl;
}

export function prompt(question: string): Promise<string> {
  return new Promise((resolve) => getRL().question(question, resolve));
}

export async function promptWithDefault(question: string, defaultVal: string): Promise<string> {
  const answer = await prompt(`${question} [${defaultVal}]: `);
  return answer.trim() || defaultVal;
}

export async function promptYesNo(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = await prompt(`${question} [${hint}]: `);
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === '') return defaultYes;
  return trimmed === 'y' || trimmed === 'yes';
}

export async function promptSelect(question: string, options: string[]): Promise<string> {
  console.log(question);
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${i + 1}. ${options[i]}`);
  }
  const answer = await prompt(`Choice [1]: `);
  const idx = parseInt(answer.trim(), 10);
  if (isNaN(idx) || idx < 1 || idx > options.length) {
    return options[0]!;
  }
  return options[idx - 1]!;
}

export function closePrompt(): void {
  if (rl) {
    rl.close();
    rl = null;
  }
}
