import { serve } from '@hono/node-server';
import { app } from './app.js';
import { isInitialized } from '@nexus/core';

const DEFAULT_PORT = 47340; // "NEXUS" on numpad

export function startServer(port = DEFAULT_PORT): void {
  if (!isInitialized()) {
    console.error('[nexus-server] Nexus is not initialized. Run `nexus init` first.');
    process.exit(1);
  }

  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[nexus-server] Listening on http://localhost:${info.port}`);
    console.log(`[nexus-server] Dashboard: http://localhost:${info.port}/`);
  });
}

export { app };

// Auto-start when run directly: node dist/index.js
startServer();
