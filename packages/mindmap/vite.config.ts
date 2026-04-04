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
    port: 3000,
    open: true,
  },
});
