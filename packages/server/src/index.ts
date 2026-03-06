import { serve } from '@hono/node-server';
import { app } from './app.js';
import { isInitialized } from '@nexus/core';

const DEFAULT_PORT = 47340; // "NEXUS" on numpad

export interface ServerOptions {
  port?: number;
  bindAddress?: string;
}

export function startServer(options: ServerOptions | number = DEFAULT_PORT): void {
  const port = typeof options === 'number' ? options : (options.port ?? DEFAULT_PORT);
  const bindAddress = typeof options === 'number' ? '127.0.0.1' : (options.bindAddress ?? '127.0.0.1');

  if (!isInitialized()) {
    console.error('[nexus-server] Nexus is not initialized. Run `nexus init` first.');
    process.exit(1);
  }

  const server = serve({ fetch: app.fetch, port, hostname: bindAddress }, (info) => {
    console.log(`[nexus-server] Listening on http://${bindAddress}:${info.port}`);
    console.log(`[nexus-server] Dashboard: http://localhost:${info.port}/`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[nexus-server] Port ${port} is already in use.`);
      console.error(`  If Nexus is already running, open http://localhost:${port}`);
      console.error(`  To use a different port: nexus serve --port <port>`);
      process.exit(1);
    }
    throw err;
  });
}

export { app };

// Auto-start when run directly or compiled with pkg
// When imported by the CLI, the CLI calls startServer() explicitly
const isPkg = typeof (process as any).pkg !== 'undefined';
const argv1 = process.argv[1]?.replace(/\\/g, '/') ?? '';
const isMain = isPkg || argv1.includes('packages/server') || argv1.includes('nexus-server');

if (isMain) {
  const args = process.argv.slice(2);
  let port = DEFAULT_PORT;
  let bindAddress = '127.0.0.1';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      const parsed = parseInt(args[++i]!, 10);
      if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
        console.error(`[nexus-server] Invalid port: ${args[i]}`);
        process.exit(1);
      }
      port = parsed;
    }
    if (args[i] === '--bind' && args[i + 1]) bindAddress = args[++i]!;
  }
  startServer({ port, bindAddress });
}
