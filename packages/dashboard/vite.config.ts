import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const isTauri = !!process.env['TAURI_ENV_TARGET_TRIPLE'];

export default defineConfig({
  plugins: [react()],

  // Expose TAURI_ env vars to the frontend
  envPrefix: ['VITE_', 'TAURI_'],

  server: {
    port: 5173,
    // Prevent Vite from picking a random port — Tauri's devUrl must match exactly
    strictPort: true,
    // Keep terminal output readable in Tauri dev mode
    clearScreen: false,
    proxy: {
      '/api': 'http://localhost:47340',
      '/health': 'http://localhost:47340',
    },
  },

  build: {
    outDir: 'dist',
    sourcemap: !isTauri,
    // Tauri targets modern Chromium — no need for legacy transforms
    target: isTauri ? ['es2021', 'chrome105', 'safari13'] : 'modules',
  },
});
