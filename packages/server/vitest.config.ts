import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Most tests here cover pure logic or mock db/connection. Where the
    // correctness lives in SQL, `*.pglite.test.ts` runs against an
    // in-process Postgres (src/test/pgliteDb.ts) — still no server in CI.
    environment: 'node',
  },
});
