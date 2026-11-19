import { defineConfig } from '@playwright/test';

/**
 * Browser checks against the e2e harness page (e2e/harness.tsx) on the
 * Vite dev server — no API server: each spec answers /api itself.
 * `pnpm --filter @mindblown/mindmap e2e`
 */
const PORT = Number(process.env.E2E_PORT ?? 5199);

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.e2e.ts',
  timeout: 30_000,
  use: { baseURL: `http://localhost:${PORT}` },
  webServer: {
    command: `vite --port ${PORT} --strictPort --open false`,
    url: `http://localhost:${PORT}/e2e/harness.html`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
