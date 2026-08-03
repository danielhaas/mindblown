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
    // API und WebSocket über den Dev-Server proxien, damit die Oberfläche
    // gleiche Herkunft hat wie ihre Datenquelle. Sonst lädt der Browser die
    // Seite von claudia, ruft die API aber auf SEINEM eigenen localhost:3001 —
    // und selbst mit korrigierter Adresse müsste die Herkunft in der
    // CORS-Allowlist des Servers stehen. Mit Proxy entfällt beides.
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
});
