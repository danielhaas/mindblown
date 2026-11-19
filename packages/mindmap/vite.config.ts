import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@mindblown/core': path.resolve(__dirname, '../core/src'),
    },
  },
  server: {
    port: 5180,
    open: true,
    // Listen on all interfaces, not just localhost: claudia is used from
    // other machines over Tailscale, and the default binds only [::1] — the
    // UI is unreachable from there otherwise.
    host: true,
    // Proxy API and WebSocket through the dev server so the UI shares an
    // origin with its data source. Otherwise the browser loads the page from
    // claudia but calls the API on ITS OWN localhost:3001 — and even with a
    // corrected address the origin would have to be in the server's CORS
    // allowlist. The proxy removes both problems.
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
});
