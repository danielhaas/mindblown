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
    // Auf allen Schnittstellen lauschen statt nur auf localhost: claudia wird
    // über Tailscale von anderen Rechnern aus benutzt, und der Default bindet
    // nur [::1] — von dort ist die Oberfläche sonst nicht erreichbar.
    host: true,
  },
});
