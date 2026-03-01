import { Command } from 'commander';
import { log } from '../lib/output.js';
import { isInitialized } from '@nexus/core';

export function serveCommand(): Command {
  return new Command('serve')
    .description('Start the Nexus dashboard server (http://localhost:47340)')
    .option('-p, --port <port>', 'Port to listen on', '47340')
    .action(async (opts: { port: string }) => {
      if (!isInitialized()) {
        log.error('Nexus is not initialized. Run `nexus init` first.');
        process.exit(1);
      }

      const port = parseInt(opts.port, 10);
      log.info(`Starting Nexus server on port ${port}...`);

      // Lazy import to avoid loading Hono until needed
      const { startServer } = await import('@nexus/server');
      startServer(port);

      log.success(`Dashboard available at http://localhost:${port}`);
    });
}
