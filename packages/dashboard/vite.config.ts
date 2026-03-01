import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:47340',
      '/health': 'http://localhost:47340',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
