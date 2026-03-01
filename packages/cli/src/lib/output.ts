import chalk from 'chalk';

export const log = {
  success: (msg: string) => console.log(chalk.green('✓') + ' ' + msg),
  error: (msg: string) => console.error(chalk.red('✗') + ' ' + msg),
  warn: (msg: string) => console.warn(chalk.yellow('⚠') + ' ' + msg),
  info: (msg: string) => console.log(chalk.blue('→') + ' ' + msg),
  dim: (msg: string) => console.log(chalk.dim(msg)),
  plain: (msg: string) => console.log(msg),
};
